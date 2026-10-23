import { z } from "zod";
import { RecoveryAudit, type RecoveryTaskStore } from "../recovery/RecoveryAudit.js";
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
const MAX_RECOVERY_BATCHES = 8;
const MAX_RECOVERY_ATTEMPTS = 3;

class RejectedOperationsError extends Error {}

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
  private epoch = 0;
  private recoveryJob: Promise<void> | null = null;
  private retryWait: { timer: NodeJS.Timeout; finish: () => void } | null = null;
  private lastError: string | null = null;
  private completedBatches = 0;
  private activeAudit: RecoveryAudit | null = null;
  private activeLiveAudit: RecoveryAudit | null = null;

  constructor(
    private readonly bus: AppBus,
    private readonly graph: GraphStore,
    private readonly llm: LLMProvider,
    private readonly config: BackendConfig,
    private readonly sessionId: string,
    private readonly readFinals: () => TranscriptSegment[] = () => [],
    private readonly auditStore?: RecoveryTaskStore,
  ) {}

  start(): void {
    ++this.epoch;
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
    for (const audit of [this.activeAudit, this.activeLiveAudit]) {
      try { audit?.interrupt(); } catch {
        this.reportAuditFailure();
        try { audit?.interrupt(); } catch { /* A persistent storage failure is sealed at next startup. */ }
      }
    }
    ++this.epoch;
    this.pauseLive();
    this.retryWait?.finish();
  }

  /** Finished input no longer subscribes, but explicit review recovery remains available. */
  pauseLive(): void {
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
    await this.recoveryJob;
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
    return this.inFlight || this.recoveryJob !== null;
  }

  get recoveryStatus() {
    const finals = this.readFinals().filter((segment) => segment.sessionId === this.sessionId && segment.type === "final");
    const processedIds = this.graph.processedSegmentIds();
    const processed = finals.filter((segment) => processedIds.has(segment.id)).length;
    return {
      sessionId: this.sessionId, total: finals.length, processed, missing: finals.length - processed,
      busy: this.isBusy, lastError: this.lastError, completedBatches: this.completedBatches,
      legacyUntracked: this.graph.hasUntrackedChanges() || (processed === 0 && this.graph.snapshot().nodes.length > 0 && finals.length > 0),
    };
  }

  /** Bounded, explicit only. A runtime cancellation never re-opens this writer. */
  rebuildMissing(): Promise<void> {
    if (this.recoveryJob) return this.recoveryJob;
    if (this.closed) return Promise.resolve();
    const epoch = this.epoch;
    const current = () => !this.closed && epoch === this.epoch;
    this.lastError = null;
    let audit: RecoveryAudit | null = null;
    try {
      const missing = this.recoveryStatus.missing;
      if (this.auditStore && missing > 0) audit = new RecoveryAudit(this.auditStore, this.sessionId, "mindmap", missing, { trigger: "manual" });
      this.activeAudit = audit;
    } catch { this.reportAuditFailure(); return Promise.resolve(); }
    const job = Promise.resolve().then(async () => {
      await this.busy;
      const size = Math.max(1, Math.min(32, this.config.mindmap.minSegments));
      for (let round = 0; round < MAX_RECOVERY_BATCHES && current(); round++) {
        const processed = this.graph.processedSegmentIds();
        const batch = this.readFinals().filter((s) => s.sessionId === this.sessionId && s.type === "final" && !processed.has(s.id)).slice(0, size);
        if (batch.length === 0) break;
        let succeeded = false;
        for (let attempt = 0; attempt < MAX_RECOVERY_ATTEMPTS && current(); attempt++) {
          audit?.beginAttempt(round + 1, attempt + 1, batch.length);
          let failure: unknown;
          try {
            await this.generateBatch(batch, "manual", current, true);
            if (!current()) return;
            succeeded = true;
          } catch (error) {
            if (!current()) return;
            failure = error;
          }
          audit?.finishAttempt(succeeded ? "succeeded" : "failed", succeeded ? batch.length : 0);
          if (succeeded) { this.completedBatches++; break; }
          if (!succeeded) {
            if (attempt === MAX_RECOVERY_ATTEMPTS - 1) {
              this.lastError = failure instanceof Error ? failure.message : String(failure);
              this.reportFailure(this.lastError);
            } else await this.waitForRetry(200 * (attempt + 1));
          }
        }
        if (!succeeded) break;
      }
    }).catch((error: unknown) => {
      if (current()) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.reportFailure(this.lastError);
      }
    }).finally(() => {
      try {
        if (audit?.active) {
          if (!current()) audit.interrupt();
          else audit.finish(this.recoveryStatus.missing, this.lastError ? "batch_failed" : null);
        }
      } catch {
        try { audit?.interrupt("audit_failed"); } catch { /* Startup will seal any durable running row. */ }
        this.reportAuditFailure();
      }
      if (this.activeAudit === audit) this.activeAudit = null;
      if (this.recoveryJob === job) this.recoveryJob = null;
      if (!this.closed && this.buffer.length > 0) this.armTimer();
    });
    this.recoveryJob = job;
    return job;
  }

  private waitForRetry(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        if (this.retryWait?.finish !== finish) return;
        clearTimeout(this.retryWait.timer);
        this.retryWait = null;
        resolve();
      };
      this.retryWait = { timer: setTimeout(finish, ms), finish };
    });
  }

  private reportFailure(message: string): void {
    this.bus.emit("module.error", { sessionId: this.sessionId, module: "mindmap", code: "update_failed", message, at: Date.now(), recoverable: true });
  }

  private reportAuditFailure(): void {
    this.lastError = "补建任务记录未能保存；本次补建已停止，请检查日志和磁盘空间。";
    this.reportFailure(this.lastError);
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
    if (this.timer || this.closed || this.buffer.length === 0 || this.recoveryJob) return;
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
    const takesOver = !this.inFlight && !this.recoveryJob && this.buffer.length > 0;
    // Swallowed only so an un-awaited chain cannot become an unhandled rejection; `runFlush` reports
    // its own failures on `module.error`.
    const chain = this.runFlush(reason).catch(() => undefined);
    if (takesOver) this.busy = chain;
  }

  private async runFlush(reason: "batch" | "interval" | "manual"): Promise<void> {
    if (this.closed) return;
    if (this.inFlight || this.recoveryJob) {
      this.bus.emit("mindmap.skipped", { sessionId: this.sessionId, bufferedSegmentCount: this.buffer.length });
      return;
    }
    if (this.buffer.length === 0) return;

    // Keep the rest buffered. One record and model request carry at most 512 unique source IDs.
    const batch = [...new Map(this.buffer.map((segment) => [segment.id, segment])).values()].slice(0, 512);
    const selectedIds = new Set(batch.map((segment) => segment.id));
    this.buffer = this.buffer.filter((segment) => !selectedIds.has(segment.id));
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.inFlight = true;
    const epoch = this.epoch;
    const current = () => !this.closed && this.epoch === epoch;
    this.lastError = null;
    let audit: RecoveryAudit | null = null;
    try {
      try {
        if (this.auditStore) {
          audit = new RecoveryAudit(this.auditStore, this.sessionId, "mindmap", batch.length, { trigger: "live", sourceSegmentIds: batch.map((segment) => segment.id) });
          this.activeLiveAudit = audit;
          audit.beginAttempt(1, 1, batch.length);
        }
      } catch {
        this.sealLiveAudit(audit);
        this.reportAuditFailure();
        return;
      }

      let confirmed = 0;
      let failure: unknown;
      let failed = false;
      try { confirmed = await this.generateBatch(batch, reason, current); }
      catch (error) { failed = true; failure = error; }
      if (!current()) return;
      let auditFailed = false;
      try {
        if (failed) {
          audit?.finishAttempt("failed", 0);
          audit?.finish(batch.length, failure instanceof z.ZodError || failure instanceof RejectedOperationsError ? "invalid_output" : "batch_failed");
        } else {
          audit?.finishAttempt(confirmed === batch.length ? "succeeded" : "incomplete", confirmed);
          audit?.finish(batch.length - confirmed, confirmed === batch.length ? null : "partial_graph", confirmed === batch.length ? undefined : "incomplete");
        }
      } catch { auditFailed = true; this.sealLiveAudit(audit); this.reportAuditFailure(); }
      if (failed && !auditFailed) {
        this.lastError = failure instanceof Error ? failure.message : String(failure);
        if (!(failure instanceof RejectedOperationsError)) this.reportFailure(this.lastError);
      }
    } finally {
      if (!current() && audit?.active) {
        try { audit.interrupt(); } catch { this.sealLiveAudit(audit); this.reportAuditFailure(); }
      }
      if (this.activeLiveAudit === audit) this.activeLiveAudit = null;
      this.inFlight = false;
      if (!this.closed) {
        if (this.buffer.length >= this.config.mindmap.minSegments) this.beginFlush("batch");
        else this.armTimer();
      }
    }
  }

  private sealLiveAudit(audit: RecoveryAudit | null): void {
    try { audit?.interrupt("audit_failed"); }
    catch { try { audit?.interrupt("audit_failed"); } catch { /* Report failure; seal at next healthy startup. */ } }
  }

  private async generateBatch(batch: TranscriptSegment[], reason: "batch" | "interval" | "manual", current: () => boolean, strict = false): Promise<number> {
      if (!current()) return 0;
      const startedAt = Date.now();
      this.lastFlushAt = startedAt;
      this.bus.emit("mindmap.update.requested", { sessionId: this.sessionId, segmentIds: batch.map((s) => s.id), reason });
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
      if (!current()) return 0;
      const parsed = parseGraphOperations(OperationsSchema.parse(result.data), graphReadView(this.graph.graphState), {
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
        if (strict) throw new RejectedOperationsError("导图响应包含无效操作，整批未写入，可恢复服务后补建。");
      }

      const batchIds = batch.map((s) => s.id);
      const applied = strict
        ? this.graph.applyOps(parsed.accepted, result.responseId, batchIds)
        : this.graph.applyOps(parsed.accepted, result.responseId, [], { segmentIds: batchIds, rejected: parsed.rejected.length > 0 });
      if (parsed.rejected.length > 0 || applied.skipped.length > 0) this.lastError = "部分导图操作未应用，相关原文保留为未确认处理；补建可能调整或重复已有节点。";
      const committed = new Set(batch.map((s) => s.id));
      this.buffer = this.buffer.filter((segment) => !committed.has(segment.id));
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
      // Partial legal nodes may exist, but only the source ledger confirms a whole batch.
      if (parsed.rejected.length > 0 || applied.skipped.length > 0) return 0;
      const processed = this.graph.processedSegmentIds();
      return batch.filter((segment) => processed.has(segment.id)).length;
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
