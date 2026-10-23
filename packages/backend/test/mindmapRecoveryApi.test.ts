import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { ModuleError } from "@rcc/shared";
import { createBus } from "../src/bus/eventBus.js";
import { RecordingController } from "../src/recording/RecordingController.js";
import { SessionRuntime } from "../src/runtime/SessionRuntime.js";
import { openSqlite } from "../src/store/sqlite.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { SqliteTranscriptRepository } from "../src/store/transcriptRepository.js";
import { SqliteGraphRepository } from "../src/store/graphRepository.js";
import { SqliteSummaryRepository } from "../src/store/summaryRepository.js";
import { SqliteEmbeddingRepository } from "../src/store/embeddingRepository.js";
import { SqliteQaRepository } from "../src/store/qaRepository.js";
import { MockEmbeddingProvider } from "../src/retrieval/MockEmbeddingProvider.js";
import { MockLLMProvider } from "../src/llm/MockLLMProvider.js";
import type { LLMRequest, Structured } from "../src/llm/LLMProvider.js";
import { createServer } from "../src/server/apiServer.js";
import { makeConfig, segment, silentLoopDelay, stubModules } from "./helpers.js";

interface RecoveryStatus {
  sessionId: string;
  total: number;
  processed: number;
  missing: number;
  busy: boolean;
  lastError: string | null;
  completedBatches: number;
  legacyUntracked: boolean;
}

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required mindmap recovery fixture value is missing");
  return value;
}

async function until<T>(read: () => T | false | undefined | Promise<T | false | undefined>, timeout = 2000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await wait(5);
  }
  throw new Error("mindmap recovery assertion timed out");
}

/** Model seam only: all graph validation, transactions, ledger writes and runtime lifecycles are real. */
class ObservedLlm extends MockLLMProvider {
  readonly requests: LLMRequest[] = [];
  readonly calls: LLMRequest[] = [];
  active = 0;
  maxActive = 0;
  hold = false;
  empty = false;
  failure: Error | null = null;
  reply: ((request: LLMRequest, invocation: number) => unknown) | null = null;
  private parked: (() => void)[] = [];

  override async structuredGenerate<T>(request: LLMRequest, schema: z.ZodType<T>): Promise<Structured<T>> {
    this.requests.push(request);
    if (request.task !== "mindmap") return super.structuredGenerate(request, schema);
    this.calls.push(request);
    const invocation = this.calls.length;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.hold) await new Promise<void>((done) => this.parked.push(done));
      if (this.failure) throw this.failure;
      const operations = this.empty ? [] : [{
        type: "add_node",
        node: {
          id: `recovered-${invocation}`,
          title: `补建主题${invocation}`,
          summary: "由合成测试原文提取的主题",
          sourceTranscriptIds: [...(request.sourceSegmentIds ?? [])],
        },
      }];
      return {
        data: schema.parse(this.reply ? this.reply(request, invocation) : { operations }),
        responseId: `mindmap-api-${invocation}`,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
    } finally {
      this.active -= 1;
    }
  }

  release(): void {
    this.hold = false;
    for (const done of this.parked.splice(0)) done();
  }
}

async function fixture(llm = new ObservedLlm()) {
  const db = openSqlite(":memory:");
  const config = makeConfig({ mindmap: { minSegments: 2, maxIntervalMs: 10_000, windowSec: 120 } });
  const bus = createBus();
  const errors: ModuleError[] = [];
  const upserts: string[] = [];
  bus.onError((error) => errors.push(error));
  bus.on("mindmap", "mindmap.node.upserted", (node) => { upserts.push(node.id); });
  const embedding = new MockEmbeddingProvider();
  const embed = vi.spyOn(embedding, "embed");
  const otherLlmCalls = [vi.spyOn(llm, "generate"), vi.spyOn(llm, "stream")];
  const store = {
    sessions: new SqliteSessionRepository(db.db),
    transcripts: new SqliteTranscriptRepository(db.db),
    graphs: new SqliteGraphRepository(db.db),
    summaries: new SqliteSummaryRepository(db.db),
    embeddings: new SqliteEmbeddingRepository(db.db),
    qa: new SqliteQaRepository(db.db),
  };
  const recording = new RecordingController(bus, store.sessions, (session) => new SessionRuntime(session, bus, config, llm, embedding, store));
  const app = await createServer({
    bus, config, recording, store, embedding,
    providerNames: { stt: "mock", llm: llm.name, embedding: embedding.name },
    modules: stubModules(), loopDelay: silentLoopDelay(),
  });
  const seed = (id: string, count = 1) => {
    store.sessions.create({ id, title: id, startedAt: 1000, endedAt: 1000 + count * 60_000, status: "completed" });
    for (let i = 0; i < count; i += 1) {
      // Repeated IDs between sessions ensure the progress ledger is always scoped by session.
      store.transcripts.appendFinal({ ...segment(`final-${i + 1}`, `合成会议${id}的第${i + 1}条原文。`, i * 60), sessionId: id });
    }
    return required(store.sessions.get(id));
  };
  const status = async (id: string): Promise<RecoveryStatus> => {
    const response = await app.inject({ url: `/api/session/${id}/mindmap/recovery` });
    expect(response.statusCode).toBe(200);
    return response.json() as RecoveryStatus;
  };
  return {
    ...store, app, recording, llm, embed, otherLlmCalls, errors, upserts, seed, status,
    async close() {
      llm.release();
      await recording.stop();
      bus.clear();
      await app.close();
      embed.mockRestore();
      for (const call of otherLlmCalls) call.mockRestore();
      db.close();
    },
  };
}

type Harness = Awaited<ReturnType<typeof fixture>>;

async function idleStatus(h: Harness, id: string, processed: number): Promise<RecoveryStatus> {
  return until(async () => {
    const value = await h.status(id);
    return !value.busy && value.processed === processed ? value : false;
  });
}

describe("explicit mindmap recovery API", () => {
  it("opens and reads saved history without a model call, graph change, or progress write", async () => {
    const h = await fixture();
    try {
      h.seed("history", 3);
      const original = h.transcripts.listFinal("history");
      expect((await h.app.inject({ method: "POST", url: "/api/session/history/open" })).statusCode).toBe(200);
      expect(await h.status("history")).toEqual({
        sessionId: "history", total: 3, processed: 0, missing: 3, busy: false,
        lastError: null, completedBatches: 0, legacyUntracked: false,
      });
      await h.status("history");
      expect(h.llm.requests).toEqual([]);
      expect(h.embed).not.toHaveBeenCalled();
      for (const call of h.otherLlmCalls) expect(call).not.toHaveBeenCalled();
      expect(h.graphs.loadNodes("history")).toEqual([]);
      expect(h.graphs.processedSegmentIds("history").size).toBe(0);
      expect(h.transcripts.listFinal("history")).toEqual(original);
    } finally { await h.close(); }
  });

  it("returns 202, persists graph and progress together, and remembers completed source after reopening", async () => {
    const h = await fixture();
    try {
      h.recording.openHistory(h.seed("history", 3));
      const original = h.transcripts.listFinal("history");
      const response = await h.app.inject({ method: "POST", url: "/api/session/history/mindmap/rebuild" });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ accepted: true, status: { sessionId: "history", total: 3 } });
      expect(await idleStatus(h, "history", 3)).toMatchObject({ missing: 0, lastError: null, legacyUntracked: false });
      expect(h.graphs.loadNodes("history").length).toBeGreaterThan(0);
      expect(h.graphs.processedSegmentIds("history")).toEqual(new Set(original.map((row) => row.id)));
      expect(h.llm.calls.flatMap((request) => request.sourceSegmentIds ?? [])).toEqual(original.map((row) => row.id));
      expect(h.transcripts.listFinal("history")).toEqual(original);
      const calls = h.llm.calls.length;
      await h.recording.closeSession();
      h.recording.openHistory(required(h.sessions.get("history")));
      expect(await h.status("history")).toMatchObject({ total: 3, processed: 3, missing: 0, legacyUntracked: false });
      expect((await h.app.inject({ method: "POST", url: "/api/session/history/mindmap/rebuild" })).statusCode).toBe(202);
      await idleStatus(h, "history", 3);
      expect(h.llm.calls).toHaveLength(calls);
      expect(h.transcripts.listFinal("history")).toEqual(original);
    } finally { await h.close(); }
  });

  it("repairs a just-finished recording with a valid empty operation response and persists its progress", async () => {
    const llm = new ObservedLlm();
    llm.empty = true;
    llm.failure = new Error("injected live mindmap failure");
    const h = await fixture(llm);
    try {
      // MOCK_STT refuses real mic attachment. Only synthetic final text enters the actual runtime.
      const id = await h.recording.start("mic");
      required(h.recording.current).transcript.acceptFinal({ ...segment("finish-final", "合成的收尾原文。", 0), sessionId: id });
      await h.recording.finish();
      expect(h.recording.state).toBe("viewing");
      expect(await h.status(id)).toMatchObject({ total: 1, processed: 0, missing: 1 });
      const original = h.transcripts.listFinal(id);
      const liveCalls = llm.calls.length;
      expect(liveCalls).toBeGreaterThan(0);
      llm.failure = null;
      expect((await h.app.inject({ method: "POST", url: `/api/session/${id}/mindmap/rebuild` })).statusCode).toBe(202);
      expect(await idleStatus(h, id, 1)).toMatchObject({ missing: 0, lastError: null });
      expect(llm.calls.length).toBeGreaterThan(liveCalls);
      expect(h.graphs.loadNodes(id)).toEqual([]);
      expect(h.graphs.processedSegmentIds(id)).toEqual(new Set(["finish-final"]));
      expect(h.transcripts.listFinal(id)).toEqual(original);
      await h.recording.closeSession();
      h.recording.openHistory(required(h.sessions.get(id)));
      expect(await h.status(id)).toMatchObject({ total: 1, processed: 1, missing: 0, legacyUntracked: false });
    } finally { await h.close(); }
  });

  it("coalesces repeated POSTs into one serial job and exposes busy while a model response is held", async () => {
    const llm = new ObservedLlm();
    llm.hold = true;
    const h = await fixture(llm);
    try {
      h.recording.openHistory(h.seed("history", 5));
      const responses = await Promise.all(Array.from({ length: 6 }, () => h.app.inject({ method: "POST", url: "/api/session/history/mindmap/rebuild" })));
      for (const response of responses) expect(response.statusCode).toBe(202);
      await until(() => llm.calls.length > 0);
      expect(await h.status("history")).toMatchObject({ busy: true, processed: 0, missing: 5 });
      expect(llm.calls).toHaveLength(1);
      expect(llm.maxActive).toBe(1);
      llm.release();
      expect(await idleStatus(h, "history", 5)).toMatchObject({ missing: 0 });
      const processed = llm.calls.flatMap((request) => request.sourceSegmentIds ?? []);
      expect(processed).toHaveLength(5);
      expect(new Set(processed).size).toBe(5);
      expect(llm.maxActive).toBe(1);
    } finally { await h.close(); }
  });

  it("rejects missing or different current sessions before requesting a model or exposing progress", async () => {
    const h = await fixture();
    try {
      h.seed("other");
      for (const id of ["other", "unknown"]) {
        for (const method of ["GET", "POST"] as const) {
          const suffix = method === "GET" ? "recovery" : "rebuild";
          const response = await h.app.inject({ method, url: `/api/session/${id}/mindmap/${suffix}` });
          expect(response.statusCode).toBe(409);
          expect(response.json()).toMatchObject({ error: "session_changed" });
        }
      }
      h.recording.openHistory(h.seed("selected"));
      for (const method of ["GET", "POST"] as const) {
        const response = await h.app.inject({ method, url: `/api/session/other/mindmap/${method === "GET" ? "recovery" : "rebuild"}` });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ error: "session_changed" });
        expect(response.json()).not.toHaveProperty("total");
        expect(response.json()).not.toHaveProperty("status");
      }
      expect(h.recording.sessionId).toBe("selected");
      expect(h.llm.requests).toEqual([]);
      expect(h.graphs.processedSegmentIds("other").size).toBe(0);
      expect(h.graphs.processedSegmentIds("selected").size).toBe(0);
    } finally { await h.close(); }
  });

  it("allows read-only status but rejects recording, paused, and queued viewing transitions", async () => {
    const h = await fixture();
    let closeOnRequest = false;
    let closing: Promise<void> = Promise.resolve();
    let observed: { state: string; transitioning: boolean } | undefined;
    try {
      h.app.addHook("preHandler", (_request, _reply, done) => {
        if (closeOnRequest) {
          closeOnRequest = false;
          closing = h.recording.closeSession();
          observed = { state: h.recording.state, transitioning: h.recording.transitioning };
        }
        done();
      });
      const id = await h.recording.start("mic");
      for (const state of ["recording", "paused"] as const) {
        if (state === "paused") h.recording.pause();
        expect(h.recording.state).toBe(state);
        expect(await h.status(id)).toMatchObject({ sessionId: id, total: 0, busy: false });
        const response = await h.app.inject({ method: "POST", url: `/api/session/${id}/mindmap/rebuild` });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ error: "recording_in_progress" });
      }
      await h.recording.finish();
      expect(h.recording.state).toBe("viewing");
      closeOnRequest = true;
      const response = await h.app.inject({ method: "POST", url: `/api/session/${id}/mindmap/rebuild` });
      expect(observed).toEqual({ state: "viewing", transitioning: true });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "recording_in_progress" });
      await closing;
      expect(h.llm.requests).toEqual([]);
    } finally { await closing; await h.close(); }
  });

  it("requires explicit legacy consent and refuses non-boolean confirmation without changing the old graph", async () => {
    const llm = new ObservedLlm();
    llm.empty = true;
    const h = await fixture(llm);
    try {
      h.seed("legacy");
      h.graphs.upsertNode("legacy", { id: "legacy-node", title: "合成旧节点", sourceTranscriptIds: ["final-1"], createdAt: 1, updatedAt: 1 });
      h.recording.openHistory(required(h.sessions.get("legacy")));
      const originalNodes = h.graphs.loadNodes("legacy");
      expect(await h.status("legacy")).toMatchObject({ legacyUntracked: true, total: 1, processed: 0, missing: 1 });
      for (const value of ["true", 1, null, {}, []]) {
        const invalid = await h.app.inject({ method: "POST", url: "/api/session/legacy/mindmap/rebuild", payload: { allowUntracked: value } });
        expect(invalid.statusCode).toBe(400);
      }
      for (const payload of [undefined, { allowUntracked: false }]) {
        const refused = await h.app.inject({ method: "POST", url: "/api/session/legacy/mindmap/rebuild", ...(payload ? { payload } : {}) });
        expect(refused.statusCode).toBe(409);
        expect(refused.json()).toMatchObject({ error: "untracked_graph" });
      }
      expect(llm.requests).toEqual([]);
      expect(h.graphs.loadNodes("legacy")).toEqual(originalNodes);
      expect(h.graphs.processedSegmentIds("legacy").size).toBe(0);
      const accepted = await h.app.inject({ method: "POST", url: "/api/session/legacy/mindmap/rebuild", payload: { allowUntracked: true } });
      expect(accepted.statusCode).toBe(202);
      expect(await idleStatus(h, "legacy", 1)).toMatchObject({ legacyUntracked: false, missing: 0 });
      expect(h.graphs.loadNodes("legacy")).toEqual(originalNodes);
    } finally { await h.close(); }
  });

  it("keeps failed source missing and reports the model error without automatic retry on status reads", async () => {
    const llm = new ObservedLlm();
    llm.failure = new Error("injected recovery model unavailable");
    const h = await fixture(llm);
    try {
      h.recording.openHistory(h.seed("history", 2));
      const original = h.transcripts.listFinal("history");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], loopLimit: 50 });
      expect((await h.app.inject({ method: "POST", url: "/api/session/history/mindmap/rebuild" })).statusCode).toBe(202);
      await vi.runAllTimersAsync();
      expect(await h.status("history")).toMatchObject({ total: 2, processed: 0, missing: 2, busy: false, lastError: "injected recovery model unavailable" });
      expect(llm.calls.length).toBeGreaterThan(0);
      expect(llm.maxActive).toBe(1);
      const calls = llm.calls.length;
      await h.status("history");
      await vi.runAllTimersAsync();
      expect(llm.calls).toHaveLength(calls);
      expect(h.graphs.processedSegmentIds("history").size).toBe(0);
      expect(h.graphs.loadNodes("history")).toEqual([]);
      expect(h.transcripts.listFinal("history")).toEqual(original);
    } finally { vi.useRealTimers(); await h.close(); }
  });

  it("discards held results and suppresses late errors after switching to another meeting", async () => {
    for (const lateFailure of [false, true]) {
      const llm = new ObservedLlm();
      llm.hold = true;
      const h = await fixture(llm);
      try {
        h.recording.openHistory(h.seed("previous", 3));
        h.seed("next");
        const previous = required(h.recording.current);
        const originalPrevious = h.transcripts.listFinal("previous");
        const originalNext = h.transcripts.listFinal("next");
        expect((await h.app.inject({ method: "POST", url: "/api/session/previous/mindmap/rebuild" })).statusCode).toBe(202);
        await until(() => llm.calls.length > 0);
        expect(await h.status("previous")).toMatchObject({ busy: true });
        expect((await h.app.inject({ method: "POST", url: "/api/session/next/open" })).statusCode).toBe(200);
        if (lateFailure) llm.failure = new Error("injected late old-session failure");
        llm.release();
        await until(() => llm.active === 0 && !previous.mindmap.isBusy);
        await wait(0);
        expect(h.graphs.loadNodes("previous")).toEqual([]);
        expect(h.graphs.processedSegmentIds("previous").size).toBe(0);
        expect(h.graphs.loadNodes("next")).toEqual([]);
        expect(h.graphs.processedSegmentIds("next").size).toBe(0);
        expect(h.errors.filter((error) => error.module === "mindmap" && error.sessionId === "previous")).toEqual([]);
        expect(llm.calls).toHaveLength(1);
        expect(await h.status("next")).toMatchObject({ sessionId: "next", total: 1, processed: 0, missing: 1, busy: false });
        const stale = await h.app.inject({ method: "POST", url: "/api/session/previous/mindmap/rebuild" });
        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toMatchObject({ error: "session_changed" });
        llm.failure = null;
        expect((await h.app.inject({ method: "POST", url: "/api/session/next/mindmap/rebuild" })).statusCode).toBe(202);
        await idleStatus(h, "next", 1);
        expect(h.graphs.processedSegmentIds("previous").size).toBe(0);
        expect(h.graphs.processedSegmentIds("next")).toEqual(new Set(["final-1"]));
        expect(h.transcripts.listFinal("previous")).toEqual(originalPrevious);
        expect(h.transcripts.listFinal("next")).toEqual(originalNext);
      } finally { await h.close(); }
    }
  });

  it("rolls back graph and operation writes when the progress-ledger transaction fails", async () => {
    const h = await fixture();
    const ledgerWrite = vi.spyOn(h.graphs, "recordProcessedSegments").mockImplementation(() => { throw new Error("injected progress ledger write failure"); });
    try {
      h.recording.openHistory(h.seed("history", 2));
      const original = h.transcripts.listFinal("history");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], loopLimit: 50 });
      expect((await h.app.inject({ method: "POST", url: "/api/session/history/mindmap/rebuild" })).statusCode).toBe(202);
      await vi.runAllTimersAsync();
      expect(await h.status("history")).toMatchObject({ total: 2, processed: 0, missing: 2, busy: false });
      expect((await h.status("history")).lastError).toContain("injected progress ledger write failure");
      expect(h.graphs.loadNodes("history")).toEqual([]);
      expect(h.graphs.seenOpIds("history")).toEqual([]);
      expect(h.graphs.processedSegmentIds("history").size).toBe(0);
      expect(required(h.recording.current).graph.snapshot().nodes).toEqual([]);
      expect(h.upserts).toEqual([]);
      expect(h.transcripts.listFinal("history")).toEqual(original);
      ledgerWrite.mockRestore();
      expect((await h.app.inject({ method: "POST", url: "/api/session/history/mindmap/rebuild" })).statusCode).toBe(202);
      await vi.runAllTimersAsync();
      expect(await h.status("history")).toMatchObject({ processed: 2, missing: 0, busy: false, lastError: null });
      expect(h.graphs.loadNodes("history").length).toBeGreaterThan(0);
      expect(h.graphs.processedSegmentIds("history")).toEqual(new Set(original.map((row) => row.id)));
    } finally { ledgerWrite.mockRestore(); vi.useRealTimers(); await h.close(); }
  });

  it("keeps rejected live batches missing, preserves legal nodes, and requires consent before recovery", async () => {
    for (const mixed of [false, true]) {
      const llm = new ObservedLlm();
      llm.reply = (request, invocation) => {
        const sourceTranscriptIds = [...(request.sourceSegmentIds ?? [])];
        const legal = { type: "add_node", node: { id: `kept-${invocation}`, title: "合成合法节点", sourceTranscriptIds } };
        const rejected = { type: "add_node", node: { id: `orphan-${invocation}`, title: "合成孤儿节点", parentId: "missing-parent", sourceTranscriptIds } };
        return { operations: mixed ? [legal, rejected] : [rejected] };
      };
      const h = await fixture(llm);
      try {
        const id = await h.recording.start("mic");
        const runtime = required(h.recording.current);
        runtime.transcript.acceptFinal({ ...segment("live-1", "第一条合成原文。", 0), sessionId: id });
        runtime.transcript.acceptFinal({ ...segment("live-2", "第二条合成原文。", 5), sessionId: id });
        await h.recording.finish();
        const original = h.transcripts.listFinal(id);
        const nodes = h.graphs.loadNodes(id);
        expect(nodes).toHaveLength(mixed ? 1 : 0);
        if (mixed) expect(nodes[0]?.title).toBe("合成合法节点");
        expect(h.graphs.processedSegmentIds(id).size).toBe(0);
        expect(await h.status(id)).toMatchObject({ total: 2, processed: 0, missing: 2, legacyUntracked: true });
        expect(h.errors.filter((error) => error.module === "mindmap")).toEqual([]);
        const incomplete = h.graphs.recentOperations(id, 20).filter((operation) => operation.type === "incomplete_batch");
        expect(incomplete.length).toBeGreaterThan(0);
        const calls = llm.calls.length;
        const refused = await h.app.inject({ method: "POST", url: `/api/session/${id}/mindmap/rebuild` });
        expect(refused.statusCode).toBe(409);
        expect(refused.json()).toMatchObject({ error: "untracked_graph" });
        expect(llm.calls).toHaveLength(calls);
        llm.reply = null;
        llm.empty = true;
        const accepted = await h.app.inject({ method: "POST", url: `/api/session/${id}/mindmap/rebuild`, payload: { allowUntracked: true } });
        expect(accepted.statusCode).toBe(202);
        expect(await idleStatus(h, id, 2)).toMatchObject({ missing: 0, legacyUntracked: false, lastError: null });
        expect(h.graphs.loadNodes(id)).toEqual(nodes);
        expect(h.graphs.processedSegmentIds(id)).toEqual(new Set(["live-1", "live-2"]));
        expect(h.graphs.recentOperations(id, 20).filter((operation) => operation.type === "incomplete_batch")).toEqual(incomplete);
        expect(h.transcripts.listFinal(id)).toEqual(original);
      } finally { await h.close(); }
    }
  });
});
