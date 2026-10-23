import { describe, expect, it, vi } from "vitest";
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
import type { EmbeddingProvider } from "../src/retrieval/EmbeddingProvider.js";
import { MockLLMProvider } from "../src/llm/MockLLMProvider.js";
import { createServer, type ServerDeps } from "../src/server/apiServer.js";
import { makeConfig, segment, silentLoopDelay, stubModules } from "./helpers.js";

interface RecoveryStatus {
  sessionId: string;
  provider: string;
  total: number;
  indexed: number;
  missing: number;
  busy: boolean;
  lastError: string | null;
  completedBatches: number;
}

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required retrieval recovery fixture value is missing");
  return value;
}

async function until<T>(read: () => T | false | undefined | Promise<T | false | undefined>, timeout = 2000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await wait(5);
  }
  throw new Error("retrieval recovery assertion timed out");
}

/** Controls model latency and failure while retaining real offline vector generation and storage. */
class ObservedEmbedding implements EmbeddingProvider {
  private readonly base = new MockEmbeddingProvider();
  readonly name = this.base.name;
  readonly dim = this.base.dim;
  readonly calls: string[][] = [];
  active = 0;
  maxActive = 0;
  hold = false;
  failure: Error | null = null;
  private parked: (() => void)[] = [];

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls.push([...texts]);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.hold) await new Promise<void>((done) => this.parked.push(done));
      if (this.failure) throw this.failure;
      return await this.base.embed(texts);
    } finally {
      this.active -= 1;
    }
  }

  release(): void {
    this.hold = false;
    for (const done of this.parked.splice(0)) done();
  }
}

async function fixture(embedding = new ObservedEmbedding(), access: Pick<ServerDeps, "desktop"> = {}) {
  const db = openSqlite(":memory:");
  const config = makeConfig({ retrieval: { topK: 5, minScore: 0.01, batchSize: 2, maxPending: 64 } });
  const bus = createBus();
  const llm = new MockLLMProvider();
  const llmCalls = [vi.spyOn(llm, "generate"), vi.spyOn(llm, "structuredGenerate"), vi.spyOn(llm, "stream")];
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
    modules: stubModules(), loopDelay: silentLoopDelay(), ...access,
  });
  const seed = (id: string, count = 1) => {
    store.sessions.create({ id, title: id, startedAt: 1000, endedAt: 1000 + count * 60_000, status: "completed" });
    for (let i = 0; i < count; i += 1) {
      // IDs deliberately repeat between sessions: recovery must always keep the session boundary.
      store.transcripts.appendFinal({ ...segment(`final-${i + 1}`, `会议${id}第${i + 1}条已保存原文：显式检索补建保留这些内容。`, i * 60), sessionId: id });
    }
    return required(store.sessions.get(id));
  };
  const status = async (id: string): Promise<RecoveryStatus> => {
    const response = await app.inject({ url: `/api/session/${id}/retrieval` });
    expect(response.statusCode).toBe(200);
    return response.json() as RecoveryStatus;
  };
  return {
    ...store, app, recording, embedding, llmCalls, seed, status,
    async close() {
      embedding.release();
      await recording.stop();
      bus.clear();
      await app.close();
      for (const call of llmCalls) call.mockRestore();
      db.close();
    },
  };
}

type Harness = Awaited<ReturnType<typeof fixture>>;

async function idleStatus(h: Harness, id: string, expectedIndexed: number): Promise<RecoveryStatus> {
  return until(async () => {
    const value = await h.status(id);
    return !value.busy && value.indexed === expectedIndexed ? value : false;
  });
}

describe("explicit retrieval recovery API (M3/I05 foundation)", () => {
  it("opens and reads unindexed history without requesting any model or changing source text", async () => {
    const h = await fixture();
    try {
      h.seed("history", 3);
      const original = h.transcripts.listFinal("history");
      expect((await h.app.inject({ method: "POST", url: "/api/session/history/open" })).statusCode).toBe(200);
      expect(await h.status("history")).toEqual({
        sessionId: "history", provider: h.embedding.name, total: 3, indexed: 0, missing: 3,
        busy: false, lastError: null, completedBatches: 0,
      });
      expect(await h.status("history")).toMatchObject({ missing: 3, busy: false });
      expect(h.embedding.calls).toEqual([]);
      for (const call of h.llmCalls) expect(call).not.toHaveBeenCalled();
      expect(h.transcripts.listFinal("history")).toEqual(original);
      expect(h.embeddings.listOwnerIds("history", "transcript", h.embedding.name).size).toBe(0);
      expect(h.sessions.get("history")?.status).toBe("completed");
    } finally { await h.close(); }
  });

  it("returns 202 for explicit recovery and makes saved source text searchable without rewriting it", async () => {
    const h = await fixture();
    try {
      h.recording.openHistory(h.seed("history", 3));
      const original = h.transcripts.listFinal("history");
      const response = await h.app.inject({ method: "POST", url: "/api/session/history/retrieval/rebuild" });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ accepted: true, status: { sessionId: "history", provider: h.embedding.name, total: 3 } });
      expect(await idleStatus(h, "history", 3)).toMatchObject({ missing: 0, lastError: null, completedBatches: 2 });
      expect(h.embedding.calls.flat()).toEqual(original.map((row) => row.text));
      expect(h.embeddings.listOwnerIds("history", "transcript", h.embedding.name)).toEqual(new Set(original.map((row) => row.id)));
      const hits = await required(h.recording.current).retrieval.search(required(original[0]).text);
      expect(hits.map((row) => row.id)).toContain(required(original[0]).id);
      expect(hits.every((row) => row.sessionId === "history")).toBe(true);
      expect(h.transcripts.listFinal("history")).toEqual(original);
      for (const call of h.llmCalls) expect(call).not.toHaveBeenCalled();
      const calls = h.embedding.calls.length;
      expect((await h.app.inject({ method: "POST", url: "/api/session/history/retrieval/rebuild" })).statusCode).toBe(202);
      await idleStatus(h, "history", 3);
      expect(h.embedding.calls).toHaveLength(calls);
    } finally { await h.close(); }
  });

  it("coalesces repeated requests, exposes busy, and never overlaps embedding batches", async () => {
    const embedding = new ObservedEmbedding();
    embedding.hold = true;
    const h = await fixture(embedding);
    try {
      h.recording.openHistory(h.seed("history", 5));
      const responses = await Promise.all(Array.from({ length: 6 }, () => h.app.inject({ method: "POST", url: "/api/session/history/retrieval/rebuild" })));
      for (const response of responses) {
        expect(response.statusCode).toBe(202);
        expect(response.json()).toMatchObject({ accepted: true, status: { sessionId: "history" } });
      }
      await until(() => embedding.calls.length > 0);
      expect(await h.status("history")).toMatchObject({ busy: true, indexed: 0, missing: 5 });
      expect(embedding.calls).toHaveLength(1);
      expect(embedding.maxActive).toBe(1);
      embedding.release();
      expect(await idleStatus(h, "history", 5)).toMatchObject({ missing: 0, completedBatches: 3 });
      expect(embedding.calls.map((batch) => batch.length)).toEqual([2, 2, 1]);
      expect(embedding.maxActive).toBe(1);
      expect(new Set(embedding.calls.flat()).size).toBe(5);
    } finally { await h.close(); }
  });

  it("stops after eight batches and leaves the remainder for the next explicit request", async () => {
    const h = await fixture();
    try {
      h.recording.openHistory(h.seed("long-history", 17));
      expect((await h.app.inject({ method: "POST", url: "/api/session/long-history/retrieval/rebuild" })).statusCode).toBe(202);
      expect(await idleStatus(h, "long-history", 16)).toMatchObject({ total: 17, missing: 1, completedBatches: 8 });
      expect(h.embedding.calls).toHaveLength(8);
      expect(await h.status("long-history")).toMatchObject({ indexed: 16, missing: 1, busy: false });
      expect(h.embedding.calls).toHaveLength(8);
      expect((await h.app.inject({ method: "POST", url: "/api/session/long-history/retrieval/rebuild" })).statusCode).toBe(202);
      expect(await idleStatus(h, "long-history", 17)).toMatchObject({ missing: 0 });
      expect(h.embedding.calls).toHaveLength(9);
      expect(new Set(h.embedding.calls.flat()).size).toBe(17);
    } finally { await h.close(); }
  });

  it("rejects absent and mismatched current sessions without reading another session or requesting a model", async () => {
    const h = await fixture();
    try {
      h.seed("other");
      for (const id of ["other", "unknown"]) {
        for (const method of ["GET", "POST"] as const) {
          const response = await h.app.inject({ method, url: `/api/session/${id}/retrieval${method === "POST" ? "/rebuild" : ""}` });
          expect(response.statusCode).toBe(409);
          expect(response.json()).toMatchObject({ error: "session_changed" });
        }
      }
      h.recording.openHistory(h.seed("selected"));
      for (const method of ["GET", "POST"] as const) {
        const response = await h.app.inject({ method, url: `/api/session/other/retrieval${method === "POST" ? "/rebuild" : ""}` });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ error: "session_changed" });
        expect(response.json()).not.toHaveProperty("total");
        expect(response.json()).not.toHaveProperty("status");
      }
      expect(h.recording.sessionId).toBe("selected");
      expect(h.embeddings.count("other")).toBe(0);
      expect(h.embeddings.count("selected")).toBe(0);
      expect(h.embedding.calls).toEqual([]);
      for (const call of h.llmCalls) expect(call).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it("allows read-only recording status but refuses recovery while recording or paused", async () => {
    const h = await fixture();
    try {
      // MOCK_STT=true refuses mic attachment, leaving a real controller lifecycle without a device,
      // network worker, transcript events, or unrelated automatic index requests.
      const id = await h.recording.start("mic");
      expect(h.recording.state).toBe("recording");
      for (const state of ["recording", "paused"] as const) {
        if (state === "paused") h.recording.pause();
        expect(h.recording.state).toBe(state);
        expect(await h.status(id)).toMatchObject({ sessionId: id, total: 0, indexed: 0, missing: 0, busy: false });
        const response = await h.app.inject({ method: "POST", url: `/api/session/${id}/retrieval/rebuild` });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ error: "recording_in_progress" });
      }
      expect(h.embedding.calls).toEqual([]);
      for (const call of h.llmCalls) expect(call).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it("refuses recovery during a queued transition even while the current session still reports viewing", async () => {
    const h = await fixture();
    let closing: Promise<void> = Promise.resolve();
    let observed: { state: string; transitioning: boolean } | undefined;
    try {
      h.recording.openHistory(h.seed("history"));
      h.app.addHook("preHandler", (request, _reply, done) => {
        if (request.url === "/api/session/history/retrieval/rebuild") {
          // Queue a genuine lifecycle transition immediately before this synchronous route. The
          // old runtime still exists until the controller's next microtask, so state alone is unsafe.
          closing = h.recording.closeSession();
          observed = { state: h.recording.state, transitioning: h.recording.transitioning };
        }
        done();
      });
      const response = await h.app.inject({ method: "POST", url: "/api/session/history/retrieval/rebuild" });
      expect(observed).toEqual({ state: "viewing", transitioning: true });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "recording_in_progress" });
      await closing;
      expect(h.embedding.calls).toEqual([]);
      expect(h.embeddings.count("history")).toBe(0);
    } finally { await closing; await h.close(); }
  });

  it("discards a late recovery result after switching meetings and never indexes the new meeting implicitly", async () => {
    const embedding = new ObservedEmbedding();
    embedding.hold = true;
    const h = await fixture(embedding);
    try {
      h.recording.openHistory(h.seed("previous", 4));
      h.seed("next");
      const previous = required(h.recording.current);
      const previousText = h.transcripts.listFinal("previous");
      const nextText = h.transcripts.listFinal("next");
      expect((await h.app.inject({ method: "POST", url: "/api/session/previous/retrieval/rebuild" })).statusCode).toBe(202);
      await until(() => embedding.calls.length > 0);
      expect(await h.status("previous")).toMatchObject({ busy: true });
      expect((await h.app.inject({ method: "POST", url: "/api/session/next/open" })).statusCode).toBe(200);
      expect(h.recording.current).not.toBe(previous);
      expect(h.recording.sessionId).toBe("next");
      embedding.release();
      await until(() => embedding.active === 0 && !previous.retrieval.isBusy);
      await wait(0);
      expect(h.embeddings.count("previous")).toBe(0);
      expect(h.embeddings.count("next")).toBe(0);
      expect(embedding.calls).toHaveLength(1);
      expect(await h.status("next")).toMatchObject({ sessionId: "next", total: 1, indexed: 0, missing: 1, busy: false });
      const stale = await h.app.inject({ method: "POST", url: "/api/session/previous/retrieval/rebuild" });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: "session_changed" });
      expect((await h.app.inject({ method: "POST", url: "/api/session/next/retrieval/rebuild" })).statusCode).toBe(202);
      await idleStatus(h, "next", 1);
      expect(h.embeddings.count("previous")).toBe(0);
      expect(h.embeddings.count("next")).toBe(1);
      expect(h.transcripts.listFinal("previous")).toEqual(previousText);
      expect(h.transcripts.listFinal("next")).toEqual(nextText);
    } finally { await h.close(); }
  });

  it("keeps missing rows and an observable error after three failed attempts, without automatic retries on GET", async () => {
    const embedding = new ObservedEmbedding();
    embedding.failure = new Error("injected recovery model unavailable");
    const h = await fixture(embedding);
    try {
      h.recording.openHistory(h.seed("history", 2));
      const original = h.transcripts.listFinal("history");
      // Only recovery's retry delay uses fake time; no network connection or wall-clock wait is needed.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], loopLimit: 50 });
      const response = await h.app.inject({ method: "POST", url: "/api/session/history/retrieval/rebuild" });
      expect(response.statusCode).toBe(202);
      await vi.runAllTimersAsync();
      expect(await h.status("history")).toMatchObject({ total: 2, indexed: 0, missing: 2, busy: false, lastError: "injected recovery model unavailable" });
      expect(embedding.calls).toHaveLength(3);
      expect(embedding.maxActive).toBe(1);
      expect(h.embeddings.count("history")).toBe(0);
      expect(h.transcripts.listFinal("history")).toEqual(original);
      await h.status("history");
      await vi.runAllTimersAsync();
      expect(embedding.calls).toHaveLength(3);
    } finally { vi.useRealTimers(); await h.close(); }
  });

  it("keeps both recovery endpoints behind the existing desktop access gate", async () => {
    const h = await fixture(new ObservedEmbedding(), { desktop: { token: "recovery-test-secret", instanceId: "recovery-test-instance" } });
    try {
      h.recording.openHistory(h.seed("private-history"));
      for (const headers of [{}, { "x-rcc-desktop": "invalid-credential" }]) {
        for (const method of ["GET", "POST"] as const) {
          const response = await h.app.inject({ method, headers, url: `/api/session/private-history/retrieval${method === "POST" ? "/rebuild" : ""}` });
          expect(response.statusCode).toBe(403);
          expect(response.json()).toEqual({ error: "desktop_access_denied" });
        }
      }
      expect(h.embedding.calls).toEqual([]);
      expect(h.embeddings.count("private-history")).toBe(0);
      for (const call of h.llmCalls) expect(call).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });
});
