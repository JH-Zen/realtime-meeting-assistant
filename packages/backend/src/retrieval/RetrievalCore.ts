import type { TranscriptSegment } from "@rcc/shared";
import type { AppBus } from "../bus/eventBus.js";
import type { BackendConfig } from "../config/env.js";
import { log, metric } from "../observability/log.js";
import type { TranscriptCore } from "../transcript/TranscriptCore.js";
import type { EmbeddingWrite, SqliteEmbeddingRepository } from "../store/embeddingRepository.js";
import type { EmbeddingProvider } from "./EmbeddingProvider.js";
import { rankByCosine, toUnitVector } from "./vector.js";
import { RecoveryAudit, type RecoveryTaskStore } from "../recovery/RecoveryAudit.js";

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

/**
 * Explicit recovery of index holes: finals whose live embedding failed, or whose stored row belongs
 * to another provider/dimension. The status is derived from durable transcripts plus a scan, so it
 * survives a restart without any new column or table.
 */
export interface RetrievalRecoveryStatus {
  sessionId: string;
  provider: string;
  total: number;
  indexed: number;
  missing: number;
  busy: boolean;
  lastError: string | null;
  completedBatches: number;
}

/** One explicit repair is bounded work, not an open-ended background drain. */
const REPAIR_MAX_BATCHES = 8;
const REPAIR_MAX_ATTEMPTS = 3;
const REPAIR_RETRY_DELAYS_MS = [200, 400] as const;

export class RetrievalCore {
  private queue: TranscriptSegment[] = [];
  private embedded = new Set<string>();
  private busy: Promise<void> = Promise.resolve();
  private pumping = false;
  private closed = false;
  private unsubscribe: (() => void) | null = null;
  private dropped = 0;
  private backlogged = false;
  private repairPromise: Promise<void> | null = null;
  private repairActive = false;
  private repairLastError: string | null = null;
  private repairCompletedBatches = 0;
  private activeAudit: RecoveryAudit | null = null;
  private activeLiveAudit: RecoveryAudit | null = null;
  private backlogAuditFailureReported = false;
  /** Only one repair runs at a time, so one cancellable backoff slot is enough. */
  private retryWait: { timer: ReturnType<typeof setTimeout>; finish: () => void } | null = null;

  constructor(
    private readonly bus: AppBus,
    private readonly vectors: SqliteEmbeddingRepository,
    private readonly transcripts: TranscriptCore,
    private readonly provider: EmbeddingProvider,
    private readonly config: BackendConfig,
    private readonly sessionId: string,
    private readonly auditStore?: RecoveryTaskStore,
  ) {}

  start(): void {
    this.embedded = this.vectors.listOwnerIds(this.sessionId, "transcript", this.provider.name);
    this.unsubscribe?.();
    this.unsubscribe = this.bus.on("retrieval", "transcript.final", (segment) => this.enqueue(segment));
  }

  stop(): void {
    this.closed = true;
    const liveAudit = this.activeLiveAudit;
    this.activeLiveAudit = null;
    if (liveAudit) this.interruptLiveAudit(liveAudit, "cancelled");
    try { this.activeAudit?.interrupt(); } catch {
      this.reportAuditFailure();
      try { this.activeAudit?.interrupt(); } catch { /* A persistent storage failure is sealed at next startup. */ }
    }
    this.cancelRetryWait();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.queue = [];
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get isBusy(): boolean {
    return this.pumping || this.repairActive;
  }

  get indexedCount(): number {
    return this.embedded.size;
  }

  /**
   * Truthful answer to "is this session fully indexed?" — read from durable transcripts and a
   * provider/dimension-filtered scan, never from a process counter. No embedding request is made.
   */
  get recoveryStatus(): RetrievalRecoveryStatus {
    const finals = this.transcripts.allFinals(this.sessionId);
    const indexed = this.usableFinalIds(finals);
    let missing = 0;
    for (const segment of finals) {
      if (!indexed.has(segment.id)) missing += 1;
    }
    return {
      sessionId: this.sessionId,
      provider: this.provider.name,
      total: finals.length,
      indexed: indexed.size,
      missing,
      busy: this.repairActive || this.pumping,
      lastError: this.repairLastError,
      completedBatches: this.repairCompletedBatches,
    };
  }

  /** Segments refused because the backlog was full; the transcript itself is still complete. */
  get droppedCount(): number {
    return this.dropped;
  }

  private enqueue(segment: TranscriptSegment): void {
    if (this.closed || segment.sessionId !== this.sessionId) return;
    if (this.embedded.has(segment.id)) return;
    if (this.queue.length >= this.config.retrieval.maxPending) {
      this.refuseBacklog(segment);
      return;
    }
    this.queue.push(segment);
    this.kick();
  }

  /** One report per overflow episode: a stuck model must not become an error storm on the UI. */
  private refuseBacklog(segment: TranscriptSegment): void {
    this.dropped += 1;
    // A refused final remains in the transcript, but gets no model attempt. Persist its identity
    // separately from the once-per-episode UI warning so every known hole stays attributable.
    let audit: RecoveryAudit | null = null;
    try {
      if (this.auditStore) {
        audit = new RecoveryAudit(this.auditStore, this.sessionId, "retrieval", 1, {
          trigger: "live", sourceSegmentIds: [segment.id],
        });
        audit.finish(1, "backlog_full");
      }
    } catch {
      if (!this.backlogAuditFailureReported) {
        this.backlogAuditFailureReported = true;
        this.reportLiveAuditFailure();
      }
      if (audit) this.interruptLiveAudit(audit, "audit_failed", false);
    }
    if (this.backlogged) return;
    this.backlogged = true;
    log.warn("embedding backlog full, skipping further segments", {
      sessionId: this.sessionId,
      dropped: this.dropped,
    });
    this.bus.emit("module.error", {
      sessionId: this.sessionId,
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
    const queued = this.queue.splice(0, Math.min(this.config.retrieval.batchSize, 512));
    // A repair may finish a row while its live copy is still queued (a final accepted mid-repair).
    // Dropping it here keeps that id from being embedded a second time.
    const seen = new Set<string>();
    const batch = queued.filter((segment) => {
      if (this.embedded.has(segment.id) || seen.has(segment.id)) return false;
      seen.add(segment.id);
      return true;
    });
    if (batch.length === 0) {
      this.backlogged = false;
      this.backlogAuditFailureReported = false;
      return;
    }
    const startedAt = Date.now();
    let audit: RecoveryAudit | null = null;
    try {
      // Both task and attempt must be durable before asking the provider. Metadata failures never
      // create an unrecorded retry or prevent the transcript from retaining the original final.
      try {
        if (this.auditStore) {
          audit = new RecoveryAudit(this.auditStore, this.sessionId, "retrieval", batch.length, {
            trigger: "live", sourceSegmentIds: batch.map((segment) => segment.id),
          });
          this.activeLiveAudit = audit;
          audit.beginAttempt(1, 1, batch.length);
        }
      } catch {
        this.reportLiveAuditFailure();
        if (audit) this.interruptLiveAudit(audit, "audit_failed", false);
        return;
      }

      let savedCount = 0;
      let failureCode: "batch_failed" | "incomplete_output" | "invalid_output" | null = null;
      try {
        const vectors = await this.provider.embed(batch.map((segment) => segment.text));
        // stop() seals the audit synchronously; neither business nor metadata accepts late output.
        if (this.closed) return;
        const received = Math.min(batch.length, vectors.length);
        if (received < batch.length) {
          this.bus.emit("module.error", {
            sessionId: this.sessionId,
            module: "retrieval",
            code: "embed_short",
            message: `期望 ${batch.length} 条向量，得到 ${received} 条`,
            at: Date.now(),
            recoverable: true,
          });
        }
        const rows: EmbeddingWrite[] = [];
        for (let i = 0; i < received; i += 1) {
          const segment = batch[i];
          const vector = vectors[i];
          if (!segment || !isUsableVector(vector, this.provider.dim)) continue;
          rows.push({
            ownerType: "transcript",
            ownerId: segment.id,
            sessionId: this.sessionId,
            provider: this.provider.name,
            vector: toUnitVector(vector),
          });
        }
        if (rows.length > 0) {
          this.vectors.putBatch(rows);
          for (const row of rows) this.embedded.add(row.ownerId);
          savedCount = rows.length;
        }
        failureCode = savedCount === batch.length ? null : savedCount > 0 ? "incomplete_output" : "invalid_output";
        if (received === batch.length && savedCount < batch.length) {
          this.bus.emit("module.error", {
            sessionId: this.sessionId, module: "retrieval", code: "embed_invalid",
            message: `嵌入结果包含无效向量，仍有 ${batch.length - savedCount} 条未建立索引`,
            at: Date.now(), recoverable: true,
          });
        }
        metric("embedding_batch", {
          ok: failureCode === null,
          provider: this.provider.name,
          count: savedCount,
          latencyMs: Date.now() - startedAt,
        });
      } catch (error) {
        if (this.closed) return;
        failureCode = "batch_failed";
        // Live ingest remains single-attempt. Explicit repair can discover this durable hole later.
        const message = error instanceof Error ? error.message : String(error);
        log.warn("embedding batch failed", { sessionId: this.sessionId, segments: batch.length, message });
        this.bus.emit("module.error", {
          sessionId: this.sessionId,
          module: "retrieval",
          code: "embed_failed",
          message,
          at: Date.now(),
          recoverable: true,
        });
        metric("embedding_batch", { ok: false, provider: this.provider.name, segments: batch.length });
      }

      if (this.closed) return;
      try {
        audit?.finishAttempt(savedCount === batch.length ? "succeeded" : savedCount > 0 ? "incomplete" : "failed", savedCount);
        audit?.finish(batch.length - savedCount, failureCode, failureCode === "incomplete_output" ? "incomplete" : undefined);
      } catch {
        // Vector transaction and audit writes are separate: committed vectors remain authoritative
        // even if metadata cannot finish. Seal as uncertain instead of repeating provider work.
        this.reportLiveAuditFailure();
        if (audit) this.interruptLiveAudit(audit, "audit_failed", false);
      }
    } finally {
      if (this.activeLiveAudit === audit) this.activeLiveAudit = null;
      this.backlogged = false;
      this.backlogAuditFailureReported = false;
    }
  }

  private reportLiveAuditFailure(): void {
    this.bus.emit("module.error", {
      sessionId: this.sessionId, module: "retrieval", code: "recovery_audit_failed",
      message: "实时索引任务记录未能保存；本批次已停止，请检查日志和磁盘空间。",
      at: Date.now(), recoverable: true,
    });
  }

  private interruptLiveAudit(audit: RecoveryAudit, reason: "cancelled" | "audit_failed", reportFailure = true): void {
    try { audit.interrupt(reason); } catch {
      if (reportFailure) this.reportLiveAuditFailure();
      // Only one immediate metadata retry; persistent failures are sealed at next backend startup.
      try { audit.interrupt(reason); } catch { /* No provider retry and no error storm. */ }
    }
  }

  /**
   * Explicitly rebuild finals that have no usable vector for this provider and dimension.
   *
   * The job joins the same promise chain as live ingest, so it never overlaps a provider call and
   * `flushPending()` queued during a repair runs afterwards. Concurrent calls share one job.
   */
  rebuildMissing(): Promise<void> {
    if (this.repairPromise) return this.repairPromise;
    if (this.closed) return Promise.resolve();

    this.repairActive = true;
    this.repairLastError = null;
    this.repairCompletedBatches = 0;
    let audit: RecoveryAudit | null = null;
    try {
      const missing = this.recoveryStatus.missing;
      if (this.auditStore && missing > 0) audit = new RecoveryAudit(this.auditStore, this.sessionId, "retrieval", missing, { trigger: "manual" });
      this.activeAudit = audit;
    } catch {
      this.repairActive = false;
      this.reportAuditFailure();
      return Promise.resolve();
    }

    const job = this.busy
      .then(() => this.runRepair())
      // runRepair catches its own failures; this guard only keeps the shared chain usable.
      .catch((error: unknown) => {
        if (!this.closed) this.repairLastError = error instanceof Error ? error.message : String(error);
      });
    this.busy = job;
    this.repairPromise = job.finally(() => {
      try {
        if (audit?.active) {
          if (this.closed) audit.interrupt();
          else audit.finish(this.recoveryStatus.missing, this.repairLastError ? "batch_failed" : null);
        }
      } catch {
        try { audit?.interrupt("audit_failed"); } catch { /* Startup will seal any durable running row. */ }
        this.reportAuditFailure();
      }
      if (this.activeAudit === audit) this.activeAudit = null;
      this.repairActive = false;
      this.repairPromise = null;
    });
    return this.repairPromise;
  }

  private async runRepair(): Promise<void> {
    if (this.closed) return;
    let batches = 0;
    while (batches < REPAIR_MAX_BATCHES && !this.closed) {
      const missing = this.missingFinals();
      if (missing.length === 0) return;
      const batch = missing.slice(0, this.config.retrieval.batchSize);
      const completed = await this.repairBatch(batch, batches + 1);
      if (this.closed || !completed) return;
      this.repairCompletedBatches += 1;
      batches += 1;
    }
  }

  private missingFinals(): TranscriptSegment[] {
    const finals = this.transcripts.allFinals(this.sessionId);
    const indexed = this.usableFinalIds(finals);
    return finals.filter((segment) => !indexed.has(segment.id));
  }

  private usableFinalIds(finals: readonly TranscriptSegment[]): Set<string> {
    if (finals.length === 0) return new Set();
    const finalIds = new Set(finals.map((segment) => segment.id));
    const indexed = new Set<string>();
    for (const candidate of this.vectors.scan(this.sessionId, "transcript", this.provider.name, this.provider.dim)) {
      if (finalIds.has(candidate.ownerId) && isUsableVector(candidate.vector, this.provider.dim)) {
        indexed.add(candidate.ownerId);
      }
    }
    return indexed;
  }

  /**
   * One batch, at most three attempts. A partially usable response is persisted, then only the
   * still-missing rows of this batch are retried, so a retry never rewrites good rows.
   */
  private async repairBatch(batch: readonly TranscriptSegment[], batchIndex: number): Promise<boolean> {
    let pending = [...batch];
    for (let attempt = 0; attempt < REPAIR_MAX_ATTEMPTS; attempt += 1) {
      if (this.closed) return false;
      // Audit failures abort the job rather than silently issuing unrecorded provider requests.
      this.activeAudit?.beginAttempt(batchIndex, attempt + 1, pending.length);
      let failure: string | null = null;
      let savedCount = 0;
      try {
        const vectors = await this.provider.embed(pending.map((segment) => segment.text));
        /**
         * stop() may happen while the model is thinking. Checking here is what keeps a late answer
         * from writing a row, emitting an error, or starting another request after shutdown.
         */
        if (this.closed) return false;

        const rows: EmbeddingWrite[] = [];
        const received = Math.min(pending.length, vectors.length);
        for (let i = 0; i < received; i += 1) {
          const segment = pending[i];
          const vector = vectors[i];
          if (!segment || !isUsableVector(vector, this.provider.dim)) continue;
          rows.push({
            ownerType: "transcript",
            ownerId: segment.id,
            sessionId: this.sessionId,
            provider: this.provider.name,
            vector: toUnitVector(vector),
          });
        }

        if (rows.length > 0) {
          this.vectors.putBatch(rows);
          for (const row of rows) this.embedded.add(row.ownerId);
          savedCount = rows.length;
        }

        if (rows.length === 0) {
          failure = `模型未返回可用向量（${pending.length} 条）`;
        } else {
          const repaired = new Set(rows.map((row) => row.ownerId));
          pending = pending.filter((segment) => !repaired.has(segment.id));
          if (pending.length === 0) {
            this.repairLastError = null;
          } else {
            failure = `嵌入修复不完整：仍有 ${pending.length} 条缺少可用向量`;
          }
        }
      } catch (error) {
        if (this.closed) return false;
        // An embed exception or a failed transaction is retried, but only the rows still missing.
        failure = error instanceof Error ? error.message : String(error);
      }

      if (this.closed) return false;
      this.activeAudit?.finishAttempt(pending.length === 0 ? "succeeded" : savedCount > 0 ? "incomplete" : "failed", savedCount);
      if (pending.length === 0) return true;
      this.repairLastError = failure;
      if (attempt < REPAIR_MAX_ATTEMPTS - 1) {
        await this.waitForRetry(REPAIR_RETRY_DELAYS_MS[attempt] ?? 400);
        if (this.closed) return false;
      }
    }

    if (this.closed) return false;
    const message = this.repairLastError ?? "嵌入修复失败";
    log.warn("embedding repair failed", { sessionId: this.sessionId, segments: pending.length, message });
    this.bus.emit("module.error", {
      sessionId: this.sessionId,
      module: "retrieval",
      code: "embed_rebuild_failed",
      message,
      at: Date.now(),
      recoverable: true,
    });
    return false;
  }

  private reportAuditFailure(): void {
    this.repairLastError = "补建任务记录未能保存；本次补建已停止，请检查日志和磁盘空间。";
    this.bus.emit("module.error", { sessionId: this.sessionId, module: "retrieval", code: "recovery_audit_failed", message: this.repairLastError, at: Date.now(), recoverable: true });
  }

  private waitForRetry(ms: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.retryWait = null;
        resolve();
      }, ms);
      this.retryWait = {
        timer,
        finish: () => {
          clearTimeout(timer);
          this.retryWait = null;
          resolve();
        },
      };
    });
  }

  /** stop() resolves a pending backoff immediately instead of leaving the repair asleep for 400 ms. */
  private cancelRetryWait(): void {
    const wait = this.retryWait;
    this.retryWait = null;
    wait?.finish();
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
        sessionId: this.sessionId,
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

function isUsableVector(vector: Float32Array | null | undefined, dim: number): vector is Float32Array {
  if (!vector || vector.length !== dim) return false;
  for (let i = 0; i < vector.length; i += 1) {
    if (!Number.isFinite(vector[i])) return false;
  }
  return true;
}
