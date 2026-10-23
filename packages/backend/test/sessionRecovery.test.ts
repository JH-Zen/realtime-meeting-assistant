import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { decodeServerEvent, type ServerEvent } from "@rcc/shared";
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
import type { LLMRequest } from "../src/llm/LLMProvider.js";
import { createServer } from "../src/server/apiServer.js";
import { exportSessionDocument } from "../src/session/sessionExport.js";
import { makeConfig, segment, silentLoopDelay, stubModules } from "./helpers.js";
import { MOCK_SCRIPT } from "../src/testing/mockScript.js";

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required saved session/test runtime is missing");
  return value;
}
async function until<T>(read: () => T | undefined | false, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = read(); if (result) return result; await wait(10); }
  throw new Error("session recovery assertion timed out");
}

class ContextLlm extends MockLLMProvider {
  readonly requests: LLMRequest[] = [];
  hold: Promise<void> = Promise.resolve();
  override async *stream(request: LLMRequest): AsyncIterable<string> {
    this.requests.push(request);
    yield "依据已保存原文";
    await this.hold;
    yield "依据已保存原文回答完成。";
  }
}

async function fixture(path = ":memory:", embedding: EmbeddingProvider = new MockEmbeddingProvider()) {
  const db = openSqlite(path);
  const config = makeConfig({ mockSttSpeed: 1000, mindmap: { minSegments: 2, maxIntervalMs: 20, windowSec: 120 } });
  const bus = createBus();
  const llm = new ContextLlm();
  const store = {
    sessions: new SqliteSessionRepository(db.db),
    transcripts: new SqliteTranscriptRepository(db.db),
    graphs: new SqliteGraphRepository(db.db),
    summaries: new SqliteSummaryRepository(db.db),
    embeddings: new SqliteEmbeddingRepository(db.db),
    qa: new SqliteQaRepository(db.db),
  };
  const recording = new RecordingController(bus, store.sessions, (session) => new SessionRuntime(session, bus, config, llm, embedding, store));
  const app = await createServer({ bus, config, recording, store, embedding, providerNames: { stt: "mock", llm: llm.name, embedding: embedding.name }, modules: stubModules(), loopDelay: silentLoopDelay() });
  const seed = (id: string, startedAt = 1000) => {
    store.sessions.create({ id, title: id, startedAt, endedAt: startedAt + 90_000, status: "completed" });
    store.transcripts.appendFinal({ ...segment("f-1", `已保存的${id}近期原文`, 60), sessionId: id });
    return required(store.sessions.get(id));
  };
  return {
    ...store, app, recording, bus, llm, seed,
    async close() { await recording.stop(); bus.clear(); await app.close(); db.close(); },
  };
}

async function connect(url: string) {
  const ws = new WebSocket(url);
  const events: ServerEvent[] = [];
  const invalid: string[] = [];
  ws.on("message", (raw: Buffer) => { const event = decodeServerEvent(raw.toString()); if (event) events.push(event); else invalid.push(raw.toString()); });
  await new Promise<void>((done, fail) => { ws.once("open", done); ws.once("error", fail); });
  return { ws, events, invalid, send: (command: unknown) => ws.send(JSON.stringify(command)) };
}

describe("meeting review and recovery (M2)", () => {
  it("finishes input once, preserves an in-flight answer, and still answers a new question", async () => {
    const h = await fixture();
    let release = () => {};
    h.llm.hold = new Promise<void>((done) => { release = done; });
    try {
      const id = await h.recording.start("mock");
      await until(() => h.transcripts.countFinal(id) === MOCK_SCRIPT.length);
      const runtime = required(h.recording.current);
      const question = runtime.qa.ask("q-before-end", "结束时还在回答的问题");
      await until(() => h.llm.requests.length > 0);
      await Promise.all([h.recording.finish(), h.recording.finish()]);
      expect(h.recording.state).toBe("viewing");
      expect(h.recording.current).toBe(runtime);
      expect(runtime.sttEngine).toBeNull();
      expect(h.sessions.get(id)?.status).toBe("completed");
      expect(h.bus.snapshot().events["recording.stopped"]).toBe(1);
      const count = h.transcripts.countFinal(id);
      h.recording.resume();
      h.recording.provideAudio(new ArrayBuffer(3200));
      await wait(20);
      expect(h.transcripts.countFinal(id)).toBe(count);
      release();
      await question;
      await runtime.qa.ask("q-after-end", "结束后继续提问");
      expect(h.qa.listExchanges(id).map((row) => row.answer?.text)).toEqual(["依据已保存原文回答完成。", "依据已保存原文回答完成。"]);
      expect(h.llm.requests[1]?.sourceSegmentIds?.length).toBeGreaterThan(0);
    } finally { release(); await h.close(); }
  });

  it("persists the exact older selection across reopening the database without attaching input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rcc-m2-中文 space-"));
    const path = join(dir, "会议.sqlite");
    try {
      const first = await fixture(path);
      first.seed("older", 1000);
      first.seed("newer", 2000);
      first.recording.openHistory(required(first.sessions.get("older")));
      await required(first.recording.current).qa.ask("saved-question", "保存的问题");
      await first.close();
      const second = await fixture(path);
      try {
        expect(second.recording.restoreSelected()).toBe(true);
        expect(second.recording.sessionId).toBe("older");
        expect(second.recording.state).toBe("viewing");
        expect(second.recording.current?.sttEngine).toBeNull();
        expect(second.recording.current?.transcript.window("older", 120).map((row) => row.text)).toEqual(["已保存的older近期原文"]);
        expect(second.qa.listExchanges("older")[0]?.answer?.text).toContain("回答完成");
        expect(second.bus.snapshot().events["recording.started"]).toBeUndefined();
        await second.recording.closeSession();
        expect(second.sessions.selected()).toBeUndefined();
        expect(second.recording.sessionId).toBeNull();
      } finally { await second.close(); }
      const third = await fixture(path);
      try { expect(third.recording.restoreSelected()).toBe(false); expect(third.recording.state).toBe("idle"); }
      finally { await third.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads interrupted sessions without changing their status or pretending capture resumed", async () => {
    const h = await fixture();
    try {
      h.sessions.create({ id: "interrupted", startedAt: 1, status: "recording" });
      h.transcripts.appendFinal({ ...segment("saved", "崩溃前已保存", 8), sessionId: "interrupted" });
      h.sessions.select("interrupted");
      expect(h.recording.restoreSelected()).toBe(true);
      expect(h.recording.state).toBe("viewing");
      expect(h.recording.elapsedSec()).toBe(11);
      expect(h.recording.current?.sttEngine).toBeNull();
      expect(h.sessions.get("interrupted")?.status).toBe("recording");
      expect(h.recording.openHistory(required(h.sessions.get("interrupted")))).toBe(true);
      expect(h.transcripts.countFinal("interrupted")).toBe(1);
      expect(h.embeddings.listOwnerIds("interrupted", "transcript", "mock").size).toBe(0);
    } finally { await h.close(); }
  });

  it("restores pause-excluding duration instead of increasing it on review or restart", async () => {
    const h = await fixture();
    try {
      const id = await h.recording.start("mock");
      h.recording.pause();
      await wait(40);
      h.recording.resume();
      await wait(10);
      await h.recording.finish();
      const duration = h.recording.elapsedSec();
      const saved = required(h.sessions.get(id));
      expect(duration).toBeLessThan(((saved.endedAt ?? 0) - saved.startedAt) / 1000 - 0.03);
      expect(h.sessions.get(id)?.durationSec).toBe(duration);
      const exported = required(exportSessionDocument(h, id));
      expect(exported.session.durationSec).toBe(duration);
      await h.recording.closeSession();
      h.recording.openHistory(required(h.sessions.get(id)));
      expect(h.recording.elapsedSec()).toBe(duration);
    } finally { await h.close(); }
  });

  it("refuses history selection while recording and paginates actual saved sessions", async () => {
    const h = await fixture();
    try {
      h.seed("old", 1000); h.seed("new", 2000);
      const listed = await h.app.inject({ url: "/api/sessions?limit=1" });
      expect(listed.json()).toMatchObject({ hasMore: true, sessions: [{ id: "new", transcriptCount: 1, nodeCount: 0 }] });
      expect((await h.app.inject({ url: "/api/sessions?limit=1&offset=1" })).json()).toMatchObject({ hasMore: false, sessions: [{ id: "old" }] });
      expect((await h.app.inject({ url: "/api/sessions?limit=-1" })).statusCode).toBe(400);
      expect((await h.app.inject({ url: "/api/session/missing/open", method: "POST" })).statusCode).toBe(404);
      const id = await h.recording.start("mock");
      expect((await h.app.inject({ url: "/api/session/old/open", method: "POST" })).statusCode).toBe(409);
      expect(h.recording.sessionId).toBe(id);
      expect(h.recording.state).toBe("recording");
    } finally { await h.close(); }
  });

  it("can ask from recent imported text when both index creation and query embedding fail", async () => {
    const embedding: EmbeddingProvider = { name: "failed-test-index", dim: 4, embed: async () => { throw new Error("injected unavailable index"); } };
    const h = await fixture(":memory:", embedding);
    try {
      const source = h.seed("source");
      const document = required(exportSessionDocument(h, source.id));
      const imported = await h.app.inject({ url: "/api/session/import", method: "POST", payload: document });
      expect(imported.statusCode).toBe(201);
      const body = imported.json();
      expect(body).toMatchObject({ opened: true, counts: { embedded: 0, transcripts: 1, embeddingError: "injected unavailable index" } });
      await required(h.recording.current).qa.ask("fallback", "已有原文是什么？");
      expect(h.llm.requests[0]?.sourceSegmentIds).toEqual(["f-1"]);
      expect(h.llm.requests[0]?.user).toContain("已保存的source近期原文");
      expect(h.qa.listExchanges(body.sessionId)[0]?.answer?.text).toContain("回答完成");
      expect(h.transcripts.countFinal(source.id)).toBe(1);
    } finally { await h.close(); }
  });

  it("a slow import does not steal a newer meeting selection", async () => {
    let release = () => {};
    let entered = () => {};
    const started = new Promise<void>((done) => { entered = done; });
    const hold = new Promise<void>((done) => { release = done; });
    const base = new MockEmbeddingProvider();
    const h = await fixture(":memory:", { name: base.name, dim: base.dim, embed: async (texts) => { entered(); await hold; return base.embed(texts); } });
    try {
      const source = h.seed("source"); h.seed("selected-later", 3000);
      const pending = h.app.inject({ url: "/api/session/import", method: "POST", payload: required(exportSessionDocument(h, source.id)) });
      // inject is lazy; start it before waiting for the provider.
      const response = Promise.resolve(pending);
      await started;
      expect((await h.app.inject({ url: "/api/session/selected-later/open", method: "POST" })).statusCode).toBe(200);
      release();
      const imported = (await response).json();
      expect(imported.opened).toBe(false);
      expect(h.recording.sessionId).toBe("selected-later");
      expect(h.sessions.get(imported.sessionId)?.status).toBe("completed");
      expect(h.sessions.list()).toHaveLength(3);
    } finally { release(); await h.close(); }
  });

  it("broadcasts complete review snapshots to both windows and replays saved Q&A on reconnect", async () => {
    const h = await fixture();
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const address = h.app.server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener");
    const url = `ws://127.0.0.1:${address.port}/ws`;
    const clients: Awaited<ReturnType<typeof connect>>[] = [];
    try {
      const first = await connect(url); const second = await connect(url); clients.push(first, second);
      first.send({ cmd: "recording.start", source: "mock" });
      await until(() => first.events.some((event) => event.kind === "transcript.final"));
      first.send({ cmd: "recording.stop" });
      await until(() => second.events.some((event) => event.kind === "session.snapshot" && event.state === "viewing"));
      const id = required(h.recording.sessionId);
      first.send({ cmd: "question.ask", questionId: "review-question", text: "结束后还能问吗？" });
      await until(() => first.events.some((event) => event.kind === "answer.completed" && event.questionId === "review-question"));
      const third = await connect(url); clients.push(third);
      await until(() => third.events.some((event) => event.kind === "answers.snapshot" && event.exchanges.some((entry) => entry.question.id === "review-question" && entry.answer !== null)));
      expect(third.events).toContainEqual(expect.objectContaining({ kind: "session.snapshot", sessionId: id, state: "viewing" }));
      expect(third.events.some((event) => event.kind === "transcript.snapshot" && event.segments.length > 0)).toBe(true);
      expect(clients.flatMap((client) => client.invalid)).toEqual([]);
      first.send({ cmd: "session.close" });
      await until(() => second.events.filter((event) => event.kind === "session.snapshot" && event.state === "idle").length === 2);
      expect(h.recording.current).toBeNull();
      expect(h.sessions.selected()).toBeUndefined();
      first.send({ cmd: "question.ask", sessionId: id, questionId: "stale-question", text: "迟到的旧会议问题" });
      await until(() => first.events.some((event) => event.kind === "answer.rejected" && event.questionId === "stale-question" && event.reason === "session_changed"));
      expect(h.qa.listExchanges(id).some((entry) => entry.question.id === "stale-question")).toBe(false);
    } finally { for (const client of clients) client.ws.terminate(); await h.close(); }
  });
});
