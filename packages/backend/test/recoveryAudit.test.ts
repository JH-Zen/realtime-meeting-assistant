import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecoveryAttempt, RecoveryTask } from "@rcc/shared";
import { RecoveryAudit, type RecoveryTaskStore } from "../src/recovery/RecoveryAudit.js";

const START = 1_700_000_000_000;

function lastRecorded<T>(items: T[]): T {
  const item = items[items.length - 1];
  if (item === undefined) throw new Error("Expected a recorded task");
  return item;
}

function runningAttempt(inputCount: number): RecoveryAttempt {
  return {
    batch: 1,
    attempt: 1,
    inputCount,
    savedCount: 0,
    outcome: "running",
    startedAt: START,
    finishedAt: null,
  };
}

class MemoryStore implements RecoveryTaskStore {
  readonly creates: RecoveryTask[] = [];
  readonly saves: RecoveryTask[] = [];
  readonly writes: RecoveryTask[] = [];
  failNextCreate: Error | null = null;
  failNextSave: Error | null = null;

  create(task: RecoveryTask): void {
    if (this.failNextCreate !== null) {
      const error = this.failNextCreate;
      this.failNextCreate = null;
      throw error;
    }
    this.record(this.creates, task);
  }

  save(task: RecoveryTask): void {
    if (this.failNextSave !== null) {
      const error = this.failNextSave;
      this.failNextSave = null;
      throw error;
    }
    this.record(this.saves, task);
  }

  get latest(): RecoveryTask {
    return lastRecorded(this.writes);
  }

  private record(target: RecoveryTask[], task: RecoveryTask): void {
    const copy = structuredClone(task);
    target.push(copy);
    this.writes.push(copy);
  }
}

function createAudit(store = new MemoryStore()): { audit: RecoveryAudit; store: MemoryStore } {
  return { audit: new RecoveryAudit(store, "session-1", "retrieval", 5), store };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("constructor and snapshots", () => {
  it("persists a running task before any attempt", () => {
    const store = new MemoryStore();
    const audit = new RecoveryAudit(store, "session-1", "mindmap", 6);

    expect(store.creates).toHaveLength(1);
    expect(store.saves).toHaveLength(0);

    const persisted = lastRecorded(store.creates);
    expect(persisted.id).toEqual(expect.any(String));
    expect(persisted.id.length).toBeGreaterThan(0);
    expect(persisted.sessionId).toBe("session-1");
    expect(persisted.kind).toBe("mindmap");
    expect(persisted.status).toBe("running");
    expect(persisted.startedAt).toBe(START);
    expect(Number.isFinite(persisted.startedAt)).toBe(true);
    expect(persisted.finishedAt).toBeNull();
    expect(persisted.initialMissing).toBe(6);
    expect(persisted.remaining).toBeNull();
    expect(persisted.completedBatches).toBe(0);
    expect(persisted.failureCode).toBeNull();
    expect(persisted.attempts).toEqual([]);
    expect(audit.active).toBe(true);
  });

  it("returns snapshots that cannot mutate internal state", () => {
    const { store, audit } = createAudit();

    const first = audit.snapshot;
    const second = audit.snapshot;
    expect(first).not.toBe(second);
    expect(first.attempts).not.toBe(second.attempts);

    first.status = "failed";
    first.completedBatches = 8;
    first.attempts.push(runningAttempt(1));

    expect(audit.snapshot.status).toBe("running");
    expect(audit.snapshot.completedBatches).toBe(0);
    expect(audit.snapshot.attempts).toEqual([]);

    const stored = store.latest;
    stored.status = "failed";
    stored.attempts.push(runningAttempt(1));

    expect(audit.snapshot.status).toBe("running");
    expect(audit.snapshot.attempts).toEqual([]);
  });
});

describe("attempt lifecycle persistence", () => {
  it("saves the running attempt before provider work and saves its outcome afterwards", () => {
    const { audit, store } = createAudit();

    vi.setSystemTime(START + 100);
    audit.beginAttempt(1, 1, 4);

    expect(store.saves).toHaveLength(1);
    const pending = lastRecorded(store.saves);
    expect(pending.status).toBe("running");
    expect(pending.attempts).toHaveLength(1);
    expect(pending.attempts[0]).toEqual({
      batch: 1,
      attempt: 1,
      inputCount: 4,
      savedCount: 0,
      outcome: "running",
      startedAt: START + 100,
      finishedAt: null,
    });

    // Provider work would run here; the durable row already records a running attempt.
    expect(lastRecorded(audit.snapshot.attempts).outcome).toBe("running");
    expect(audit.active).toBe(true);

    vi.setSystemTime(START + 150);
    audit.finishAttempt("succeeded", 4);

    expect(store.saves).toHaveLength(2);
    const settled = lastRecorded(store.saves);
    expect(settled.attempts[0]).toEqual({
      batch: 1,
      attempt: 1,
      inputCount: 4,
      savedCount: 4,
      outcome: "succeeded",
      startedAt: START + 100,
      finishedAt: START + 150,
    });
    expect(settled.completedBatches).toBe(1);
    expect(settled.status).toBe("running");
  });

  it("finishes successfully with zero remaining, consistent counts and timestamps, and finish is idempotent", () => {
    const { audit, store } = createAudit();

    vi.setSystemTime(START + 10);
    audit.beginAttempt(1, 1, 5);
    vi.setSystemTime(START + 20);
    audit.finishAttempt("succeeded", 5);
    vi.setSystemTime(START + 30);
    audit.finish(0);

    const finished = audit.snapshot;
    expect(finished).toMatchObject({
      status: "succeeded",
      remaining: 0,
      failureCode: null,
      completedBatches: 1,
      startedAt: START,
      finishedAt: START + 30,
    });
    expect(finished.attempts).toHaveLength(1);
    expect(finished.attempts[0]).toMatchObject({
      outcome: "succeeded",
      inputCount: 5,
      savedCount: 5,
      finishedAt: START + 20,
    });
    expect(store.latest).toEqual(finished);
    expect(audit.active).toBe(false);

    const saveCount = store.saves.length;
    vi.setSystemTime(START + 90);
    audit.finish(0);
    audit.finish(7, "batch_failed");

    expect(audit.snapshot).toEqual(finished);
    expect(store.saves).toHaveLength(saveCount);
  });

  it("retries only the missing count after partial output and keeps both attempts in history", () => {
    const { audit, store } = createAudit();

    vi.setSystemTime(START + 10);
    audit.beginAttempt(1, 1, 5);
    vi.setSystemTime(START + 20);
    audit.finishAttempt("incomplete", 2);

    let snapshot = audit.snapshot;
    expect(snapshot.completedBatches).toBe(0);
    expect(snapshot.attempts).toHaveLength(1);

    vi.setSystemTime(START + 30);
    audit.beginAttempt(1, 2, 3);
    vi.setSystemTime(START + 40);
    audit.finishAttempt("succeeded", 3);

    snapshot = audit.snapshot;
    expect(
      snapshot.attempts.map(({ batch, attempt, inputCount, savedCount, outcome }) => ({
        batch,
        attempt,
        inputCount,
        savedCount,
        outcome,
      })),
    ).toEqual([
      { batch: 1, attempt: 1, inputCount: 5, savedCount: 2, outcome: "incomplete" },
      { batch: 1, attempt: 2, inputCount: 3, savedCount: 3, outcome: "succeeded" },
    ]);
    expect(snapshot.completedBatches).toBe(1);
    expect(lastRecorded(store.saves).attempts).toHaveLength(2);

    vi.setSystemTime(START + 50);
    audit.finish(0);

    expect(audit.snapshot).toMatchObject({
      status: "succeeded",
      remaining: 0,
      completedBatches: 1,
    });
  });

  it("reports an exhausted batch as failed with the generic batch_failed code", () => {
    const { audit, store } = createAudit();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      vi.setSystemTime(START + attempt * 10);
      audit.beginAttempt(1, attempt, 4);
      vi.setSystemTime(START + attempt * 10 + 5);
      audit.finishAttempt("failed", 0);
    }

    expect(audit.snapshot.attempts).toHaveLength(3);
    expect(audit.snapshot.attempts.every(({ outcome }) => outcome === "failed")).toBe(true);

    vi.setSystemTime(START + 100);
    audit.finish(4, "batch_failed");

    const failed = audit.snapshot;
    expect(failed).toMatchObject({
      status: "failed",
      remaining: 4,
      failureCode: "batch_failed",
      completedBatches: 0,
      finishedAt: START + 100,
    });
    expect(failed.attempts).toHaveLength(3);
    expect(store.latest).toEqual(failed);
    expect(audit.active).toBe(false);
  });
});

describe("batch and attempt limits", () => {
  it("completes eight batches with 24 attempts and ends incomplete when rows remain", () => {
    const { audit, store } = createAudit();
    let now = START;

    for (let batch = 1; batch <= 8; batch += 1) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        now += 10;
        vi.setSystemTime(now);
        audit.beginAttempt(batch, attempt, 3);
        now += 5;
        vi.setSystemTime(now);
        audit.finishAttempt(attempt === 3 ? "succeeded" : "failed", attempt === 3 ? 3 : 0);
      }
    }

    let snapshot = audit.snapshot;
    expect(snapshot.attempts).toHaveLength(24);
    expect(snapshot.completedBatches).toBe(8);
    expect(snapshot.attempts.map(({ batch, attempt }) => `${batch}:${attempt}`)).toEqual(
      Array.from({ length: 8 }, (_, batch) =>
        Array.from({ length: 3 }, (_, attempt) => `${batch + 1}:${attempt + 1}`),
      ).flat(),
    );
    expect(snapshot.status).toBe("running");
    expect(audit.active).toBe(true);

    now += 10;
    vi.setSystemTime(now);
    audit.finish(7);

    snapshot = audit.snapshot;
    expect(snapshot).toMatchObject({
      status: "incomplete",
      remaining: 7,
      failureCode: null,
      completedBatches: 8,
      finishedAt: now,
    });
    expect(snapshot.attempts).toHaveLength(24);
    expect(store.latest).toEqual(snapshot);
  });

  it("rejects a 25th attempt without mutating the task", () => {
    const { audit, store } = createAudit();
    let now = START;

    for (let batch = 1; batch <= 8; batch += 1) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        now += 10;
        vi.setSystemTime(now);
        audit.beginAttempt(batch, attempt, 2);
        now += 5;
        vi.setSystemTime(now);
        // A batch exhausted with failures cannot advance. Complete batches 1..7 on their third
        // attempt so this setup reaches 24 legal attempts before testing the rejected 25th.
        const completed = batch < 8 && attempt === 3;
        audit.finishAttempt(completed ? "succeeded" : "failed", completed ? 2 : 0);
      }
    }

    const before = audit.snapshot;
    expect(before.attempts).toHaveLength(24);
    const saveCount = store.saves.length;

    now += 10;
    vi.setSystemTime(now);
    expect(() => audit.beginAttempt(8, 4, 2)).toThrow();

    expect(audit.snapshot).toEqual(before);
    expect(store.saves).toHaveLength(saveCount);
    expect(audit.active).toBe(true);
  });
});

describe("interruption", () => {
  it("interrupts the pending attempt and task immediately, and late completions cannot rewrite it", () => {
    const { audit, store } = createAudit();

    vi.setSystemTime(START + 10);
    audit.beginAttempt(1, 1, 4);
    vi.setSystemTime(START + 30);
    audit.interrupt("process_interrupted");

    const interrupted = audit.snapshot;
    expect(interrupted).toMatchObject({
      status: "interrupted",
      failureCode: "process_interrupted",
      finishedAt: START + 30,
      remaining: null,
    });
    expect(interrupted.attempts).toHaveLength(1);
    expect(interrupted.attempts[0]).toMatchObject({
      inputCount: 4,
      savedCount: 0,
      outcome: "interrupted",
      finishedAt: START + 30,
    });
    expect(store.latest).toEqual(interrupted);
    expect(audit.active).toBe(false);

    const saveCount = store.saves.length;
    vi.setSystemTime(START + 60);
    expect(() => audit.beginAttempt(1, 2, 4)).toThrow(/already finished/);
    audit.finishAttempt("succeeded", 4);
    audit.finish(0);
    audit.interrupt("cancelled");

    expect(audit.snapshot).toEqual(interrupted);
    expect(store.saves).toHaveLength(saveCount);
  });
});

describe("attempt ordering", () => {
  it("rejects an overlapping attempt while one is running", () => {
    const { audit, store } = createAudit();

    audit.beginAttempt(1, 1, 4);
    const before = audit.snapshot;
    const saveCount = store.saves.length;

    expect(() => audit.beginAttempt(1, 2, 4)).toThrow(/already running/);

    expect(audit.snapshot).toEqual(before);
    expect(store.saves).toHaveLength(saveCount);
  });

  it("rejects duplicate and out-of-order attempts", () => {
    const { audit, store } = createAudit();

    audit.beginAttempt(1, 1, 4);
    audit.finishAttempt("succeeded", 4);
    const afterSuccess = audit.snapshot;
    const saveCount = store.saves.length;

    expect(() => audit.beginAttempt(1, 1, 4)).toThrow(/order is invalid/);
    expect(() => audit.beginAttempt(2, 2, 4)).toThrow(/order is invalid/);
    expect(() => audit.beginAttempt(3, 1, 4)).toThrow(/order is invalid/);
    expect(audit.snapshot).toEqual(afterSuccess);
    expect(store.saves).toHaveLength(saveCount);

    audit.beginAttempt(2, 1, 4);
    audit.finishAttempt("failed", 0);
    const afterFailure = audit.snapshot;

    expect(() => audit.beginAttempt(2, 1, 4)).toThrow(/order is invalid/);
    expect(() => audit.beginAttempt(2, 3, 4)).toThrow(/order is invalid/);
    expect(() => audit.beginAttempt(3, 1, 4)).toThrow(/order is invalid/);
    expect(audit.snapshot).toEqual(afterFailure);

    audit.beginAttempt(2, 2, 4);
    expect(audit.snapshot.attempts).toHaveLength(3);
  });

  it("rejects finishing the task while an attempt is running", () => {
    const { audit, store } = createAudit();

    audit.beginAttempt(1, 1, 4);
    const before = audit.snapshot;
    const saveCount = store.saves.length;

    expect(() => audit.finish(0)).toThrow(/must finish before task/);
    expect(audit.snapshot).toEqual(before);
    expect(audit.active).toBe(true);
    expect(store.saves).toHaveLength(saveCount);

    audit.finishAttempt("succeeded", 4);
    audit.finish(0);

    expect(audit.snapshot.status).toBe("succeeded");
  });
});

describe("attempt count validation", () => {
  it("rejects savedCount greater than inputCount and fake success with fewer saved items", () => {
    const { audit, store } = createAudit();

    vi.setSystemTime(START + 10);
    audit.beginAttempt(1, 1, 4);
    const running = audit.snapshot;
    const saveCount = store.saves.length;

    vi.setSystemTime(START + 20);
    expect(() => audit.finishAttempt("succeeded", 3)).toThrow(/must save every input/);
    expect(audit.snapshot).toEqual(running);
    expect(store.saves).toHaveLength(saveCount);

    expect(() => audit.finishAttempt("incomplete", 5)).toThrow();
    expect(audit.snapshot).toEqual(running);
    expect(store.saves).toHaveLength(saveCount);

    audit.finishAttempt("succeeded", 4);
    expect(lastRecorded(audit.snapshot.attempts)).toMatchObject({
      outcome: "succeeded",
      inputCount: 4,
      savedCount: 4,
    });

    audit.finish(0);
    expect(audit.snapshot.status).toBe("succeeded");
  });
});

describe("persistence failures", () => {
  it("propagates a create failure from the constructor without saving anything", () => {
    const store = new MemoryStore();
    store.failNextCreate = new Error("create failed");

    expect(() => new RecoveryAudit(store, "session-1", "retrieval", 5)).toThrow(/create failed/);
    expect(store.creates).toHaveLength(0);
    expect(store.saves).toHaveLength(0);
  });

  it("propagates a beginAttempt save failure without publishing the attempt", () => {
    const { audit, store } = createAudit();
    const before = audit.snapshot;

    store.failNextSave = new Error("save failed");
    expect(() => audit.beginAttempt(1, 1, 4)).toThrow(/save failed/);

    expect(audit.snapshot).toEqual(before);
    expect(store.saves).toHaveLength(0);
    expect(audit.active).toBe(true);

    vi.setSystemTime(START + 10);
    audit.beginAttempt(1, 1, 4);
    expect(audit.snapshot.attempts).toHaveLength(1);
    expect(store.saves).toHaveLength(1);
  });

  it("propagates a finishAttempt save failure without publishing the outcome or count", () => {
    const { audit, store } = createAudit();
    audit.beginAttempt(1, 1, 4);
    const running = audit.snapshot;

    store.failNextSave = new Error("save failed");
    expect(() => audit.finishAttempt("succeeded", 4)).toThrow(/save failed/);

    expect(audit.snapshot).toEqual(running);
    expect(audit.snapshot.attempts[0]?.outcome).toBe("running");
    expect(audit.snapshot.completedBatches).toBe(0);
    expect(store.saves).toHaveLength(1);
    expect(store.latest).toEqual(running);

    audit.finishAttempt("succeeded", 4);
    expect(audit.snapshot.attempts[0]?.outcome).toBe("succeeded");
    expect(audit.snapshot.completedBatches).toBe(1);
  });

  it("keeps a task running and active when the terminal save fails", () => {
    const { audit, store } = createAudit();
    audit.beginAttempt(1, 1, 4);
    audit.finishAttempt("succeeded", 4);
    const before = audit.snapshot;

    store.failNextSave = new Error("save failed");
    expect(() => audit.finish(0)).toThrow(/save failed/);

    expect(audit.snapshot).toEqual(before);
    expect(audit.snapshot.status).toBe("running");
    expect(audit.active).toBe(true);
    expect(store.latest).toEqual(before);

    audit.finish(0);
    expect(audit.snapshot.status).toBe("succeeded");
    expect(audit.active).toBe(false);
  });

  it("blocks work after an interrupted save fails and allows retrying the interruption", () => {
    const { audit, store } = createAudit();
    audit.beginAttempt(1, 1, 4);
    const running = audit.snapshot;

    store.failNextSave = new Error("save failed");
    expect(() => audit.interrupt("cancelled")).toThrow(/save failed/);

    // The failed write publishes nothing, but cancellation still blocks provider work.
    expect(audit.snapshot).toEqual(running);
    expect(store.latest).toEqual(running);
    expect(audit.active).toBe(false);
    expect(() => audit.beginAttempt(1, 2, 4)).toThrow(/already finished/);

    const saveCount = store.saves.length;
    audit.finishAttempt("succeeded", 4);
    audit.finish(0);
    expect(audit.snapshot).toEqual(running);
    expect(store.saves).toHaveLength(saveCount);

    audit.interrupt("cancelled");

    const interrupted = audit.snapshot;
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.failureCode).toBe("cancelled");
    expect(interrupted.attempts[0]?.outcome).toBe("interrupted");
    expect(store.latest).toEqual(interrupted);
  });
});
