import type { AppBus } from "../bus/eventBus.js";
import type { TranscriptSegment } from "@rcc/shared";
import type { BackendConfig } from "../config/env.js";
import type { LLMProvider, LLMRequest } from "../llm/LLMProvider.js";
import { qaSystemPrompt, qaUserPrompt } from "../prompts/qa.js";
import { log, metric } from "../observability/log.js";
import type { QaRecorder } from "../store/qaRepository.js";
import type { TranscriptCore } from "../transcript/TranscriptCore.js";
import type { GraphStore } from "../graph/GraphStore.js";
import { buildContextSnapshot } from "./contextSnapshot.js";
import { extractCitations } from "./citations.js";

/**
 * Question answering: freeze the context, stream the answer, cite what was actually given.
 *
 * Asking never touches the recording path (§27) — this class only reads, and a failed answer becomes
 * a `degraded` completion plus a `module.error`, never an exception that reaches the caller. §3's
 * "AI 请求不得堆积" is enforced by two gates ahead of any work: the concurrency cap bounds how many
 * answers exist at once, and the minimum interval bounds how fast a client can start them. Both
 * refuse with `answer.rejected` addressed to the question, because a client that is left waiting for
 * an answer that will never come is a second bug. §23's single-flight is for the self-triggering
 * MindMap, not for QA.
 */

const MAX_CONCURRENT_ANSWERS = 2;

type Refusal = { reason: "busy" | "rate_limited"; retryAfterMs: number };

export class QaCore {
  private inFlight = 0;
  /** Admission clock: when the last *accepted* question started, not when the last answer finished. */
  private lastAcceptedAt = 0;
  private closed = false;
  private readonly pending = new Set<string>();

  get pendingQuestionIds(): string[] { return [...this.pending]; }

  constructor(
    private readonly bus: AppBus,
    private readonly transcript: TranscriptCore,
    private readonly graph: GraphStore,
    private readonly llm: LLMProvider,
    private readonly config: BackendConfig,
    private readonly sessionId: string,
    /** §40 history. Required, because a QA module that answers but records nothing is OPEN-4 again. */
    private readonly recorder: QaRecorder,
    /** Long-context overview (§29). Supplied by Memory when it is running; empty means none yet. */
    private readonly globalSummary: () => string = () => "",
    /** Index lookup (§30). Supplied by Retrieval; the answer falls back to Hot Context alone without it. */
    private readonly search: (
      question: string,
      excludeIds: ReadonlySet<string>,
    ) => Promise<TranscriptSegment[]> = async () => [],
  ) {}

  close(): void {
    this.closed = true;
  }

  async ask(questionId: string, question: string): Promise<void> {
    if (this.closed) return;
    const now = Date.now();
    const refusal = this.admit(now);
    if (refusal) {
      this.refuse(questionId, refusal);
      return;
    }
    this.lastAcceptedAt = now;
    this.inFlight += 1;
    this.pending.add(questionId);
    const startedAt = now;
    const hotContext = this.transcript.window(this.sessionId, this.config.hotContextSec);
    // Test D is the reason this happens before the snapshot: Hot Context only reaches back a few
    // minutes, so anything older has to come out of the index. Lines already in the window are
    // excluded so one sentence cannot appear twice in the frozen context.
    // `.catch` keeps retrieval off the answer's critical path — and keeps `inFlight` balanced, so a
    // failing index can never wedge QA into refusing every question as `busy`.
    const relevantTranscripts = await this.search(
      question,
      new Set(hotContext.map((segment) => segment.id)),
    ).catch(() => [] as TranscriptSegment[]);
    // The index is the first thing QA awaits, so it is where a session that ended mid-question shows
    // up. Nothing below may start for a disposed session: `answer.started` would be a promise of text
    // nobody is left to receive, and the model call behind it is the pile-up §56 forbids. `inFlight`
    // is released here for the same reason it is in the `finally` — the counter is what the concurrency
    // gate reads, and a leak would have the next session's questions refused as `busy`.
    if (this.closed) {
      this.inFlight -= 1;
      this.pending.delete(questionId);
      return;
    }
    const snapshot = buildContextSnapshot({
      question,
      hotContext,
      relevantTranscripts,
      nodes: this.graph.snapshot().nodes,
      globalSummary: this.globalSummary(),
    });

    // Recorded before the event goes out, so any subscriber that reads history sees the row.
    this.record("question", () =>
      this.recorder.recordQuestion({
        id: questionId,
        sessionId: this.sessionId,
        text: question,
        createdAt: startedAt,
        snapshotId: snapshot.id,
      }),
    );
    this.bus.emit("question.created", {
      sessionId: this.sessionId,
      questionId,
      text: question,
      createdAt: startedAt,
    });
    this.bus.emit("answer.started", {
      sessionId: this.sessionId,
      questionId,
      snapshotId: snapshot.id,
      startedAt,
    });

    const request: LLMRequest = {
      task: "qa",
      system: qaSystemPrompt(),
      user: qaUserPrompt(snapshot),
      sourceSegmentIds: [...snapshot.hotContext, ...snapshot.relevantTranscripts].map((segment) => segment.id),
    };

    let text = "";
    let ttftMs: number | undefined;
    try {
      for await (const chunk of this.llm.stream(request)) {
        if (this.closed) break;
        text = chunk;
        if (ttftMs === undefined) ttftMs = Date.now() - startedAt;
        this.bus.emit("answer.token", { sessionId: this.sessionId, questionId, text, ...(ttftMs === undefined ? {} : { ttftMs }) });
      }

      const finishedAt = Date.now();
      const durationMs = finishedAt - startedAt;
      const citations = extractCitations(text, [...snapshot.hotContext, ...snapshot.relevantTranscripts]);
      // History is recorded even if the session ended while the model was talking — the row is durable
      // evidence of what was answered, not a message to a client that has already left.
      this.record("answer", () =>
        this.recorder.recordAnswer({
          questionId,
          sessionId: this.sessionId,
          text,
          citations,
          durationMs,
          degraded: false,
          createdAt: finishedAt,
        }),
      );
      if (!this.closed) {
        // A session that ended while the model was talking has nobody left to tell.
        this.bus.emit("answer.completed", {
          sessionId: this.sessionId,
          questionId,
          text,
          citations,
          durationMs,
          degraded: false,
        });
      }
      metric("qa_answer", {
        ok: true,
        provider: this.llm.name,
        latencyMs: durationMs,
        ...(ttftMs === undefined ? {} : { ttftMs }),
        contextLines: snapshot.hotContext.length + snapshot.relevantTranscripts.length,
        citations: citations.length,
      });
    } catch (error) {
      // Failure stays inside QA: subtitles, recording and the map are untouched (Test E).
      const message = error instanceof Error ? error.message : String(error);
      log.warn("qa answer failed", { sessionId: this.sessionId, questionId, message });
      // Same rule as the completion below: a session that ended while the model was talking has
      // nobody to tell. Reporting `answer_failed` to a live client is the point; broadcasting it into
      // a disposed one turns a cancelled recording into an error the next session shows in its panel.
      if (!this.closed) {
        this.bus.emit("module.error", {
          sessionId: this.sessionId,
          module: "qa",
          code: "answer_failed",
          message,
          at: Date.now(),
          recoverable: true,
        });
      }
      const finishedAt = Date.now();
      const durationMs = finishedAt - startedAt;
      this.record("answer", () =>
        this.recorder.recordAnswer({
          questionId,
          sessionId: this.sessionId,
          text,
          citations: [],
          durationMs,
          degraded: true,
          createdAt: finishedAt,
        }),
      );
      if (!this.closed) {
        this.bus.emit("answer.completed", {
          sessionId: this.sessionId,
          questionId,
          text,
          citations: [],
          durationMs,
          degraded: true,
        });
      }
      metric("qa_answer", { ok: false, provider: this.llm.name, latencyMs: durationMs });
    } finally {
      this.inFlight -= 1;
      this.pending.delete(questionId);
    }
  }

  /**
   * History is best effort: a storage failure is logged, never turned into a `degraded` answer,
   * because the text the user already watched stream in is not less true for the row being unwritten.
   * A `degraded` completion would also be a lie about the LLM, which answered fine.
   */
  private record(what: "question" | "answer", write: () => void): void {
    try {
      write();
    } catch (error) {
      log.error("qa history write failed", {
        sessionId: this.sessionId,
        what,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Both gates are O(1) and run before the snapshot is built, because the expensive half of a
   * question is the context assembly plus one query embedding — a refused question must cost that
   * nothing. `minIntervalMs = 0` leaves only the concurrency cap, which is what the unit tests use
   * to exercise one gate at a time.
   */
  private admit(now: number): Refusal | null {
    const waitMs = this.lastAcceptedAt + this.config.qa.minIntervalMs - now;
    if (this.inFlight >= MAX_CONCURRENT_ANSWERS) {
      // A busy slot has no predictable release time, so the interval remainder is all we can offer.
      return { reason: "busy", retryAfterMs: Math.max(0, Math.ceil(waitMs)) };
    }
    if (waitMs > 0) return { reason: "rate_limited", retryAfterMs: Math.ceil(waitMs) };
    return null;
  }

  /** A refusal is an answer about the question, not a module fault: no `module.error`, no retry loop. */
  private refuse(questionId: string, refusal: Refusal): void {
    const message =
      refusal.reason === "busy"
        ? `已有 ${this.inFlight} 个问题在回答中，请稍后再问`
        : `提问太密集，请 ${Math.max(1, Math.ceil(refusal.retryAfterMs / 1000))} 秒后再问`;
    this.bus.emit("answer.rejected", {
      sessionId: this.sessionId,
      questionId,
      reason: refusal.reason,
      message,
      retryAfterMs: refusal.retryAfterMs,
    });
    metric("qa_rejected", {
      provider: this.llm.name,
      reason: refusal.reason,
      inFlight: this.inFlight,
      retryAfterMs: refusal.retryAfterMs,
    });
  }
}
