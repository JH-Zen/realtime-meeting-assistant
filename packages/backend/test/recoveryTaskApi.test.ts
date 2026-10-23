import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { RecoveryTaskSchema, SessionDocumentSchema, type RecoveryTask } from "@rcc/shared";
import { createBus } from "../src/bus/eventBus.js";
import { MockLLMProvider } from "../src/llm/MockLLMProvider.js";
import type { LLMRequest, Structured } from "../src/llm/LLMProvider.js";
import { RecordingController } from "../src/recording/RecordingController.js";
import type { EmbeddingProvider } from "../src/retrieval/EmbeddingProvider.js";
import { SessionRuntime } from "../src/runtime/SessionRuntime.js";
import { createServer } from "../src/server/apiServer.js";
import { SqliteEmbeddingRepository } from "../src/store/embeddingRepository.js";
import { SqliteGraphRepository } from "../src/store/graphRepository.js";
import { SqliteQaRepository } from "../src/store/qaRepository.js";
import { SqliteRecoveryTaskRepository } from "../src/store/recoveryTaskRepository.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { openSqlite } from "../src/store/sqlite.js";
import { SqliteSummaryRepository } from "../src/store/summaryRepository.js";
import { SqliteTranscriptRepository } from "../src/store/transcriptRepository.js";
import { makeConfig, segment, silentLoopDelay, stubModules } from "./helpers.js";

type Kind = RecoveryTask["kind"];
const KINDS: Kind[] = ["retrieval", "mindmap"];
const PRIVATE_ERROR = "synthetic-private-provider-error-do-not-persist";
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing recovery task test fixture value");
  return value;
}

async function until(read: () => boolean, timeout = 2000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (read()) return;
    await wait(5);
  }
  throw new Error("Recovery task API assertion timed out");
}

/** Control model outcomes, leaving every core, ledger and coverage calculation real. */
class ModelControl {
  hold = false;
  failure = false;
  retryTwice = false;
  active = 0;
  readonly calls: unknown[] = [];
  private parked: (() => void)[] = [];

  async invoke(input: unknown): Promise<number> {
    this.calls.push(input);
    const number = this.calls.length;
    this.active++;
    try {
      if (this.hold) await new Promise<void>((done) => this.parked.push(done));
      if (this.failure || (this.retryTwice && number % 3 !== 0)) throw new Error(PRIVATE_ERROR);
      return number;
    } finally { this.active--; }
  }

  release(): void { this.hold = false; for (const done of this.parked.splice(0)) done(); }
}

class ControlledEmbedding extends ModelControl implements EmbeddingProvider {
  readonly name = "task-api-synthetic-embedding";
  readonly dim = 2;
  partialFirst = false;
  override readonly calls: string[][] = [];

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    const number = await this.invoke([...texts]);
    const values = texts.map(() => Float32Array.from([1, 0]));
    return this.partialFirst && number === 1 ? values.slice(0, 1) : values;
  }
}

class ControlledLlm extends MockLLMProvider {
  readonly control = new ModelControl();
  override async structuredGenerate<T>(request: LLMRequest, schema: z.ZodType<T>): Promise<Structured<T>> {
    if (request.task !== "mindmap") throw new Error("Unexpected non-mindmap model request in recovery test");
    const number = await this.control.invoke(request);
    return {
      data: schema.parse({ operations: [{ type: "add_node", node: {
        id: `task-node-${number}`, title: "合成补建节点", sourceTranscriptIds: [...(request.sourceSegmentIds ?? [])],
      } }] }),
      responseId: `task-response-${number}`, latencyMs: 0, inputTokens: 0, outputTokens: 0,
    };
  }
}

async function fixture(options: { audit?: boolean; batchSize?: number } = {}) {
  const db = openSqlite(":memory:");
  const bus = createBus();
  const size = options.batchSize ?? 2;
  const config = makeConfig({
    retrieval: { topK: 5, minScore: 0.01, batchSize: size, maxPending: 64 },
    mindmap: { minSegments: size, maxIntervalMs: 60_000, windowSec: 120 },
  });
  const embedding = new ControlledEmbedding();
  const llm = new ControlledLlm();
  const otherLlmCalls = [vi.spyOn(llm, "generate"), vi.spyOn(llm, "stream")];
  const recoveryTasks = new SqliteRecoveryTaskRepository(db.db);
  const store = {
    sessions: new SqliteSessionRepository(db.db), transcripts: new SqliteTranscriptRepository(db.db),
    graphs: new SqliteGraphRepository(db.db), summaries: new SqliteSummaryRepository(db.db),
    embeddings: new SqliteEmbeddingRepository(db.db), qa: new SqliteQaRepository(db.db),
    ...(options.audit === false ? {} : { recoveryTasks }),
  };
  const recording = new RecordingController(bus, store.sessions, (session) => new SessionRuntime(session, bus, config, llm, embedding, store));
  const app = await createServer({
    bus, config, recording, store, embedding,
    ...(options.audit === false ? {} : { recoveryTasks }),
    providerNames: { stt: "mock", llm: llm.name, embedding: embedding.name },
    modules: stubModules(), loopDelay: silentLoopDelay(),
  });
  const seed = (id: string, count = 1) => {
    store.sessions.create({ id, title: "合成任务测试", startedAt: 1000, endedAt: 20_000, status: "completed" });
    for (let index = 0; index < count; index++) store.transcripts.appendFinal({
      ...segment(`source-${index}`, `private-synthetic-meeting-text-${index}`, index), sessionId: id,
    });
    return required(store.sessions.get(id));
  };
  const tasks = async (id: string): Promise<RecoveryTask[]> => {
    const response = await app.inject({ url: `/api/session/${id}/recovery-tasks` });
    expect(response.statusCode).toBe(200);
    const value = response.json() as { sessionId: string; tasks: unknown[] };
    expect(value.sessionId).toBe(id);
    return value.tasks.map((task) => RecoveryTaskSchema.parse(task));
  };
  const rebuild = async (id: string, kind: Kind) => {
    const response = await app.inject({ method: "POST", url: `/api/session/${id}/${kind}/rebuild` });
    expect(response.statusCode).toBe(202);
  };
  const control = (kind: Kind): ModelControl => kind === "retrieval" ? embedding : llm.control;
  const coverage = (id: string, kind: Kind) => kind === "retrieval"
    ? store.embeddings.listOwnerIds(id, "transcript", embedding.name).size
    : store.graphs.processedSegmentIds(id).size;
  return {
    ...store, app, recording, embedding, llm, otherLlmCalls, recoveryTasks, seed, tasks, rebuild, control, coverage,
    async close() {
      embedding.release(); llm.control.release();
      await recording.stop();
      await app.close(); bus.clear();
      for (const call of otherLlmCalls) call.mockRestore();
      db.close();
    },
  };
}

type Harness = Awaited<ReturnType<typeof fixture>>;
async function settled(h: Harness, id: string, kind: Kind): Promise<RecoveryTask> {
  await until(() => !required(h.recording.current)[kind].isBusy);
  return required((await h.tasks(id)).find((task) => task.kind === kind));
}

function runningTask(id: string, sessionId: string, kind: Kind = "retrieval", at = 100): RecoveryTask {
  return RecoveryTaskSchema.parse({ id, sessionId, kind, status: "running", startedAt: at, finishedAt: null,
    initialMissing: 1, remaining: null, completedBatches: 0, failureCode: null,
    attempts: [{ batch: 1, attempt: 1, inputCount: 1, savedCount: 0, outcome: "running", startedAt: at, finishedAt: null }],
  });
}

describe("persistent explicit recovery task API", () => {
  it("returns selected-session metadata only and reads history without model work", async () => {
    const h = await fixture();
    try {
      h.recording.openHistory(h.seed("selected", 2)); h.seed("other");
      for (let index = 0; index < 12; index++) {
        const task = runningTask(`old-${index}`, "selected", "retrieval", 100 + index);
        h.recoveryTasks.create(task);
        h.recoveryTasks.save({ ...task, status: "failed", finishedAt: 200, remaining: 1, failureCode: "batch_failed",
          attempts: task.attempts.map((attempt) => ({ ...attempt, outcome: "failed", finishedAt: 200 })),
        });
      }
      const tasks = await h.tasks("selected");
      expect(tasks).toHaveLength(10);
      expect(tasks.map((task) => task.id)).toEqual(Array.from({ length: 10 }, (_, index) => `old-${11 - index}`));
      for (const id of ["other", "unknown"]) {
        const response = await h.app.inject({ url: `/api/session/${id}/recovery-tasks` });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ error: "session_changed" });
        expect(response.json()).not.toHaveProperty("tasks");
      }
      expect(h.embedding.calls).toEqual([]); expect(h.llm.control.calls).toEqual([]);
      for (const call of h.otherLlmCalls) expect(call).not.toHaveBeenCalled();
      expect(h.coverage("selected", "retrieval")).toBe(0);
      expect(h.coverage("selected", "mindmap")).toBe(0);
    } finally { await h.close(); }
  });

  it("returns 503 rather than an empty known history when the audit repository is absent or unreadable", async () => {
    const missing = await fixture({ audit: false });
    try {
      missing.recording.openHistory(missing.seed("history"));
      const response = await missing.app.inject({ url: "/api/session/history/recovery-tasks" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: "audit_unavailable" });
      expect(response.json()).not.toHaveProperty("tasks");
      expect((await missing.app.inject({ url: "/api/session/other/recovery-tasks" })).statusCode).toBe(409);
    } finally { await missing.close(); }
    const h = await fixture();
    const read = vi.spyOn(h.recoveryTasks, "list").mockImplementation(() => { throw new Error(PRIVATE_ERROR); });
    try {
      h.recording.openHistory(h.seed("history"));
      const response = await h.app.inject({ url: "/api/session/history/recovery-tasks" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: "audit_read_failed" });
      expect(response.body).not.toContain(PRIVATE_ERROR);
      expect(response.json()).not.toHaveProperty("tasks");
    } finally { read.mockRestore(); await h.close(); }
  });

  it.each(KINDS)("coalesces concurrent %s repairs, persists running attempts and retains success when reopened", async (kind) => {
    const h = await fixture();
    const control = h.control(kind); control.hold = true;
    try {
      h.recording.openHistory(h.seed("history", 3));
      await Promise.all(Array.from({ length: 5 }, () => h.rebuild("history", kind)));
      await until(() => control.calls.length === 1);
      expect(await h.tasks("history")).toHaveLength(1);
      expect(required((await h.tasks("history"))[0])).toMatchObject({ status: "running", initialMissing: 3,
        attempts: [{ batch: 1, attempt: 1, inputCount: 2, savedCount: 0, outcome: "running", finishedAt: null }],
      });
      control.release();
      const done = await settled(h, "history", kind);
      expect(done).toMatchObject({ status: "succeeded", initialMissing: 3, remaining: 0, completedBatches: 2, failureCode: null });
      expect(done.attempts.map((attempt) => [attempt.inputCount, attempt.savedCount, attempt.outcome])).toEqual([[2, 2, "succeeded"], [1, 1, "succeeded"]]);
      expect(h.coverage("history", kind)).toBe(3);
      const calls = control.calls.length;
      await h.recording.closeSession();
      h.recording.openHistory(required(h.sessions.get("history")));
      expect(await h.tasks("history")).toEqual([done]);
      await h.rebuild("history", kind);
      await until(() => !required(h.recording.current)[kind].isBusy);
      expect(await h.tasks("history")).toEqual([done]);
      expect(control.calls).toHaveLength(calls);
    } finally { await h.close(); }
  });

  it("records partial embedding progress and retries only the still-missing source", async () => {
    const h = await fixture(); h.embedding.partialFirst = true;
    try {
      h.recording.openHistory(h.seed("history", 2));
      await h.rebuild("history", "retrieval");
      const done = await settled(h, "history", "retrieval");
      expect(done).toMatchObject({ status: "succeeded", initialMissing: 2, remaining: 0, completedBatches: 1 });
      expect(done.attempts.map((attempt) => [attempt.batch, attempt.attempt, attempt.inputCount, attempt.savedCount, attempt.outcome])).toEqual([
        [1, 1, 2, 1, "incomplete"], [1, 2, 1, 1, "succeeded"],
      ]);
      expect(h.embedding.calls[1]).toEqual([required(h.transcripts.listFinal("history")[1]).text]);
      expect(h.coverage("history", "retrieval")).toBe(2);
    } finally { await h.close(); }
  });

  it.each(KINDS)("keeps failed %s history stable, records three attempts and never persists raw provider errors or meeting text", async (kind) => {
    const h = await fixture(); h.control(kind).failure = true;
    try {
      h.recording.openHistory(h.seed("history", 2));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await h.rebuild("history", kind); await vi.runAllTimersAsync();
      const task = await settled(h, "history", kind);
      expect(task).toMatchObject({ status: "failed", initialMissing: 2, remaining: 2, completedBatches: 0, failureCode: "batch_failed" });
      expect(task.attempts.map((attempt) => [attempt.batch, attempt.attempt, attempt.inputCount, attempt.savedCount, attempt.outcome])).toEqual([
        [1, 1, 2, 0, "failed"], [1, 2, 2, 0, "failed"], [1, 3, 2, 0, "failed"],
      ]);
      expect(JSON.stringify(task)).not.toContain(PRIVATE_ERROR);
      expect(JSON.stringify(task)).not.toContain("private-synthetic-meeting-text");
      await h.tasks("history"); await vi.runAllTimersAsync();
      expect(h.control(kind).calls).toHaveLength(3);
      expect(h.coverage("history", kind)).toBe(0);
      expect(await h.tasks("history")).toEqual([task]);
    } finally { vi.useRealTimers(); await h.close(); }
  });

  it.each(KINDS)("caps %s at eight batches and 24 attempts while reporting unfinished source honestly", async (kind) => {
    const h = await fixture({ batchSize: 1 }); h.control(kind).retryTwice = true;
    try {
      h.recording.openHistory(h.seed("history", 9));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await h.rebuild("history", kind); await vi.runAllTimersAsync();
      const task = await settled(h, "history", kind);
      expect(task).toMatchObject({ status: "incomplete", initialMissing: 9, remaining: 1, completedBatches: 8, failureCode: null });
      expect(task.attempts).toHaveLength(24);
      expect(task.attempts.at(-1)).toMatchObject({ batch: 8, attempt: 3, outcome: "succeeded" });
      expect(h.control(kind).calls).toHaveLength(24);
      expect(h.coverage("history", kind)).toBe(8);
      await h.tasks("history"); await vi.runAllTimersAsync();
      expect(h.control(kind).calls).toHaveLength(24);
    } finally { vi.useRealTimers(); await h.close(); }
  });

  it.each(KINDS)("seals a held %s task immediately on selection change and refuses both late success and late rejection", async (kind) => {
    for (const reject of [false, true]) {
      const h = await fixture(); const control = h.control(kind); control.hold = true;
      try {
        h.recording.openHistory(h.seed("previous", 2)); h.seed("next", 1);
        const previous = required(h.recording.current);
        await h.rebuild("previous", kind);
        await until(() => control.calls.length === 1);
        expect((await h.app.inject({ method: "POST", url: "/api/session/next/open" })).statusCode).toBe(200);
        const sealed = required(h.recoveryTasks.list("previous")[0]);
        expect(sealed).toMatchObject({ status: "interrupted", failureCode: "cancelled", remaining: null,
          attempts: [{ outcome: "interrupted", inputCount: 2, savedCount: 0 }],
        });
        expect(control.active).toBe(1);
        expect(await h.tasks("next")).toEqual([]);
        control.failure = reject; control.release();
        await until(() => control.active === 0 && !previous[kind].isBusy);
        expect(h.recoveryTasks.list("previous")).toEqual([sealed]);
        expect(h.coverage("previous", kind)).toBe(0); expect(h.coverage("next", kind)).toBe(0);
        expect(control.calls).toHaveLength(1);
        expect((await h.app.inject({ url: "/api/session/previous/recovery-tasks" })).statusCode).toBe(409);
      } finally { await h.close(); }
    }
  });

  it.each(KINDS)("creates %s task before the first await and can interrupt it before any model request", async (kind) => {
    const h = await fixture();
    try {
      h.recording.openHistory(h.seed("history"));
      const runtime = required(h.recording.current);
      const job = runtime[kind].rebuildMissing();
      const before = h.recoveryTasks.list("history");
      expect(before).toHaveLength(1); expect(before[0]).toMatchObject({ status: "running", attempts: [] });
      runtime.dispose();
      const interrupted = required(h.recoveryTasks.list("history")[0]);
      expect(interrupted).toMatchObject({ status: "interrupted", failureCode: "cancelled", attempts: [] });
      await job;
      expect(h.recoveryTasks.list("history")).toEqual([interrupted]);
      expect(h.control(kind).calls).toEqual([]);
    } finally { await h.close(); }
  });

  it.each(KINDS)("does not leave %s falsely running after a transient attempt-audit save error", async (kind) => {
    const h = await fixture();
    const original = h.recoveryTasks.save.bind(h.recoveryTasks);
    let injected = false;
    const save = vi.spyOn(h.recoveryTasks, "save").mockImplementation((task) => {
      if (!injected && task.status === "running" && task.attempts.at(-1)?.outcome === "succeeded") {
        injected = true; throw new Error("synthetic temporary audit write failure");
      }
      original(task);
    });
    try {
      h.recording.openHistory(h.seed("history"));
      await h.rebuild("history", kind);
      await until(() => !required(h.recording.current)[kind].isBusy);
      expect(injected).toBe(true);
      expect(h.coverage("history", kind)).toBe(1);
      expect(h.control(kind).calls).toHaveLength(1);
      const task = required((await h.tasks("history"))[0]);
      expect(task.status).not.toBe("running");
      expect(task.attempts.every((attempt) => attempt.outcome !== "running")).toBe(true);
    } finally { save.mockRestore(); await h.close(); }
  });

  it.each(KINDS)("does not expose cancelled %s work as running after one transient interruption-save failure", async (kind) => {
    const h = await fixture(); const control = h.control(kind); control.hold = true;
    const original = h.recoveryTasks.save.bind(h.recoveryTasks);
    let injected = false;
    let interruptionWrites = 0;
    const save = vi.spyOn(h.recoveryTasks, "save").mockImplementation((task) => {
      if (task.status === "interrupted") {
        interruptionWrites++;
        if (!injected) { injected = true; throw new Error("synthetic one-time cancellation write failure"); }
      }
      original(task);
    });
    try {
      h.recording.openHistory(h.seed("history"));
      const previous = required(h.recording.current);
      await h.rebuild("history", kind);
      await until(() => control.calls.length === 1);
      await h.recording.closeSession();
      expect(injected).toBe(true);
      expect(interruptionWrites).toBe(2); // First write plus exactly one metadata-only fallback.
      control.release();
      await until(() => control.active === 0 && !previous[kind].isBusy);
      h.recording.openHistory(required(h.sessions.get("history")));
      const task = required((await h.tasks("history"))[0]);
      expect(task.status).not.toBe("running");
      expect(task.attempts.every((attempt) => attempt.outcome !== "running")).toBe(true);
      expect(h.coverage("history", kind)).toBe(0);
      expect(control.calls).toHaveLength(1);
      expect(interruptionWrites).toBe(2); // A late model result cannot trigger further writes.
    } finally { save.mockRestore(); await h.close(); }
  });

  it("keeps machine-local task history out of exports and never imports another copy's task history", async () => {
    const h = await fixture();
    try {
      h.recording.openHistory(h.seed("source", 2));
      await h.rebuild("source", "retrieval"); const task = await settled(h, "source", "retrieval");
      const exported = await h.app.inject({ url: "/api/session/source/export" });
      expect(exported.statusCode).toBe(200);
      const raw = exported.json() as Record<string, unknown>;
      expect(raw).not.toHaveProperty("recoveryTasks"); expect(raw).not.toHaveProperty("tasks");
      expect(exported.body).not.toContain(task.id);
      const document = SessionDocumentSchema.parse(raw);
      // Even hand-added foreign operational fields are not a persistence contract.
      const imported = await h.app.inject({ method: "POST", url: "/api/session/import", payload: { ...document, recoveryTasks: [task], tasks: [task] } });
      expect(imported.statusCode).toBe(201);
      const id = (imported.json() as { sessionId: string }).sessionId;
      expect(id).not.toBe("source"); expect(await h.tasks(id)).toEqual([]);
      expect(h.recoveryTasks.list("source")).toEqual([task]);
      expect(h.embedding.calls.length).toBeGreaterThan(1); // Explicit import retains existing re-index behavior.
    } finally { await h.close(); }
  });

  it("interrupts orphaned tasks for every session at real backend startup without automatically requesting recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rcc-补建任务 startup-"));
    const dbPath = join(dir, "会议 数据.sqlite");
    const seed = openSqlite(dbPath);
    try {
      const sessions = new SqliteSessionRepository(seed.db);
      const transcripts = new SqliteTranscriptRepository(seed.db);
      const tasks = new SqliteRecoveryTaskRepository(seed.db);
      for (const id of ["selected", "unselected"]) {
        sessions.create({ id, startedAt: 1, endedAt: 2, status: "completed" });
        transcripts.appendFinal({ ...segment("saved-text", "合成启动保留原文", 0), sessionId: id });
        tasks.create(runningTask(`orphan-${id}`, id));
      }
      sessions.select("selected");
    } finally { seed.close(); }
    const instanceId = randomUUID(); const token = randomUUID();
    const child = fork(fileURLToPath(new URL("../src/index.ts", import.meta.url)), [], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)), execArgv: ["--import", "tsx"], silent: true,
      env: { ...process.env, RCC_DESKTOP_INSTANCE: instanceId, RCC_DESKTOP_TOKEN: token,
        RCC_DESKTOP_DATA_ROOT: dir, RCC_CONFIG_FILE: join(dir, "no-config.env"), DB_PATH: dbPath,
        STATIC_DIR: join(dir, "no-static"), HOST: "127.0.0.1", PORT: "0", MOCK_STT: "true", MOCK_LLM: "true",
        MOCK_EMBEDDING: "true", LLM_API_KEY: "", EMBED_MODEL_DIR: join(dir, "no-models"),
      },
    });
    let output = "";
    child.stdout?.on("data", (data) => { output = `${output}${String(data)}`.slice(-12_000); });
    child.stderr?.on("data", (data) => { output = `${output}${String(data)}`.slice(-12_000); });
    try {
      const url = await new Promise<string>((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`Backend startup timed out: ${output}`)), 8000);
        child.on("message", (raw: unknown) => {
          if (!raw || typeof raw !== "object") return;
          const message = raw as { type?: string; instanceId?: string; url?: string; pid?: number };
          if (message.type === "rcc.ready" && message.instanceId === instanceId && message.pid === child.pid && message.url) {
            clearTimeout(timer); done(message.url);
          }
        });
        child.once("error", (error) => { clearTimeout(timer); fail(error); });
        child.once("exit", (code) => { clearTimeout(timer); fail(new Error(`Backend exited ${code}: ${output}`)); });
      });
      const headers = { "x-rcc-desktop": token };
      for (const id of ["selected", "unselected"]) {
        if (id !== "selected") expect((await fetch(`${url}/api/session/${id}/open`, { method: "POST", headers })).status).toBe(200);
        const response = await fetch(`${url}/api/session/${id}/recovery-tasks`, { headers });
        expect(response.status).toBe(200);
        const tasks = (await response.json() as { tasks: unknown[] }).tasks.map((task) => RecoveryTaskSchema.parse(task));
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toMatchObject({ id: `orphan-${id}`, status: "interrupted", failureCode: "process_interrupted", remaining: null,
          attempts: [{ outcome: "interrupted", inputCount: 1, savedCount: 0 }],
        });
        const retrieval = await fetch(`${url}/api/session/${id}/retrieval`, { headers });
        expect(await retrieval.json()).toMatchObject({ total: 1, indexed: 0, missing: 1, busy: false });
        const map = await fetch(`${url}/api/session/${id}/mindmap/recovery`, { headers });
        expect(await map.json()).toMatchObject({ total: 1, processed: 0, missing: 1, busy: false });
      }
      await shutdown(child, instanceId);
      expect(child.exitCode).toBe(0);
      expect(child.signalCode).toBe(null);
      const reopened = openSqlite(dbPath);
      try {
        const tasks = new SqliteRecoveryTaskRepository(reopened.db);
        expect(tasks.list("selected")[0]?.failureCode).toBe("process_interrupted");
        expect(tasks.list("unselected")[0]?.failureCode).toBe("process_interrupted");
      } finally { reopened.close(); }
    } finally {
      await shutdown(child, instanceId);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 12_000);
});

async function shutdown(child: ChildProcess, instanceId: string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.send({ type: "rcc.shutdown", instanceId });
  const stopped = await new Promise<boolean>((done) => {
    const timer = setTimeout(() => done(false), 2500);
    child.once("exit", () => { clearTimeout(timer); done(true); });
  });
  if (!stopped) {
    // Exact owned handle only. Never enumerate or terminate unrelated backend or worker processes.
    child.kill();
    await new Promise<void>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
      child.once("exit", () => done());
    });
  }
}
