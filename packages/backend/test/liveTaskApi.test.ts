import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecoveryTaskSchema, type RecoveryTask } from "@rcc/shared";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { createBus } from "../src/bus/eventBus.js";
import type { LLMRequest, Structured } from "../src/llm/LLMProvider.js";
import { MockLLMProvider } from "../src/llm/MockLLMProvider.js";
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
type Scope = "all" | "manual" | "live";
const KINDS: Kind[] = ["retrieval", "mindmap"];
const PRIVATE_TEXT = "private-synthetic-live-transcript-body";
const PRIVATE_ERROR = "private-synthetic-live-provider-error";
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing live task fixture value");
  return value;
}
async function until(read: () => boolean, timeout = 2500): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (read()) return; await wait(5); }
  throw new Error("Live task integration assertion timed out");
}

/** Only model behavior is substituted. Recording, bus, cores, SQLite and HTTP remain real. */
class Control {
  hold = false;
  fail = false;
  active = 0;
  count = 0;
  beforeCall: (() => void) | null = null;
  private parked: (() => void)[] = [];
  async invoke(): Promise<number> {
    this.count++;
    this.beforeCall?.();
    this.active++;
    try {
      if (this.hold) await new Promise<void>((done) => this.parked.push(done));
      if (this.fail) throw new Error(PRIVATE_ERROR);
      return this.count;
    } finally { this.active--; }
  }
  release(): void { this.hold = false; for (const done of this.parked.splice(0)) done(); }
}
class Embedding extends Control implements EmbeddingProvider {
  readonly name = "live-api-synthetic-embedding";
  readonly dim = 2;
  partial = false;
  invalid = false;
  readonly inputs: string[][] = [];
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.inputs.push([...texts]);
    await this.invoke();
    const rows = texts.map(() => Float32Array.from(this.invalid ? [Number.NaN, 1] : [1, 0]));
    return this.partial ? rows.slice(0, 1) : rows;
  }
}
class Llm extends MockLLMProvider {
  readonly control = new Control();
  partial = false;
  readonly inputs: LLMRequest[] = [];
  readonly requests: LLMRequest[] = [];
  override async structuredGenerate<T>(request: LLMRequest, schema: z.ZodType<T>): Promise<Structured<T>> {
    this.requests.push(request);
    if (request.task !== "mindmap") return super.structuredGenerate(request, schema);
    this.inputs.push(request);
    const number = await this.control.invoke();
    const operations: unknown[] = [{ type: "add_node", node: {
      id: `live-node-${number}`, title: "合成实时节点", sourceTranscriptIds: [...(request.sourceSegmentIds ?? [])],
    } }];
    if (this.partial) operations.push({ type: "add_node", node: {
      id: `bad-node-${number}`, title: "合成非法父节点", parentId: "nonexistent-parent",
      sourceTranscriptIds: [...(request.sourceSegmentIds ?? [])],
    } });
    return { data: schema.parse({ operations }), responseId: `live-response-${number}`, latencyMs: 0, inputTokens: 0, outputTokens: 0 };
  }
}

async function fixture(options: { dbPath?: string; speed?: number; maxPending?: number; mindmapMinSegments?: number } = {}) {
  const db = openSqlite(options.dbPath ?? ":memory:");
  const bus = createBus();
  const config = makeConfig({
    mockSttSpeed: options.speed ?? 0.001,
    retrieval: { topK: 5, minScore: 0.01, batchSize: 2, maxPending: options.maxPending ?? 64 },
    mindmap: { minSegments: options.mindmapMinSegments ?? 2, maxIntervalMs: 60_000, windowSec: 120 },
    memory: { windowSec: 3000, mergeFactor: 3, minSegments: 1000, maxLevel: 2 },
  });
  const embedding = new Embedding(); const llm = new Llm();
  const recoveryTasks = new SqliteRecoveryTaskRepository(db.db);
  const store = {
    sessions: new SqliteSessionRepository(db.db), transcripts: new SqliteTranscriptRepository(db.db),
    graphs: new SqliteGraphRepository(db.db), summaries: new SqliteSummaryRepository(db.db),
    embeddings: new SqliteEmbeddingRepository(db.db), qa: new SqliteQaRepository(db.db), recoveryTasks,
  };
  const recording = new RecordingController(bus, store.sessions,
    (session) => new SessionRuntime(session, bus, config, llm, embedding, store));
  const app = await createServer({ bus, config, recording, store, embedding, recoveryTasks,
    providerNames: { stt: "mock", llm: llm.name, embedding: embedding.name }, modules: stubModules(), loopDelay: silentLoopDelay() });
  const tasks = async (id: string, scope?: Scope): Promise<RecoveryTask[]> => {
    const response = await app.inject({ url: `/api/session/${id}/recovery-tasks${scope ? `?scope=${scope}` : ""}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty("sessionId", id);
    return (response.json() as { tasks: unknown[] }).tasks.map((row) => RecoveryTaskSchema.parse(row));
  };
  const start = async () => {
    const id = await recording.start("mock"); recording.pause(); return id;
  };
  const emit = (id: string, count = 2, offset = 0) => {
    const runtime = required(recording.current);
    for (let index = offset; index < offset + count; index++) runtime.transcript.acceptFinal({
      ...segment(`source-${index}`, `${PRIVATE_TEXT}-${index}`, index), sessionId: id,
    });
  };
  const control = (kind: Kind): Control => kind === "retrieval" ? embedding : llm.control;
  const covered = (id: string, kind: Kind) => kind === "retrieval"
    ? store.embeddings.listOwnerIds(id, "transcript", embedding.name).size
    : store.graphs.processedSegmentIds(id).size;
  return {
    ...store, bus, app, recording, embedding, llm, tasks, start, emit, control, covered,
    async idle() {
      await until(() => embedding.active === 0 && llm.control.active === 0 &&
        !required(recording.current).retrieval.isBusy && !required(recording.current).mindmap.isBusy);
    },
    async close() {
      embedding.release(); llm.control.release();
      await recording.stop(); await app.close(); bus.clear(); db.close();
    },
  };
}
type Harness = Awaited<ReturnType<typeof fixture>>;
async function taskFor(h: Harness, id: string, kind: Kind): Promise<RecoveryTask> {
  await h.idle(); return required((await h.tasks(id, "live")).find((task) => task.kind === kind));
}
function seedTask(h: Harness, id: string, sessionId: string, trigger: "manual" | "live" | undefined, at: number): RecoveryTask {
  const running = RecoveryTaskSchema.parse({ id, sessionId, kind: "retrieval", status: "running", startedAt: at, finishedAt: null,
    initialMissing: 1, remaining: null, completedBatches: 0, failureCode: null, attempts: [],
    ...(trigger ? { trigger } : {}), ...(trigger === "live" ? { sourceSegmentIds: [`source-${id}`] } : {}),
  });
  h.recoveryTasks.create(running);
  const done: RecoveryTask = { ...running, status: "failed", finishedAt: at + 1, failureCode: "batch_failed", remaining: 1 };
  h.recoveryTasks.save(done); return done;
}

describe("live task audit through recording, SQLite and HTTP", () => {
  it("records actual mock STT callbacks before provider calls, without a manual rebuild or user text in the ledger", async () => {
    const h = await fixture({ speed: 1000 }); h.embedding.hold = true; h.llm.control.hold = true;
    const seen = new Set<Kind>();
    for (const kind of KINDS) h.control(kind).beforeCall = () => {
      const id = required(h.recording.sessionId);
      const running = required(h.recoveryTasks.list(id).find((task) => task.kind === kind && task.status === "running"));
      expect(running).toMatchObject({ trigger: "live", attempts: [{ batch: 1, attempt: 1, outcome: "running" }] });
      expect(running.sourceSegmentIds?.length).toBe(running.initialMissing); seen.add(kind);
    };
    try {
      const id = await h.recording.start("mock");
      await until(() => seen.size === 2); h.recording.pause();
      expect(h.recording.state).toBe("paused");
      const finals = h.transcripts.listFinal(id);
      expect(finals.length).toBeGreaterThanOrEqual(2);
      const ids = new Set(finals.map((row) => row.id));
      const running = await h.tasks(id, "live");
      expect(running.length).toBeGreaterThanOrEqual(2);
      for (const task of running) {
        expect(task.sourceSegmentIds?.every((source) => ids.has(source))).toBe(true);
        for (const final of finals) expect(JSON.stringify(task)).not.toContain(final.text);
      }
      h.embedding.beforeCall = null; h.llm.control.beforeCall = null;
      h.embedding.release(); h.llm.control.release();
      await h.idle(); await required(h.recording.current).mindmap.flush(); await h.idle();
      expect((await h.tasks(id, "live")).every((task) => task.status === "succeeded")).toBe(true);
      expect(await h.tasks(id, "manual")).toEqual([]);
    } finally { await h.close(); }
  });

  it("persists exact stable source IDs and coverage for each successful live batch", async () => {
    const h = await fixture();
    try {
      const id = await h.start(); h.emit(id); await until(() => h.embedding.count > 0 && h.llm.control.count > 0); await h.idle();
      const tasks = await h.tasks(id);
      expect(tasks).toHaveLength(2);
      for (const kind of KINDS) {
        const task = required(tasks.find((row) => row.kind === kind));
        expect(task).toMatchObject({ trigger: "live", sourceSegmentIds: ["source-0", "source-1"], status: "succeeded", initialMissing: 2,
          remaining: 0, completedBatches: 1, failureCode: null, attempts: [{ inputCount: 2, savedCount: 2, outcome: "succeeded" }] });
        expect(h.covered(id, kind)).toBe(2);
      }
      const before = tasks;
      h.emit(id); await wait(20);
      expect(await h.tasks(id)).toEqual(before); // Transcript redelivery does not create another model request or task.
      expect(h.embedding.count).toBe(1); expect(h.llm.control.count).toBe(1);
      expect(JSON.stringify(tasks)).not.toContain(PRIVATE_TEXT);
    } finally { await h.close(); }
  });

  it.each(KINDS)("records one failed live %s call without automatic retries or private error persistence", async (kind) => {
    const h = await fixture(); h.control(kind).fail = true;
    try {
      const id = await h.start(); h.emit(id); await until(() => h.control(kind).count > 0);
      const task = await taskFor(h, id, kind);
      expect(task).toMatchObject({ trigger: "live", status: "failed", failureCode: "batch_failed", remaining: 2,
        sourceSegmentIds: ["source-0", "source-1"], attempts: [{ inputCount: 2, savedCount: 0, outcome: "failed" }] });
      expect(h.covered(id, kind)).toBe(0);
      expect(JSON.stringify(task)).not.toContain(PRIVATE_ERROR); expect(JSON.stringify(task)).not.toContain(PRIVATE_TEXT);
      await h.tasks(id, "all"); await wait(30);
      expect(h.control(kind).count).toBe(1); expect(await taskFor(h, id, kind)).toEqual(task);
    } finally { await h.close(); }
  });

  it("retains pre-existing long source IDs verbatim without silently blocking live processing", async () => {
    const h = await fixture();
    try {
      const id = await h.start();
      const ids = [`长源标识-${"x".repeat(160)}`, `long-source-${"y".repeat(160)}`];
      for (const [index, sourceId] of ids.entries()) required(h.recording.current).transcript.acceptFinal({
        ...segment(sourceId, `${PRIVATE_TEXT}-${index}`, index), sessionId: id,
      });
      await until(() => h.embedding.count > 0 && h.llm.control.count > 0); await h.idle();
      for (const kind of KINDS) {
        expect(await taskFor(h, id, kind)).toMatchObject({ trigger: "live", status: "succeeded", sourceSegmentIds: ids });
        expect(h.covered(id, kind)).toBe(2);
      }
      expect(h.transcripts.listFinal(id).map((row) => row.id)).toEqual(ids);
    } finally { await h.close(); }
  });

  it("keeps partial live embedding coverage distinct from full success and does not retry it silently", async () => {
    const h = await fixture(); h.embedding.partial = true;
    try {
      const id = await h.start(); h.emit(id); await until(() => h.embedding.count > 0);
      const task = await taskFor(h, id, "retrieval");
      expect(task.status).not.toBe("succeeded"); expect(task.status).not.toBe("running");
      expect(task).toMatchObject({ status: "incomplete", failureCode: "incomplete_output", remaining: 1, initialMissing: 2,
        attempts: [{ inputCount: 2, savedCount: 1, outcome: "incomplete" }] });
      expect(h.covered(id, "retrieval")).toBe(1); await wait(30); expect(h.embedding.count).toBe(1);
    } finally { await h.close(); }
  });

  it("records partially applied live graphs without claiming either source segment was fully processed", async () => {
    const h = await fixture(); h.llm.partial = true;
    try {
      const id = await h.start(); h.emit(id); await until(() => h.llm.control.count > 0);
      const task = await taskFor(h, id, "mindmap");
      expect(task.status).not.toBe("succeeded"); expect(task.status).not.toBe("running");
      expect(task).toMatchObject({ status: "incomplete", failureCode: "partial_graph", remaining: 2, attempts: [{ inputCount: 2, savedCount: 0, outcome: "incomplete" }] });
      expect(h.graphs.loadNodes(id)).toHaveLength(1); expect(h.covered(id, "mindmap")).toBe(0);
      const status = await h.app.inject({ url: `/api/session/${id}/mindmap/recovery` });
      expect(status.json()).toMatchObject({ processed: 0, missing: 2, legacyUntracked: true });
      await wait(30); expect(h.llm.control.count).toBe(1);
    } finally { await h.close(); }
  });

  it("refuses nonfinite embedding output without persisting it as successful coverage", async () => {
    const h = await fixture(); h.embedding.invalid = true;
    try {
      const id = await h.start(); h.emit(id); await until(() => h.embedding.count > 0);
      const task = await taskFor(h, id, "retrieval");
      expect(task).toMatchObject({ status: "failed", failureCode: "invalid_output", remaining: 2,
        attempts: [{ savedCount: 0, outcome: "failed" }] });
      expect(h.covered(id, "retrieval")).toBe(0);
      expect(h.embeddings.scan(id, "transcript", h.embedding.name, 2)).toEqual([]);
    } finally { await h.close(); }
  });

  it("filters scope before the ten-row limit, preserves old unknown fields and isolates selected sessions", async () => {
    const h = await fixture();
    try {
      const id = await h.start();
      const old = seedTask(h, "old-manual", id, undefined, 1);
      const manual = seedTask(h, "known-manual", id, "manual", 2);
      for (let index = 0; index < 13; index++) seedTask(h, `live-${index}`, id, "live", 100 + index);
      const selectedManual = await h.tasks(id, "manual");
      expect(selectedManual).toEqual([manual, old]);
      expect(required(selectedManual[1])).not.toHaveProperty("trigger"); expect(required(selectedManual[1])).not.toHaveProperty("sourceSegmentIds");
      const live = await h.tasks(id, "live");
      expect(live).toHaveLength(10); expect(live.every((task) => task.trigger === "live")).toBe(true);
      expect(live.map((task) => task.id)).toEqual(Array.from({ length: 10 }, (_, index) => `live-${12 - index}`));
      expect(await h.tasks(id)).toEqual(live); expect(await h.tasks(id, "all")).toEqual(live);
      expect((await h.app.inject({ url: `/api/session/${id}/recovery-tasks?scope=unknown` })).statusCode).toBe(400);
      for (const scope of ["all", "manual", "live"]) {
        const denied = await h.app.inject({ url: `/api/session/another/recovery-tasks?scope=${scope}` });
        expect(denied.statusCode).toBe(409); expect(denied.json()).not.toHaveProperty("tasks");
      }
      expect(h.embedding.count).toBe(0); expect(h.llm.control.count).toBe(0);
      expect(h.llm.requests).toEqual([]);
    } finally { await h.close(); }
  });

  it.each(KINDS)("seals held live %s metadata before a late success or rejection can write", async (kind) => {
    for (const reject of [false, true]) {
      const h = await fixture(); h.control(kind).hold = true;
      try {
        const id = await h.start(); h.emit(id); await until(() => h.control(kind).active === 1);
        const runtime = required(h.recording.current); runtime.dispose();
        const sealed = required((await h.tasks(id, "live")).find((task) => task.kind === kind));
        expect(sealed).toMatchObject({ status: "interrupted", failureCode: "cancelled", remaining: null,
          sourceSegmentIds: ["source-0", "source-1"], attempts: [{ outcome: "interrupted", savedCount: 0 }] });
        h.control(kind).fail = reject; h.control(kind).release();
        await until(() => h.control(kind).active === 0 && !runtime[kind].isBusy);
        expect(required((await h.tasks(id, "live")).find((task) => task.kind === kind))).toEqual(sealed);
        expect(h.covered(id, kind)).toBe(0); expect(h.control(kind).count).toBe(1);
      } finally { await h.close(); }
    }
  });

  it.each(KINDS)("does not issue a live %s provider request when its audit creation fails", async (kind) => {
    const h = await fixture();
    const create = h.recoveryTasks.create.bind(h.recoveryTasks);
    const fault = vi.spyOn(h.recoveryTasks, "create").mockImplementation((task) => {
      if (task.kind === kind) throw new Error(PRIVATE_ERROR);
      create(task);
    });
    try {
      const id = await h.start(); h.emit(id); await wait(30); await h.idle();
      expect(h.control(kind).count).toBe(0); expect(h.covered(id, kind)).toBe(0);
      expect(h.transcripts.listFinal(id)).toHaveLength(2);
      expect((await h.tasks(id, "live")).filter((task) => task.kind === kind)).toEqual([]);
    } finally { fault.mockRestore(); await h.close(); }
  });

  it("preserves committed live graph coverage when the first attempt-finish audit write fails", async () => {
    const h = await fixture();
    const save = h.recoveryTasks.save.bind(h.recoveryTasks);
    let injected = false;
    const fault = vi.spyOn(h.recoveryTasks, "save").mockImplementation((task) => {
      if (!injected && task.trigger === "live" && task.kind === "mindmap" && task.status === "running" && task.attempts.at(-1)?.outcome === "succeeded") {
        injected = true; throw new Error(PRIVATE_ERROR);
      }
      save(task);
    });
    try {
      const id = await h.start(); h.emit(id); await until(() => h.llm.control.count === 1); await h.idle();
      expect(injected).toBe(true);
      expect(h.graphs.loadNodes(id)).toHaveLength(1);
      expect(h.covered(id, "mindmap")).toBe(2);
      const task = await taskFor(h, id, "mindmap");
      expect(task).toMatchObject({ trigger: "live", status: "interrupted", failureCode: "audit_failed", remaining: null,
        sourceSegmentIds: ["source-0", "source-1"], attempts: [{ outcome: "interrupted" }] });
      expect(JSON.stringify(task)).not.toContain(PRIVATE_ERROR);
      const response = await h.app.inject({ url: `/api/session/${id}/mindmap/recovery` });
      expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ processed: 2, missing: 0 });
      await wait(30);
      expect(h.llm.control.count).toBe(1);
      expect(await taskFor(h, id, "mindmap")).toEqual(task);
      expect(h.graphs.loadNodes(id)).toHaveLength(1); expect(h.covered(id, "mindmap")).toBe(2);
    } finally { fault.mockRestore(); await h.close(); }
  });

  it("makes exactly two metadata writes after a transient live mindmap stop-save failure and rejects late output", async () => {
    const h = await fixture(); h.llm.control.hold = true;
    const save = h.recoveryTasks.save.bind(h.recoveryTasks);
    let injected = false;
    let stopping = false;
    const afterStopWrites: RecoveryTask[] = [];
    const fault = vi.spyOn(h.recoveryTasks, "save").mockImplementation((task) => {
      if (stopping && task.trigger === "live" && task.kind === "mindmap") afterStopWrites.push(structuredClone(task));
      if (!injected && task.trigger === "live" && task.kind === "mindmap" && task.status === "interrupted") {
        injected = true; throw new Error(PRIVATE_ERROR);
      }
      save(task);
    });
    try {
      const id = await h.start(); h.emit(id); await until(() => h.llm.control.active === 1);
      const runtime = required(h.recording.current);
      stopping = true; runtime.mindmap.stop();
      expect(injected).toBe(true); expect(afterStopWrites).toHaveLength(2);
      expect(afterStopWrites.map((task) => task.status)).toEqual(["interrupted", "interrupted"]);
      const sealed = required((await h.tasks(id, "live")).find((task) => task.kind === "mindmap"));
      expect(sealed).toMatchObject({ status: "interrupted", failureCode: "cancelled", remaining: null,
        attempts: [{ outcome: "interrupted", savedCount: 0 }] });
      expect(h.llm.control.active).toBe(1);
      h.llm.control.release(); await h.idle();
      expect(afterStopWrites).toHaveLength(2); // Exactly one metadata-only fallback, no write from the late response.
      expect(await taskFor(h, id, "mindmap")).toEqual(sealed);
      expect(h.llm.control.count).toBe(1);
      expect(h.graphs.loadNodes(id)).toEqual([]); expect(h.covered(id, "mindmap")).toBe(0);
      runtime.mindmap.stop(); expect(afterStopWrites).toHaveLength(2); // Repeated stop is also idempotent.
    } finally { fault.mockRestore(); await h.close(); }
  });

  it("flushes 513 buffered unique live source segments in 512-plus-one batches without losing the tail", async () => {
    const h = await fixture({ mindmapMinSegments: 1000 });
    try {
      const id = await h.start(); const runtime = required(h.recording.current);
      runtime.retrieval.stop(); // This boundary test exercises the real map buffer, not hundreds of unrelated embedding calls.
      h.emit(id, 513); await until(() => runtime.mindmap.pendingCount === 513);
      expect(h.llm.control.count).toBe(0);
      await runtime.mindmap.flush(); await h.idle();
      expect(h.llm.control.count).toBe(2);
      expect(h.llm.inputs.map((request) => request.sourceSegmentIds?.length)).toEqual([512, 1]);
      expect(h.llm.inputs[1]?.sourceSegmentIds).toEqual(["source-512"]);
      const tasks = (await h.tasks(id, "live")).filter((task) => task.kind === "mindmap");
      expect(tasks).toHaveLength(2);
      expect(tasks.every((task) => task.status === "succeeded" && task.remaining === 0)).toBe(true);
      expect(tasks.map((task) => task.initialMissing).sort((a, b) => a - b)).toEqual([1, 512]);
      const sources = tasks.flatMap((task) => task.sourceSegmentIds ?? []);
      expect(sources).toHaveLength(513); expect(new Set(sources).size).toBe(513);
      expect(new Set(sources)).toEqual(new Set(Array.from({ length: 513 }, (_, index) => `source-${index}`)));
      expect(runtime.mindmap.pendingCount).toBe(0);
      expect(h.transcripts.listFinal(id)).toHaveLength(513);
      expect(h.covered(id, "mindmap")).toBe(513); expect(h.graphs.loadNodes(id)).toHaveLength(2);
      expect(h.embedding.count).toBe(0);
    } finally { await h.close(); }
  });

  it("reopens a file-backed failed live history read-only and keeps operational IDs out of exports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rcc-实时任务 中文 path-"));
    const dbPath = join(dir, "会议 数据.sqlite");
    let h: Harness | null = await fixture({ dbPath });
    try {
      h.embedding.fail = true; h.llm.control.fail = true;
      const id = await h.start(); h.emit(id); await until(() => required(h).embedding.count > 0 && required(h).llm.control.count > 0); await h.idle();
      const before = await h.tasks(id, "live"); expect(before).toHaveLength(2);
      await h.close(); h = null;
      h = await fixture({ dbPath });
      expect(h.recording.restoreSelected()).toBe(true);
      expect(h.recording.state).toBe("viewing"); expect(await h.tasks(id, "live")).toEqual(before);
      await wait(30); expect(h.embedding.count).toBe(0); expect(h.llm.control.count).toBe(0);
      expect(h.llm.requests).toEqual([]); // Includes summaries as well as mindmap structured requests.
      const exported = await h.app.inject({ url: `/api/session/${id}/export` });
      expect(exported.statusCode).toBe(200); expect(exported.json()).not.toHaveProperty("recoveryTasks");
      expect(exported.json()).not.toHaveProperty("tasks");
      for (const task of before) expect(exported.body).not.toContain(task.id);
      expect(h.transcripts.listFinal(id)).toHaveLength(2);
    } finally { if (h) await h.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
