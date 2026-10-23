import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { RecoveryAttempt, RecoveryTask } from "@rcc/shared";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteRecoveryTaskRepository } from "../src/store/recoveryTaskRepository.js";
import { openSqlite, type Sqlite } from "../src/store/sqlite.js";

const opened = new Set<Sqlite>();
const directories: string[] = [];

function open(path = ":memory:") {
  const store = openSqlite(path);
  opened.add(store);
  return store;
}

function close(store: Sqlite) {
  store.close();
  opened.delete(store);
}

function seed(store: Sqlite) {
  const insert = store.db.prepare("INSERT INTO sessions(id,title,started_at,status) VALUES(?,?,?,?)");
  for (const id of ["session-a", "session-b"]) insert.run(id, `合成测试 ${id}`, 10, "completed");
  return new SqliteRecoveryTaskRepository(store.db);
}

function task(patch: Partial<RecoveryTask> = {}): RecoveryTask {
  return {
    id: "task-a", sessionId: "session-a", kind: "retrieval", status: "running",
    startedAt: 100, finishedAt: null, initialMissing: 3, remaining: null,
    completedBatches: 0, failureCode: null, attempts: [], ...patch,
  };
}

function attempt(patch: Partial<RecoveryAttempt> = {}): RecoveryAttempt {
  return {
    batch: 1, attempt: 1, inputCount: 3, savedCount: 0,
    outcome: "running", startedAt: 110, finishedAt: null, ...patch,
  };
}

afterEach(() => {
  for (const store of opened) close(store);
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("recovery-store-中文 空格-")) {
      throw new Error("Refusing cleanup outside the test's temporary directory");
    }
    rmSync(target, { recursive: true, force: true });
  }
});

describe("SQLite recovery task audit repository", () => {
  it("stores a detached schema projection without raw errors, prompts or model output", () => {
    const store = open();
    const repo = seed(store);
    const input = {
      ...task(), rawError: "synthetic provider details", prompt: "synthetic prompt",
      attempts: [{ ...attempt(), response: "synthetic model response" }],
    };
    repo.create(input);
    const saved = repo.list("session-a")[0];
    expect(saved).toEqual(task({ attempts: [attempt()] }));
    input.attempts[0].inputCount = 99;
    saved.attempts[0].savedCount = 2;
    expect(repo.list("session-a")).toEqual([task({ attempts: [attempt()] })]);
    const raw = store.db.prepare("SELECT task_json FROM recovery_tasks").get() as { task_json: string };
    expect(raw.task_json).not.toMatch(/rawError|prompt|response|synthetic/);
    repo.save({ ...task({ remaining: 2 }), rawError: "synthetic save error" } as RecoveryTask);
    expect(repo.list("session-a")).toEqual([task({ remaining: 2 })]);
    expect((store.db.prepare("SELECT task_json FROM recovery_tasks").get() as { task_json: string }).task_json)
      .not.toContain("synthetic save error");
  });

  it("creates only running tasks and never replaces an existing task ID", () => {
    const store = open();
    const repo = seed(store);
    const original = task();
    repo.create(original);
    expect(() => repo.create(task({ remaining: 0 }))).toThrow();
    expect(() => repo.create(task({ sessionId: "session-b", kind: "mindmap" }))).toThrow();
    for (const status of ["succeeded", "incomplete", "failed", "interrupted"] as const) {
      expect(() => repo.create(task({ id: status, status, finishedAt: 150 }))).toThrow();
    }
    expect(repo.list("session-a")).toEqual([original]);
    expect(repo.list("session-b")).toEqual([]);
  });

  it("permits progress and completion, but rejects missing and changed identities without writing", () => {
    const store = open();
    const repo = seed(store);
    repo.create(task());
    expect(() => repo.save(task({ id: "missing" }))).toThrow();
    expect(() => repo.save(task({ sessionId: "session-b" }))).toThrow();
    expect(() => repo.save(task({ kind: "mindmap" }))).toThrow();
    expect(repo.list("session-a")).toEqual([task()]);
    expect(repo.list("session-b")).toEqual([]);
    const progress = task({ attempts: [attempt()] });
    repo.save(progress);
    expect(repo.list("session-a")).toEqual([progress]);
    const finished = task({
      status: "succeeded", finishedAt: 200, remaining: 0, completedBatches: 1,
      attempts: [attempt({ outcome: "succeeded", savedCount: 3, finishedAt: 180 })],
    });
    repo.save(finished);
    expect(repo.list("session-a")).toEqual([finished]);
  });

  it.each(["succeeded", "incomplete", "failed", "interrupted"] as const)(
    "keeps %s terminal tasks immutable even against a valid late callback",
    (status) => {
      const store = open();
      const repo = seed(store);
      repo.create(task());
      const finished = task({ status, finishedAt: 200, remaining: status === "succeeded" ? 0 : 3 });
      repo.save(finished);
      expect(() => repo.save(task())).toThrow();
      expect(() => repo.save({ ...finished, remaining: 1 })).toThrow();
      expect(repo.interruptRunning()).toBe(0);
      expect(repo.list("session-a")).toEqual([finished]);
    },
  );

  it("validates counts, state, attempts, timestamps and enum codes before either write", () => {
    const store = open();
    const repo = seed(store);
    const invalid = [
      { initialMissing: -1 }, { completedBatches: 9 }, { remaining: Number.NaN },
      { failureCode: "raw provider error" }, { status: "running", finishedAt: 150 },
      { startedAt: Infinity }, { attempts: [attempt({ savedCount: 4 })] },
      { attempts: [attempt(), attempt()] },
      { attempts: [attempt({ outcome: "failed", finishedAt: 109 })] },
      { attempts: [attempt({ outcome: "succeeded", finishedAt: 120 })] },
      { attempts: [attempt({ startedAt: 99 })] },
      { completedBatches: 1 },
      { attempts: Array.from({ length: 25 }, () => attempt()) },
    ];
    for (const patch of invalid) {
      expect(() => repo.create({ ...task(), ...patch } as RecoveryTask)).toThrow();
    }
    expect(repo.list("session-a")).toEqual([]);
    repo.create(task());
    for (const patch of invalid) expect(() => repo.save({ ...task(), ...patch } as RecoveryTask)).toThrow();
    expect(() => repo.save(task({ status: "failed", finishedAt: 200, attempts: [attempt()] }))).toThrow();
    expect(repo.list("session-a")).toEqual([task()]);
  });

  it("lists only the requested session in stable newest order and validates bounded limits", () => {
    const store = open();
    const repo = seed(store);
    for (let i = 0; i < 12; i++) repo.create(task({ id: `task-${String(i).padStart(2, "0")}`, startedAt: 100 + Math.floor(i / 2) }));
    repo.create(task({ id: "other", sessionId: "session-b", startedAt: 999 }));
    const expected = Array.from({ length: 12 }, (_, i) => `task-${String(11 - i).padStart(2, "0")}`);
    expect(repo.list("session-a").map((value) => value.id)).toEqual(expected.slice(0, 10));
    expect(repo.list("session-a", 1).map((value) => value.id)).toEqual(expected.slice(0, 1));
    expect(repo.list("session-a", 50).map((value) => value.id)).toEqual(expected);
    expect(repo.list("session-b").map((value) => value.id)).toEqual(["other"]);
    expect(repo.list("unknown")).toEqual([]);
    for (const limit of [0, -1, 51, 1.5, Number.NaN, Infinity]) {
      expect(() => repo.list("session-a", limit)).toThrow(RangeError);
    }
    store.db.exec("PRAGMA query_only=ON");
    expect(repo.list("session-a").map((value) => value.id)).toEqual(expected.slice(0, 10));
  });

  it("interrupts all running tasks and only their running attempts with safe future timestamps", () => {
    const store = open();
    const repo = seed(store);
    const future = Date.now() + 1_000_000;
    const completedAttempt = attempt({ outcome: "succeeded", savedCount: 3, startedAt: future + 10, finishedAt: future + 100 });
    const running = task({
      startedAt: future, completedBatches: 1, remaining: 2,
      attempts: [completedAttempt, attempt({ batch: 2, startedAt: future + 500 })],
    });
    repo.create(running);
    repo.create(task({ id: "other", sessionId: "session-b", kind: "mindmap" }));
    repo.create(task({ id: "terminal" }));
    const terminal = task({ id: "terminal", status: "failed", finishedAt: 200, failureCode: "batch_failed" });
    repo.save(terminal);
    expect(repo.interruptRunning()).toBe(2);
    const result = repo.list("session-a").find((value) => value.id === running.id);
    expect(result).toMatchObject({
      status: "interrupted", failureCode: "process_interrupted", remaining: 2, completedBatches: 1,
    });
    expect(result?.finishedAt).toBeGreaterThanOrEqual(future + 500);
    expect(result?.attempts[0]).toEqual(completedAttempt);
    expect(result?.attempts[1]).toEqual({ ...running.attempts[1], outcome: "interrupted", finishedAt: result?.finishedAt });
    expect(repo.list("session-a").find((value) => value.id === "terminal")).toEqual(terminal);
    expect(repo.list("session-b")[0]).toMatchObject({ status: "interrupted", failureCode: "process_interrupted" });
    expect(() => repo.save(running)).toThrow();
    expect(repo.interruptRunning()).toBe(0);
  });

  it("rolls back every interruption if a later database write fails", () => {
    const store = open();
    const repo = seed(store);
    repo.create(task({ id: "a", attempts: [attempt()] }));
    repo.create(task({ id: "b", sessionId: "session-b", kind: "mindmap", attempts: [attempt()] }));
    const beforeA = repo.list("session-a");
    const beforeB = repo.list("session-b");
    // Fail the second interrupted write regardless of SQLite's SELECT scan order.
    store.db.exec(`CREATE TRIGGER fail_later_interrupt BEFORE UPDATE ON recovery_tasks
      WHEN NEW.status='interrupted' AND (SELECT COUNT(*) FROM recovery_tasks WHERE status='interrupted')=1
      BEGIN SELECT RAISE(ABORT, 'synthetic database failure'); END`);
    expect(() => repo.interruptRunning()).toThrow("synthetic database failure");
    expect(repo.list("session-a")).toEqual(beforeA);
    expect(repo.list("session-b")).toEqual(beforeB);
    store.db.exec("DROP TRIGGER fail_later_interrupt");
    expect(repo.interruptRunning()).toBe(2);
  });

  it("requires a real parent session and cascades task deletion only for that session", () => {
    const store = open();
    const repo = seed(store);
    expect(() => repo.create(task({ sessionId: "missing" }))).toThrow();
    repo.create(task());
    repo.create(task({ id: "other", sessionId: "session-b" }));
    store.db.prepare("DELETE FROM sessions WHERE id=?").run("session-a");
    expect(repo.list("session-a")).toEqual([]);
    expect(repo.list("session-b")).toEqual([task({ id: "other", sessionId: "session-b" })]);
    expect(() => repo.save(task())).toThrow();
  });

  it("adds its schema to an existing Chinese-space database, reopens and preserves source rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "recovery-store-中文 空格-"));
    directories.push(directory);
    const path = join(directory, "既有会议 数据.sqlite");
    const first = open(path);
    seed(first);
    first.db.prepare(`INSERT INTO transcript_segments(id,session_id,text,start_time,end_time,created_at)
      VALUES(?,?,?,?,?,?)`).run("seg-1", "session-a", "合成测试原文", 1, 2, 15);
    first.db.prepare(`INSERT INTO mindmap_nodes(id,session_id,title,created_at,updated_at)
      VALUES(?,?,?,?,?)`).run("node-1", "session-a", "合成测试节点", 20, 20);
    first.db.prepare(`INSERT INTO audio_gaps(id,session_id,stage,reason,certainty,start_time,end_time,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run("gap-1", "session-a", "backend_stt", "worker_unavailable", "observed", 3, 4, 25);
    const tables = ["sessions", "transcript_segments", "mindmap_nodes", "audio_gaps"] as const;
    const before = tables.map((table) => first.db.prepare(`SELECT * FROM ${table}`).all());
    first.db.exec("DROP TABLE recovery_tasks"); // This test-owned file now represents a pre-audit database.
    close(first);
    const second = open(path);
    const repo = new SqliteRecoveryTaskRepository(second.db);
    expect(repo.list("session-a")).toEqual([]);
    repo.create(task({ attempts: [attempt()] }));
    close(second);
    const third = open(path);
    const reopened = new SqliteRecoveryTaskRepository(third.db);
    expect(reopened.list("session-a")).toEqual([task({ attempts: [attempt()] })]);
    expect(reopened.interruptRunning()).toBe(1);
    const interrupted = reopened.list("session-a");
    close(third);
    const fourth = open(path);
    const persisted = new SqliteRecoveryTaskRepository(fourth.db);
    expect(persisted.list("session-a")).toEqual(interrupted);
    expect(persisted.interruptRunning()).toBe(0);
    expect(tables.map((table) => fourth.db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
  });
});
