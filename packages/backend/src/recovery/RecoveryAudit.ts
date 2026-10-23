import { randomUUID } from "node:crypto";
import { RecoveryTaskSchema, type RecoveryTask, type RecoveryAttempt, type RecoveryFailureCode } from "@rcc/shared";

export interface RecoveryTaskStore {
  create(task: RecoveryTask): void;
  save(task: RecoveryTask): void;
}

/** One bounded task. Writes metadata before each provider request; never retries provider work itself. */
export class RecoveryAudit {
  private value: RecoveryTask;
  private sealed = false;

  constructor(private readonly store: RecoveryTaskStore, sessionId: string, kind: RecoveryTask["kind"], initialMissing: number, options: { trigger?: "manual" | "live"; sourceSegmentIds?: string[] } = {}) {
    this.value = RecoveryTaskSchema.parse({
      id: randomUUID(), sessionId, kind, status: "running", startedAt: Date.now(), finishedAt: null,
      initialMissing, remaining: null, completedBatches: 0, failureCode: null, attempts: [],
      ...options,
    });
    store.create(this.value);
  }

  get active(): boolean { return !this.sealed; }
  get snapshot(): RecoveryTask { return structuredClone(this.value); }

  beginAttempt(batch: number, attempt: number, inputCount: number): void {
    if (this.sealed) throw new Error("Recovery task is already finished");
    const last = this.value.attempts.at(-1);
    if (last?.outcome === "running") throw new Error("Recovery attempt already running");
    const expected = !last ? batch === 1 && attempt === 1
      : last.outcome === "succeeded" ? batch === last.batch + 1 && attempt === 1
      : batch === last.batch && attempt === last.attempt + 1;
    if (!expected) throw new Error("Recovery attempt order is invalid");
    this.persist({ ...this.value, attempts: [...this.value.attempts, {
      batch, attempt, inputCount, savedCount: 0, outcome: "running",
      startedAt: Math.max(Date.now(), this.value.startedAt, last?.finishedAt ?? 0), finishedAt: null,
    }] });
  }

  finishAttempt(outcome: "succeeded" | "incomplete" | "failed", savedCount: number): void {
    if (this.sealed) return;
    const last = this.value.attempts.at(-1);
    if (last?.outcome !== "running") throw new Error("No running recovery attempt");
    if (outcome === "succeeded" && savedCount !== last.inputCount) throw new Error("Successful attempt must save every input");
    const finished: RecoveryAttempt = { ...last, outcome, savedCount, finishedAt: Math.max(Date.now(), last.startedAt) };
    this.persist({ ...this.value, completedBatches: this.value.completedBatches + (outcome === "succeeded" ? 1 : 0), attempts: [...this.value.attempts.slice(0, -1), finished] });
  }

  finish(remaining: number, failureCode: RecoveryFailureCode | null = null, outcome?: "incomplete"): void {
    if (this.sealed) return;
    if (this.value.attempts.at(-1)?.outcome === "running") throw new Error("Recovery attempt must finish before task");
    const status = remaining === 0 ? "succeeded" : outcome ?? (failureCode ? "failed" : "incomplete");
    this.persist({ ...this.value, status, remaining, failureCode: remaining === 0 ? null : failureCode, finishedAt: this.finishTime() });
    this.sealed = true;
  }

  /** Called synchronously on runtime disposal, before any pending provider can return. */
  interrupt(reason: RecoveryFailureCode = "cancelled"): void {
    // Cancellation blocks all new work immediately. A failed metadata write may still be retried
    // explicitly by the owner; it must never re-enable provider work or change a durable terminal row.
    if (this.sealed && this.value.status !== "running") return;
    this.sealed = true;
    const finishedAt = this.finishTime();
    const attempts = this.value.attempts.map((attempt): RecoveryAttempt => attempt.outcome === "running"
      ? { ...attempt, outcome: "interrupted", finishedAt } : attempt);
    this.persist({ ...this.value, status: "interrupted", finishedAt, failureCode: reason, attempts });
  }

  private finishTime(): number {
    return Math.max(Date.now(), this.value.startedAt, ...this.value.attempts.map((a) => a.finishedAt ?? a.startedAt));
  }

  private persist(value: RecoveryTask): void {
    const valid = RecoveryTaskSchema.parse(value);
    this.store.save(valid);
    this.value = valid;
  }
}
