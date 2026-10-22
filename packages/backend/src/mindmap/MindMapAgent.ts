import { z } from "zod";
import {
  GraphOperationInputSchema,
  graphReadView,
  parseGraphOperations,
  type MindMapNode,
  type TranscriptSegment,
} from "@rcc/shared";
import type { AppBus } from "../bus/eventBus.js";
import type { BackendConfig } from "../config/env.js";
import { mindmapSystemPrompt, mindmapUserPrompt } from "../prompts/mindmap.js";
import { log, metric } from "../observability/log.js";
import type { GraphStore } from "../graph/GraphStore.js";
import type { LLMProvider } from "../llm/LLMProvider.js";

/**
 * MindMap intelligence: buffer, trigger, single-flight, validate, apply.
 *
 * Triggers on `minSegments` finals or `maxIntervalMs` of wall time, whichever comes first (§22).
 * Only one request may be in flight (§23): a trigger that arrives while busy is folded into the
 * buffer and reported as `mindmap.skipped` instead of queueing a second call, so the graph never
 * sees two writers and the token bill never doubles.
 */

/**
 * Same schema the graph engine applies per operation. Validating it here too is what makes §45's
 * bounded repair loop reachable: a shape error then costs the model one retry with the Zod issue
 * appended, instead of being silently dropped at the reducer and never noticed.
 */
const OperationsSchema = z.object({ operations: z.array(GraphOperationInputSchema) });

/**
 * How many requests one `flush()` may chain. Nothing appends to the buffer while a session is being
 * torn down, so the drain normally ends after one or two rounds; the cap is what keeps a client that
 * keeps talking while forcing updates from hanging the `mindmap.forceUpdate` request.
 */
const MAX_DRAIN_ROUNDS = 32;

export class MindMapAgent {
  private buffer: TranscriptSegment[] = [];
  private inFlight = false;
  /**
   * The most recently self-triggered request. `flush()` waits on this field rather than treating a
   * busy agent as "nothing to do" — see the drain below. Only `beginFlush` writes it, so a manual
   * flush awaited by `flush()` can never make the loop wait on itself.
   */
  private busy: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private lastFlushAt = 0;
  private unsubscribe: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly bus: AppBus,
    private readonly graph: GraphStore,
    private readonly llm: LLMProvider,
    private readonly config: BackendConfig,
    private readonly sessionId: string,
  ) {}

  start(): void {
    this.closed = false;
    this.unsubscribe?.();
    this.unsubscribe = this.bus.on("mindmap", "transcript.final", (segment) => {
      this.consider(segment);
    });
  }

  /**
   * Unlike the other self-triggering modules, this one keeps a request in flight across a `stop()`,
   * so `closed` has to be re-checked where the response lands — writing there would add nodes to a
   * map whose session is already `completed`, and re-arming the timer would restart the flush cycle.
   */
  stop(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.buffer = [];
  }

  /**
   * Exposed for the debug panel and tests: force a flush now.
   *
   * A request already in flight is not a reason to do nothing, which is what this used to be. The
   * tail of a talk rarely reaches `minSegments`, so the last few finals sit in the buffer waiting
   * for the interval timer — and `RecordingController` calls this before `stop()`, which clears the
   * buffer. Returning early therefore lost the closing remarks, usually the conclusions.
   */
  async flush(): Promise<void> {
    for (let round = 0; round < MAX_DRAIN_ROUNDS && !this.closed; round++) {
      await this.busy;
      if (this.buffer.length === 0) break;
      await this.runFlush("manual");
    }
    // A response can re-trigger a batch of its own; the session must not be closed underneath it.
    await this.busy;
  }

  get pendingCount(): number {
    return this.buffer.length;
  }

  get isBusy(): boolean {
    return this.inFlight;
  }

  private consider(segment: TranscriptSegment): void {
    if (segment.sessionId !== this.sessionId) return;
    this.buffer.push(segment);
    if (this.buffer.length >= this.config.mindmap.minSegments) {
      this.beginFlush("batch");
      return;
    }
    this.armTimer();
  }

  private armTimer(): void {
    if (this.timer) return;
    const elapsed = Date.now() - (this.lastFlushAt || Date.now());
    const remaining = Math.max(10, this.config.mindmap.maxIntervalMs - elapsed);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.beginFlush("interval");
    }, remaining);
    this.timer.unref();
  }

  /**
   * Self-triggers are fire-and-forget but must stay observable to `flush()`, which waits on `busy`.
   * Only a trigger that actually starts a request may take the field over: a no-op — one that finds
   * a request already in flight, so `runFlush` reports `mindmap.skipped` and returns — would make
   * the drain believe the chain had finished, which loses the tail all over again.
   */
  private beginFlush(reason: "batch" | "interval"): void {
    const takesOver = !this.inFlight && this.buffer.length > 0;
    // Swallowed only so an un-awaited chain cannot become an unhandled rejection; `runFlush` reports
    // its own failures on `module.error`.
    const chain = this.runFlush(reason).catch(() => undefined);
    if (takesOver) this.busy = chain;
  }

  private async runFlush(reason: "batch" | "interval" | "manual"): Promise<void> {
    if (this.closed) return;
    if (this.inFlight) {
      this.bus.emit("mindmap.skipped", { sessionId: this.sessionId, bufferedSegmentCount: this.buffer.length });
      return;
    }
    if (this.buffer.length === 0 && reason !== "manual") return;

    const batch = this.buffer;
    this.buffer = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.inFlight = true;
    const startedAt = Date.now();
    this.lastFlushAt = startedAt;

    this.bus.emit("mindmap.update.requested", {
      sessionId: this.sessionId,
      segmentIds: batch.map((segment) => segment.id),
      reason,
    });

    try {
      const relevantNodes = capNodes(this.graph.snapshot().nodes);
      const request = {
        task: "mindmap" as const,
        system: mindmapSystemPrompt(),
        user: mindmapUserPrompt({
          relevantNodes,
          batch,
          themeSummary: summarizeTheme(relevantNodes),
        }),
        sourceSegmentIds: batch.map((segment) => segment.id),
      };

      const result = await this.llm.structuredGenerate(request, OperationsSchema);
      if (this.closed) return;
      const parsed = parseGraphOperations(result.data, graphReadView(this.graph.graphState), {
        responseId: result.responseId,
        now: Date.now(),
      });

      if (parsed.rejected.length > 0) {
        // §45: an illegal operation is discarded and logged, never fatal.
        log.warn("graph operations rejected", {
          sessionId: this.sessionId,
          responseId: result.responseId,
          rejected: parsed.rejected,
        });
      }

      const applied = this.graph.applyOps(parsed.accepted, result.responseId);
      const durationMs = Date.now() - startedAt;
      this.bus.emit("mindmap.updated", {
        sessionId: this.sessionId,
        responseId: result.responseId,
        operations: parsed.accepted,
        touchedNodeIds: applied.touched,
        durationMs,
      });
      metric("mindmap_update", {
        reason,
        segments: batch.length,
        accepted: parsed.accepted.length,
        rejected: parsed.rejected.length,
        skipped: applied.skipped.length,
        latencyMs: durationMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        provider: this.llm.name,
      });
    } catch (error) {
      // Failure isolates to MindMap: the segments are dropped (the next window still covers them),
      // but recording, subtitles and QA are untouched.
      if (!this.closed) {
        this.bus.emit("module.error", {
          module: "mindmap",
          code: "update_failed",
          message: error instanceof Error ? error.message : String(error),
          at: Date.now(),
          recoverable: true,
        });
        metric("mindmap_update", { reason, ok: false, latencyMs: Date.now() - startedAt });
      }
    } finally {
      this.inFlight = false;
      if (!this.closed) {
        if (this.buffer.length >= this.config.mindmap.minSegments) this.beginFlush("batch");
        else this.armTimer();
      }
    }
  }
}

/** The prompt sees a bounded neighbourhood, never the whole transcript (§21). */
function capNodes(nodes: MindMapNode[]): MindMapNode[] {
  return nodes.slice(-40);
}

function summarizeTheme(nodes: MindMapNode[]): string | undefined {
  if (nodes.length === 0) return undefined;
  return nodes
    .filter((node) => !node.parentId)
    .map((node) => node.title)
    .join("、");
}
