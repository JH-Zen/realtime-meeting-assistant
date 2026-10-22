import type { TranscriptSegment } from "@rcc/shared";
import type { AppBus } from "../bus/eventBus.js";
import type { BackendConfig } from "../config/env.js";
import { log, metric } from "../observability/log.js";
import type { TranscriptCore } from "../transcript/TranscriptCore.js";
import type { EmbeddingWrite, SqliteEmbeddingRepository } from "../store/embeddingRepository.js";
import type { EmbeddingProvider } from "./EmbeddingProvider.js";
import { rankByCosine, toUnitVector } from "./vector.js";

/**
 * Retrieval (§30): turn every final into a vector as it lands, and answer a question with the
 * Top K finals that are closest to it.
 *
 * This is what makes Test D answerable — Hot Context only reaches back 3-5 minutes, so "how did he
 * define this ten minutes ago" has to come out of the index rather than the window.
 *
 * Two rules shape the code:
 * - only finals are embedded (§14 forbids partials reaching any downstream index), and one segment
 *   is embedded once, so a restart resumes the index instead of recomputing it;
 * - ingest is a queue with a ceiling, not single-flight-and-skip like MindMap. Dropping a segment
 *   would leave a permanent hole in the index, whereas a dropped map update is fixed by the next
 *   batch — so backlog is absorbed by batching and only refused past `maxPending`.
 */

export class RetrievalCore {
  private queue: TranscriptSegment[] = [];
  private embedded = new Set<string>();
  private busy: Promise<void> = Promise.resolve();
  private pumping = false;
  private closed = false;
  private unsubscribe: (() => void) | null = null;
  private dropped = 0;
  private backlogged = false;

  constructor(
    private readonly bus: AppBus,
    private readonly vectors: SqliteEmbeddingRepository,
    private readonly transcripts: TranscriptCore,
    private readonly provider: EmbeddingProvider,
    private readonly config: BackendConfig,
    private readonly sessionId: string,
  ) {}

  start(): void {
    this.embedded = this.vectors.listOwnerIds(this.sessionId, "transcript", this.provider.name);
    this.unsubscribe?.();
    this.unsubscribe = this.bus.on("retrieval", "transcript.final", (segment) => this.enqueue(segment));
  }

  stop(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.queue = [];
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get isBusy(): boolean {
    return this.pumping;
  }

  get indexedCount(): number {
    return this.embedded.size;
  }

  /** Segments refused because the backlog was full; the transcript itself is still complete. */
  get droppedCount(): number {
    return this.dropped;
  }

  private enqueue(segment: TranscriptSegment): void {
    if (this.closed || segment.sessionId !== this.sessionId) return;
    if (this.embedded.has(segment.id)) return;
    if (this.queue.length >= this.config.retrieval.maxPending) {
      this.refuseBacklog();
      return;
    }
    this.queue.push(segment);
    this.kick();
  }

  /** One report per overflow episode: a stuck model must not become an error storm on the UI. */
  private refuseBacklog(): void {
    this.dropped += 1;
    if (this.backlogged) return;
    this.backlogged = true;
    log.warn("embedding backlog full, skipping further segments", {
      sessionId: this.sessionId,
      dropped: this.dropped,
    });
    this.bus.emit("module.error", {
      module: "retrieval",
      code: "embed_backlog",
      message: `嵌入积压已满（${this.config.retrieval.maxPending} 条），跳过的原文仍可靠热上下文与摘要回答`,
      at: Date.now(),
      recoverable: true,
    });
  }

  private kick(): void {
    this.busy = this.busy.then(() => this.pump());
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        await this.drainBatch();
      }
    } finally {
      this.pumping = false;
    }
  }

  private async drainBatch(): Promise<void> {
    const batch = this.queue.splice(0, this.config.retrieval.batchSize);
    const startedAt = Date.now();
    try {
      const vectors = await this.provider.embed(batch.map((segment) => segment.text));
      const usable = Math.min(batch.length, vectors.length);
      if (usable < batch.length) {
        // A provider that answers with fewer vectors than asked has broken its contract; embedding
        // the rest is impossible, so say so instead of silently shrinking the index.
        this.bus.emit("module.error", {
          module: "retrieval",
          code: "embed_short",
          message: `期望 ${batch.length} 条向量，得到 ${usable} 条`,
          at: Date.now(),
          recoverable: true,
        });
      }
      const rows: EmbeddingWrite[] = [];
      for (let i = 0; i < usable; i += 1) {
        const segment = batch[i];
        const vector = vectors[i];
        if (!segment || !vector || vector.length !== this.provider.dim) continue;
        rows.push({
          ownerType: "transcript",
          ownerId: segment.id,
          sessionId: this.sessionId,
          provider: this.provider.name,
          vector: toUnitVector(vector),
        });
      }
      this.vectors.putBatch(rows);
      for (const row of rows) this.embedded.add(row.ownerId);
      metric("embedding_batch", {
        ok: true,
        provider: this.provider.name,
        count: rows.length,
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      // Same policy as a failed stage summary (ADR §9.1 D-3): the batch is dropped, not retried.
      // The transcript stays authoritative, Hot Context and the summaries still cover the stretch,
      // and a retry loop would hold the queue open forever on a prompt the model cannot serve.
      const message = error instanceof Error ? error.message : String(error);
      log.warn("embedding batch failed", { sessionId: this.sessionId, segments: batch.length, message });
      this.bus.emit("module.error", {
        module: "retrieval",
        code: "embed_failed",
        message,
        at: Date.now(),
        recoverable: true,
      });
      metric("embedding_batch", { ok: false, provider: this.provider.name, segments: batch.length });
    } finally {
      this.backlogged = false;
    }
  }

  /** Embed whatever is already queued, so a stop can finish the index instead of losing the tail. */
  async flushPending(): Promise<void> {
    this.kick();
    await this.busy;
  }

  /**
   * Closest stored finals to the question. Returns nothing rather than throwing: retrieval is an
   * enhancement to an answer, and a broken index must not stop QA from answering out of Hot Context.
   */
  async search(question: string, excludeIds: ReadonlySet<string> = new Set()): Promise<TranscriptSegment[]> {
    if (this.closed || question.trim() === "") return [];
    const startedAt = Date.now();
    try {
      const [rawQuery] = await this.provider.embed([question]);
      if (!rawQuery) return [];
      const scanned = this.vectors.scan(this.sessionId, "transcript", this.provider.name, this.provider.dim);
      const candidates = scanned
        .filter((candidate) => !excludeIds.has(candidate.ownerId))
        .map((candidate) => ({ item: candidate, vector: candidate.vector }));
      const rankedAll = rankByCosine(toUnitVector(rawQuery), candidates, this.config.retrieval.topK);
      // The floor is applied after ranking, so `topScore` below is the best score the model actually
      // produced. Filtering first would report 0 whenever the floor killed everything — which is
      // exactly the case whose calibration number is needed.
      const ranked = rankedAll.filter((entry) => entry.score > this.config.retrieval.minScore);
      const byId = new Map(this.transcripts.allFinals(this.sessionId).map((segment) => [segment.id, segment]));
      const hits = ranked
        .map((entry) => byId.get(entry.item.ownerId))
        .filter((segment): segment is TranscriptSegment => segment !== undefined);
      metric("retrieval_search", {
        ok: true,
        provider: this.provider.name,
        // `scanned` is the pre-exclusion count. Without it `candidates: 0` is ambiguous between "the index
        // never filled" and "every line is still inside Hot Context" — in a session shorter than
        // `hotContextSec` those two look identical, and only the second one is normal.
        scanned: scanned.length,
        candidates: candidates.length,
        hits: hits.length,
        topScore: Math.round((rankedAll[0]?.score ?? 0) * 1000) / 1000,
        latencyMs: Date.now() - startedAt,
      });
      return hits;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("retrieval search failed", { sessionId: this.sessionId, message });
      this.bus.emit("module.error", {
        module: "retrieval",
        code: "search_failed",
        message,
        at: Date.now(),
        recoverable: true,
      });
      metric("retrieval_search", { ok: false, provider: this.provider.name, latencyMs: Date.now() - startedAt });
      return [];
    }
  }
}
