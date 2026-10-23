import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModuleError, RecoveryTask, TranscriptSegment } from "@rcc/shared";
import { createBus, type AppBus } from "../src/bus/eventBus.js";
import type { BackendConfig } from "../src/config/env.js";
import type { RecoveryTaskStore } from "../src/recovery/RecoveryAudit.js";
import type { EmbeddingProvider } from "../src/retrieval/EmbeddingProvider.js";
import { RetrievalCore } from "../src/retrieval/RetrievalCore.js";
import { SqliteEmbeddingRepository } from "../src/store/embeddingRepository.js";
import { SqliteRecoveryTaskRepository } from "../src/store/recoveryTaskRepository.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { openSqlite, type Sqlite } from "../src/store/sqlite.js";
import { SqliteTranscriptRepository } from "../src/store/transcriptRepository.js";
import { TranscriptCore } from "../src/transcript/TranscriptCore.js";
import { makeConfig, segment, tick } from "./helpers.js";

class ControlledEmbedding implements EmbeddingProvider {
  readonly name = "live-audit-test";
  readonly dim = 2;
  readonly calls: string[][] = [];
  respond: (texts: readonly string[]) => Float32Array[] | Promise<Float32Array[]> = (texts) =>
    texts.map(() => Float32Array.from([3, 4]));

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls.push([...texts]);
    return this.respond(texts);
  }
}

interface Harness {
  store: Sqlite;
  bus: AppBus;
  tasks: SqliteRecoveryTaskRepository;
  embeddings: SqliteEmbeddingRepository;
  transcripts: TranscriptCore;
  transcriptStore: SqliteTranscriptRepository;
  provider: ControlledEmbedding;
  core: RetrievalCore;
  errors: ModuleError[];
  release: (() => void) | null;
}

const harnesses: Harness[] = [];
let sequence = 0;

function setup(options: {
  retrieval?: Partial<BackendConfig["retrieval"]>;
  auditStore?: (tasks: SqliteRecoveryTaskRepository) => RecoveryTaskStore | undefined;
} = {}): Harness {
  const store = openSqlite(":memory:");
  new SqliteSessionRepository(store.db).create({ id: "s1", startedAt: 1, status: "recording" });
  const bus = createBus();
  const tasks = new SqliteRecoveryTaskRepository(store.db);
  const embeddings = new SqliteEmbeddingRepository(store.db);
  const transcriptStore = new SqliteTranscriptRepository(store.db);
  const transcripts = new TranscriptCore(bus, transcriptStore);
  const provider = new ControlledEmbedding();
  const config = makeConfig({ retrieval: { ...makeConfig().retrieval, ...options.retrieval } });
  const core = new RetrievalCore(bus, embeddings, transcripts, provider, config, "s1",
    options.auditStore ? options.auditStore(tasks) : tasks);
  const errors: ModuleError[] = [];
  bus.onError((error) => errors.push(error));
  core.start();
  const harness = { store, bus, tasks, embeddings, transcriptStore, transcripts, provider, core, errors, release: null };
  harnesses.push(harness);
  return harness;
}

function say(h: Harness, count: number): TranscriptSegment[] {
  return Array.from({ length: count }, () => {
    sequence += 1;
    const entry = segment(`live-${sequence}`, `固定测试原文 ${sequence}`, sequence);
    h.transcripts.acceptFinal(entry);
    return entry;
  });
}

async function flush(h: Harness): Promise<void> {
  await tick();
  await h.core.flushPending();
  await tick();
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await tick();
  }
  throw new Error("Expected live operation did not begin");
}

function hold(h: Harness): { succeed: () => void; fail: () => void } {
  let resolve: (value: Float32Array[]) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const pending = new Promise<Float32Array[]>((ok, no) => { resolve = ok; reject = no; });
  h.provider.respond = () => pending;
  const succeed = () => {
    h.provider.respond = (texts) => texts.map(() => Float32Array.from([1, 0]));
    resolve([Float32Array.from([1, 0])]);
  };
  h.release = succeed;
  return { succeed, fail: () => { reject(new Error("held provider failure")); } };
}

function onlyTask(h: Harness): RecoveryTask {
  const tasks = h.tasks.list("s1");
  expect(tasks).toHaveLength(1);
  const first = tasks[0];
  if (!first) throw new Error("Missing task");
  return first;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) {
    h.core.stop();
    h.release?.();
    await h.core.flushPending();
    h.bus.clear();
    h.store.close();
  }
});

describe("live retrieval task audit with actual SQLite", () => {
  it("persists source IDs and a running attempt before the provider, then records normalized vectors", async () => {
    const h = setup();
    h.provider.respond = (texts) => {
      expect(onlyTask(h)).toMatchObject({ trigger: "live", status: "running", initialMissing: 3,
        attempts: [{ batch: 1, attempt: 1, inputCount: 3, savedCount: 0, outcome: "running" }] });
      return texts.map(() => Float32Array.from([3, 4]));
    };
    const entries = say(h, 3);
    await flush(h);
    expect(onlyTask(h)).toMatchObject({ trigger: "live", sourceSegmentIds: entries.map((entry) => entry.id),
      status: "succeeded", remaining: 0, completedBatches: 1, failureCode: null,
      attempts: [{ inputCount: 3, savedCount: 3, outcome: "succeeded" }] });
    expect(h.provider.calls).toHaveLength(1);
    expect(h.embeddings.count("s1")).toBe(3);
    expect(h.embeddings.scan("s1", "transcript", h.provider.name, 2)[0]?.vector[0]).toBeCloseTo(0.6);
    expect(h.errors).toEqual([]);
  });

  it.each(["short", "nonfinite"])("persists valid rows only for a %s partial result without model retry", async (mode) => {
    const h = setup();
    h.provider.respond = () => mode === "short" ? [Float32Array.from([1, 0])]
      : [Float32Array.from([1, 0]), Float32Array.from([Number.NaN, Number.POSITIVE_INFINITY])];
    const entries = say(h, 2);
    await flush(h);
    expect(onlyTask(h)).toMatchObject({ status: "incomplete", remaining: 1, failureCode: "incomplete_output",
      sourceSegmentIds: entries.map((entry) => entry.id), attempts: [{ outcome: "incomplete", savedCount: 1 }] });
    expect(h.embeddings.scan("s1", "transcript", h.provider.name, 2).map((row) => row.ownerId)).toEqual([entries[0]?.id]);
    expect(h.core.recoveryStatus).toMatchObject({ indexed: 1, missing: 1 });
    expect(h.provider.calls).toHaveLength(1);
  });

  it.each([
    ["empty", []],
    ["NaN", [Float32Array.from([Number.NaN, 1])]],
    ["Infinity", [Float32Array.from([1, Number.POSITIVE_INFINITY])]],
    ["dimension", [Float32Array.from([1, 0, 0])]],
  ] as const)("records invalid_output for %s output without storing a substitute zero vector", async (_label, vectors) => {
    const h = setup();
    h.provider.respond = () => [...vectors];
    say(h, 1);
    await flush(h);
    expect(onlyTask(h)).toMatchObject({ status: "failed", remaining: 1, failureCode: "invalid_output",
      attempts: [{ outcome: "failed", savedCount: 0 }] });
    expect(h.embeddings.count("s1")).toBe(0);
    expect(h.provider.calls).toHaveLength(1);
    expect(h.transcripts.allFinals("s1")).toHaveLength(1);
  });

  it("records provider failure as safe task metadata with no automatic request retry", async () => {
    const h = setup();
    h.provider.respond = () => { throw new Error("private provider output marker"); };
    say(h, 2);
    await flush(h);
    const task = onlyTask(h);
    expect(task).toMatchObject({ status: "failed", failureCode: "batch_failed", remaining: 2,
      attempts: [{ inputCount: 2, outcome: "failed", savedCount: 0 }] });
    expect(JSON.stringify(task)).not.toContain("private provider output marker");
    expect(h.provider.calls).toHaveLength(1);
    expect(h.errors.map((error) => error.code)).toEqual(["embed_failed"]);
    expect(h.transcripts.allFinals("s1")).toHaveLength(2);
  });

  it("records actual SQLite vector transaction failure and leaves the full batch missing", async () => {
    const h = setup();
    h.store.db.exec("CREATE TRIGGER reject_live_vector BEFORE INSERT ON embeddings BEGIN SELECT RAISE(ABORT,'fixed write fault'); END;");
    say(h, 2);
    await flush(h);
    expect(onlyTask(h)).toMatchObject({ failureCode: "batch_failed", remaining: 2,
      attempts: [{ outcome: "failed", savedCount: 0 }] });
    expect(h.embeddings.count("s1")).toBe(0);
    expect(h.provider.calls).toHaveLength(1);
  });

  it("bounds source IDs at 512 while draining the remaining queue in its own audited batch", async () => {
    const h = setup({ retrieval: { batchSize: 1000, maxPending: 1024 } });
    say(h, 514);
    await flush(h);
    expect(h.provider.calls.map((texts) => texts.length)).toEqual([512, 2]);
    const tasks = h.tasks.list("s1");
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.sourceSegmentIds?.length).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([2, 512]);
    expect(tasks.every((task) => task.status === "succeeded")).toBe(true);
    expect(h.embeddings.count("s1")).toBe(514);
  });

  it("deduplicates repeated queued bus IDs before recording a live source batch", async () => {
    const h = setup();
    const [entry] = say(h, 1);
    if (!entry) throw new Error("Missing segment");
    h.bus.emit("transcript.final", entry);
    await flush(h);
    expect(onlyTask(h)).toMatchObject({ initialMissing: 1, sourceSegmentIds: [entry.id], status: "succeeded" });
    expect(h.provider.calls.flat()).toHaveLength(1);
  });

  it("records each backlog refusal without attempts and emits only one warning per overflow episode", async () => {
    const h = setup({ retrieval: { batchSize: 1, maxPending: 2 } });
    const held = hold(h);
    say(h, 1);
    await waitFor(() => h.provider.calls.length === 1);
    const queued = say(h, 4);
    await tick();
    const rejected = h.tasks.list("s1").filter((task) => task.failureCode === "backlog_full");
    expect(rejected).toHaveLength(2);
    expect(rejected.flatMap((task) => task.sourceSegmentIds ?? []).sort()).toEqual(queued.slice(2).map((entry) => entry.id).sort());
    expect(rejected.every((task) => task.trigger === "live" && task.status === "failed" && task.remaining === 1 && task.attempts.length === 0)).toBe(true);
    expect(h.errors.filter((error) => error.code === "embed_backlog")).toHaveLength(1);
    expect(h.provider.calls).toHaveLength(1);
    held.succeed();
    await flush(h);
    expect(h.provider.calls).toHaveLength(3);
    expect(h.transcripts.allFinals("s1")).toHaveLength(5);
  });

  it("limits audit warnings when storage rejects every backlog record", async () => {
    const h = setup({ retrieval: { batchSize: 1, maxPending: 1 } });
    const held = hold(h);
    say(h, 1);
    await waitFor(() => h.provider.calls.length === 1);
    const create = vi.spyOn(h.tasks, "create").mockImplementation(() => { throw new Error("private disk marker"); });
    say(h, 10);
    await tick();
    expect(create).toHaveBeenCalledTimes(9);
    expect(h.errors.filter((error) => error.code === "recovery_audit_failed")).toHaveLength(1);
    expect(h.errors.filter((error) => error.code === "embed_backlog")).toHaveLength(1);
    expect(h.errors.some((error) => error.message.includes("private disk marker"))).toBe(false);
    expect(h.provider.calls).toHaveLength(1);
    h.core.stop();
    held.succeed();
    await flush(h);
  });

  it.each(["success", "failure"])("synchronously interrupts on stop and ignores a held late %s", async (outcome) => {
    const h = setup();
    const held = hold(h);
    say(h, 1);
    await waitFor(() => h.provider.calls.length === 1);
    h.core.stop();
    const sealed = onlyTask(h);
    expect(sealed).toMatchObject({ status: "interrupted", failureCode: "cancelled",
      attempts: [{ outcome: "interrupted", savedCount: 0 }] });
    if (outcome === "success") held.succeed();
    else held.fail();
    await flush(h);
    expect(onlyTask(h)).toEqual(sealed);
    expect(h.embeddings.count("s1")).toBe(0);
    expect(h.errors).toEqual([]);
    expect(h.provider.calls).toHaveLength(1);
  });

  it("seals a held task after one transient stop metadata failure, without a third write or model call", async () => {
    const h = setup();
    const held = hold(h);
    say(h, 1);
    await waitFor(() => h.provider.calls.length === 1);
    const save = vi.spyOn(h.tasks, "save").mockImplementationOnce(() => { throw new Error("temporary disk marker"); });
    h.core.stop();
    expect(save).toHaveBeenCalledTimes(2);
    const sealed = onlyTask(h);
    expect(sealed.status).toBe("interrupted");
    expect(h.errors.filter((error) => error.code === "recovery_audit_failed")).toHaveLength(1);
    held.succeed();
    await flush(h);
    expect(onlyTask(h)).toEqual(sealed);
    expect(save).toHaveBeenCalledTimes(2);
    expect(h.embeddings.count("s1")).toBe(0);
  });

  it("does not call the provider when task creation cannot be persisted", async () => {
    const h = setup();
    vi.spyOn(h.tasks, "create").mockImplementationOnce(() => { throw new Error("private create marker"); });
    say(h, 1);
    await flush(h);
    expect(h.provider.calls).toHaveLength(0);
    expect(h.tasks.list("s1")).toEqual([]);
    expect(h.transcripts.allFinals("s1")).toHaveLength(1);
    expect(h.errors.map((error) => error.code)).toEqual(["recovery_audit_failed"]);
    expect(h.errors[0]?.message).not.toContain("private create marker");
  });

  it("does not call the provider when beginAttempt fails and interrupts the created task", async () => {
    const h = setup();
    vi.spyOn(h.tasks, "save").mockImplementationOnce(() => { throw new Error("temporary begin marker"); });
    say(h, 1);
    await flush(h);
    expect(h.provider.calls).toHaveLength(0);
    expect(onlyTask(h)).toMatchObject({ status: "interrupted", failureCode: "audit_failed", attempts: [] });
    expect(h.errors.map((error) => error.code)).toEqual(["recovery_audit_failed"]);
  });

  it.each(["attempt", "task"])("keeps committed vectors if %s completion metadata fails, without repeating provider work", async (stage) => {
    const h = setup();
    const originalSave = h.tasks.save.bind(h.tasks);
    let injected = false;
    vi.spyOn(h.tasks, "save").mockImplementation((task) => {
      const target = stage === "attempt" ? task.status === "running" && task.attempts[0]?.outcome === "succeeded"
        : task.status === "succeeded";
      if (!injected && target) { injected = true; throw new Error("private completion marker"); }
      originalSave(task);
    });
    say(h, 1);
    await flush(h);
    expect(injected).toBe(true);
    expect(h.embeddings.count("s1")).toBe(1);
    expect(h.core.recoveryStatus.missing).toBe(0);
    expect(h.provider.calls).toHaveLength(1);
    expect(onlyTask(h)).toMatchObject({ status: "interrupted", failureCode: "audit_failed", remaining: null });
    expect(h.errors.map((error) => error.code)).toEqual(["recovery_audit_failed"]);
    expect(h.errors[0]?.message).not.toContain("private completion marker");
  });

  it("bounds persistent stop metadata failure to two writes and lets startup seal the durable row", async () => {
    const h = setup();
    const held = hold(h);
    say(h, 1);
    await waitFor(() => h.provider.calls.length === 1);
    const save = vi.spyOn(h.tasks, "save").mockImplementation(() => { throw new Error("disk offline"); });
    h.core.stop();
    expect(save).toHaveBeenCalledTimes(2);
    expect(onlyTask(h).status).toBe("running");
    h.core.stop();
    expect(save).toHaveBeenCalledTimes(2);
    held.succeed();
    await flush(h);
    expect(save).toHaveBeenCalledTimes(2);
    expect(h.provider.calls).toHaveLength(1);
    expect(h.embeddings.count("s1")).toBe(0);
    save.mockRestore();
    expect(h.tasks.interruptRunning()).toBe(1);
    expect(onlyTask(h)).toMatchObject({ status: "interrupted", failureCode: "process_interrupted" });
  });

  it("keeps live and already queued manual tasks independent when stop interrupts both", async () => {
    const h = setup();
    const held = hold(h);
    say(h, 1);
    await waitFor(() => h.provider.calls.length === 1);
    const repair = h.core.rebuildMissing();
    expect(h.tasks.list("s1")).toHaveLength(2);
    h.core.stop();
    expect(h.tasks.list("s1").every((task) => task.status === "interrupted")).toBe(true);
    held.succeed();
    await repair;
    await flush(h);
    expect(h.provider.calls).toHaveLength(1);
    expect(h.embeddings.count("s1")).toBe(0);
    expect(h.tasks.list("s1").every((task) => task.status === "interrupted")).toBe(true);
  });

  it("retains legacy callers with no audit repository and does not audit search", async () => {
    const h = setup({ auditStore: () => undefined });
    say(h, 1);
    await flush(h);
    expect(h.embeddings.count("s1")).toBe(1);
    expect(await h.core.search("固定测试问题")).toHaveLength(1);
    expect(h.provider.calls).toHaveLength(2);
    expect(h.tasks.list("s1")).toEqual([]);
    expect(h.errors).toEqual([]);
  });
});
