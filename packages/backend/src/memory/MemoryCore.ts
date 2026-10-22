import { randomUUID } from "node:crypto";
import { z } from "zod";
import { formatClock } from "../prompts/format.js";
import type { SummaryBlock, TranscriptSegment } from "@rcc/shared";
import type { AppBus } from "../bus/eventBus.js";
import type { BackendConfig } from "../config/env.js";
import type { LLMProvider, LLMRequest } from "../llm/LLMProvider.js";
import { summarySystemPrompt, summaryUserPrompt, type SummaryPromptInput } from "../prompts/summary.js";
import { log, metric } from "../observability/log.js";
import type { SqliteSummaryRepository } from "../store/summaryRepository.js";

/**
 * Memory (§31): turn stretches of final transcript into append-only Summary Blocks, then fold those
 * blocks upward so a long talk stays answerable without sending its whole transcript to the model
 * (§29). Two rules shape the implementation:
 *
 * - Cadence is measured on the **speech** timeline, not the wall clock. Four minutes of silence is
 *   not four minutes of content, a pause must not summarise the same window twice, and a test must
 *   not wait in real time. Only `transcript.final` advances it — a partial can never trigger a
 *   summary, because partials are not knowledge.
 * - History is append-only. A stage block is never rewritten, and a merge block records the ids it
 *   consumed, so "what did the system believe at 40 minutes" stays answerable.
 */

const SummaryContentSchema = z.object({
  summary: z.string().min(1),
  keyPoints: z.array(z.string().min(1)).default([]),
  entities: z.array(z.string().min(1)).default([]),
});

/** How many blocks the QA context may see, so the overview cannot outgrow the transcript it guides. */
const MAX_OVERVIEW_BLOCKS = 4;

export class MemoryCore {
  private window: TranscriptSegment[] = [];
  /** Blocks awaiting a merge, per level. Committed blocks appear here until a parent absorbs them. */
  private pending: SummaryBlock[][] = [];
  private committed: SummaryBlock[] = [];
  private inFlight = false;
  /** The current flush chain, so `flushRemaining` cannot return before the tail block is written. */
  private running: Promise<void> = Promise.resolve();
  private closed = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly bus: AppBus,
    private readonly store: SqliteSummaryRepository,
    private readonly llm: LLMProvider,
    private readonly config: BackendConfig,
    private readonly sessionId: string,
  ) {}

  start(): void {
    // A restart must not forget what was already summarised, or the merge count starts from zero
    // and the same stretch gets a second, different summary.
    this.committed = this.store.list(this.sessionId);
    this.pending = this.unfoldedByLevel(this.committed);
    this.unsubscribe?.();
    this.unsubscribe = this.bus.on("memory", "transcript.final", (segment) => this.consider(segment));
  }

  stop(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.window = [];
  }

  get pendingCount(): number {
    return this.window.length;
  }

  get isBusy(): boolean {
    return this.inFlight;
  }

  get blockCount(): number {
    return this.committed.length;
  }

  /** Called when the recording ends: the tail is almost never a full window, and dropping it would
   *  lose the closing remarks — usually the part with the conclusions. */
  async flushRemaining(): Promise<void> {
    await this.running;
    if (this.window.length >= this.config.memory.minSegments) await this.flushWindow();
    await this.running;
  }

  /** `qa` asks for this through the Context Manager (§27); an empty string means "no overview yet". */
  globalSummary(): string {
    if (this.committed.length === 0) return "";
    const topLevel = this.committed.reduce((deepest, block) => Math.max(deepest, block.level), 0);
    const parts: string[] = [];
    if (topLevel > 0) {
      const top = [...this.committed].reverse().find((block) => block.level === topLevel);
      if (top) {
        parts.push(`【整体 ${formatClock(top.startTime)}-${formatClock(top.endTime)}】${top.summary}`);
        for (const block of this.committed.filter((entry) => entry.level === 0 && entry.startTime > top.endTime).slice(-MAX_OVERVIEW_BLOCKS)) {
          parts.push(`【${formatClock(block.startTime)}-${formatClock(block.endTime)}】${block.summary}`);
        }
        return parts.join("\n");
      }
    }
    for (const block of this.committed.slice(-MAX_OVERVIEW_BLOCKS)) {
      parts.push(`【${formatClock(block.startTime)}-${formatClock(block.endTime)}】${block.summary}`);
    }
    return parts.join("\n");
  }

  private consider(segment: TranscriptSegment): void {
    if (segment.sessionId !== this.sessionId) return;
    this.window.push(segment);
    if (this.isWindowDue()) this.trigger();
  }

  /**
   * Only a flush that actually starts may take `running` over. `flushWindow` also returns a resolved
   * no-op — when the model is busy, or when the window is empty — and storing *that* told
   * `flushRemaining` the chain had finished, so the tail window was cleared by `stop()` while its
   * summary was still being written. Same trap as `MindMapAgent.beginFlush`.
   */
  private trigger(): void {
    const takesOver = !this.inFlight && this.window.length > 0 && !this.closed;
    const chain = this.flushWindow();
    if (takesOver) this.running = chain;
  }

  /** The window is due once the speech it covers reaches the cadence — never on the wall clock. */
  private isWindowDue(): boolean {
    const first = this.window[0];
    const last = this.window.at(-1);
    if (!first || !last) return false;
    return (last.endTime ?? last.startTime) - first.startTime >= this.config.memory.windowSec;
  }

  private async flushWindow(): Promise<void> {
    if (this.closed || this.inFlight || this.window.length === 0) return;
    const batch = this.window;
    this.window = [];
    this.inFlight = true;
    const startedAt = Date.now();
    try {
      const block = await this.summarize(
        { kind: "stage", segments: batch },
        0,
        batch[0]?.startTime ?? 0,
        batch.at(-1)?.endTime ?? batch.at(-1)?.startTime ?? 0,
        batch.map((segment) => segment.id),
      );
      this.commit(block);
      metric("summary_block", {
        level: 0,
        segments: batch.length,
        keyPoints: block.keyPoints.length,
        entities: block.entities.length,
        latencyMs: Date.now() - startedAt,
        provider: this.llm.name,
      });
      await this.runMerges();
    } catch (error) {
      // Failure isolates to Memory (Test E): the window is not retried, because a prompt this model
      // cannot answer would otherwise loop forever. The transcript stays authoritative, and Retrieval
      // (§30) still covers the stretch, so the gap costs the overview a block, not the record.
      const message = error instanceof Error ? error.message : String(error);
      log.warn("stage summary failed", { sessionId: this.sessionId, segments: batch.length, message });
      this.bus.emit("module.error", {
        module: "memory",
        code: "summary_failed",
        message,
        at: Date.now(),
        recoverable: true,
      });
      metric("summary_block", { level: 0, ok: false, segments: batch.length, latencyMs: Date.now() - startedAt });
    } finally {
      this.inFlight = false;
      // Speech that arrived while this window was being summarised may already be due; waiting for
      // the next final would otherwise let a busy model push the overview minutes behind.
      if (this.isWindowDue()) this.trigger();
    }
  }

  /** Fold full groups of lower blocks into one block above, level by level, bottom-up. */
  private async runMerges(): Promise<void> {
    for (let level = 0; level < this.config.memory.maxLevel; level++) {
      const queue = this.pending[level] ?? [];
      if (queue.length < this.config.memory.mergeFactor) return;
      const group = queue.slice(0, this.config.memory.mergeFactor);
      const startedAt = Date.now();
      try {
        const merged = await this.summarize(
          { kind: "merge", children: group },
          level + 1,
          group[0]?.startTime ?? 0,
          group.at(-1)?.endTime ?? group.at(-1)?.startTime ?? 0,
          group.map((block) => block.id),
        );
        // Only a produced parent releases its children; a merge that failed leaves them pending.
        // `commit` writes the parent row, and that write is what makes the children absorbed, so it
        // has to come first — releasing them here lost the whole group if the row did not land.
        this.commit(merged);
        this.pending[level] = queue.slice(this.config.memory.mergeFactor);
        metric("summary_block", {
          level: level + 1,
          merged: group.length,
          latencyMs: Date.now() - startedAt,
          provider: this.llm.name,
        });
      } catch (error) {
        this.bus.emit("module.error", {
          module: "memory",
          code: "merge_failed",
          message: error instanceof Error ? error.message : String(error),
          at: Date.now(),
          recoverable: true,
        });
        metric("summary_block", { level: level + 1, ok: false, merged: group.length });
        return;
      }
    }
  }

  private async summarize(
    input: SummaryPromptInput,
    level: number,
    startTime: number,
    endTime: number,
    sourceIds: string[],
  ): Promise<SummaryBlock> {
    const request: LLMRequest = {
      task: "summary",
      system: summarySystemPrompt(input.kind),
      user: summaryUserPrompt(input),
      ...(input.kind === "stage" ? { sourceSegmentIds: sourceIds } : {}),
    };
    const result = await this.llm.structuredGenerate(request, SummaryContentSchema);
    return {
      id: randomUUID(),
      sessionId: this.sessionId,
      startTime,
      endTime,
      summary: result.data.summary,
      keyPoints: result.data.keyPoints,
      entities: result.data.entities,
      level,
      ...(level > 0 && sourceIds.length > 0 ? { parentBlockId: sourceIds[0] } : {}),
      sourceBlockIds: level > 0 ? sourceIds : [],
    };
  }

  private commit(block: SummaryBlock): void {
    this.store.append(block);
    this.committed.push(block);
    const queue = this.pending[block.level] ?? [];
    this.pending[block.level] = [...queue, block];
    this.bus.emit("summary.updated", { sessionId: this.sessionId, block });
  }

  /** Level-L blocks that no level-(L+1) block lists as a source are still awaiting a merge. */
  private unfoldedByLevel(blocks: SummaryBlock[]): SummaryBlock[][] {
    const absorbed = new Set<string>();
    for (const block of blocks) for (const id of block.sourceBlockIds) absorbed.add(id);
    const out: SummaryBlock[][] = [];
    for (const block of blocks) {
      if (absorbed.has(block.id)) continue;
      out[block.level] = [...(out[block.level] ?? []), block];
    }
    return out;
  }
}
