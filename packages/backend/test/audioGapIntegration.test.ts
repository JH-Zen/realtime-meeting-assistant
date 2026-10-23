import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { SessionDocumentSchema, type AudioGap, type SessionDocument } from "@rcc/shared";
import { createBus } from "../src/bus/eventBus.js";
import { MockLLMProvider } from "../src/llm/MockLLMProvider.js";
import { RecordingController } from "../src/recording/RecordingController.js";
import { MockEmbeddingProvider } from "../src/retrieval/MockEmbeddingProvider.js";
import { SessionRuntime } from "../src/runtime/SessionRuntime.js";
import { createServer } from "../src/server/apiServer.js";
import { SqliteAudioGapRepository } from "../src/store/audioGapRepository.js";
import { SqliteEmbeddingRepository } from "../src/store/embeddingRepository.js";
import { SqliteGraphRepository } from "../src/store/graphRepository.js";
import { SqliteQaRepository } from "../src/store/qaRepository.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { openSqlite } from "../src/store/sqlite.js";
import { SqliteSummaryRepository } from "../src/store/summaryRepository.js";
import { SqliteTranscriptRepository } from "../src/store/transcriptRepository.js";
import { makeConfig, silentLoopDelay, stubModules } from "./helpers.js";
import { startSttWorkerStub } from "./sttWorkerStub.js";

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const pcm = (seconds = 0.1) => Buffer.alloc(Math.round(seconds * 16000) * 2).toString("base64");

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing audio integration fixture value");
  return value;
}

async function until(read: () => boolean, timeout = 2500): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (read()) return;
    await wait(5);
  }
  throw new Error("Audio gap integration assertion timed out");
}

/** Only recognition/model seams are substitutes: WS commands, runtime, HTTP and SQLite are real. */
async function fixture() {
  const worker = await startSttWorkerStub();
  let workerClosed = false;
  const db = openSqlite(":memory:");
  const bus = createBus();
  const config = makeConfig({
    mockStt: false, stt: { wsUrl: worker.url, sampleRate: 16000 },
    mindmap: { minSegments: 1000, maxIntervalMs: 60_000, windowSec: 120 },
  });
  const llm = new MockLLMProvider();
  const embedding = new MockEmbeddingProvider();
  const modelCalls = [vi.spyOn(llm, "generate"), vi.spyOn(llm, "structuredGenerate"), vi.spyOn(llm, "stream"), vi.spyOn(embedding, "embed")];
  const store = {
    sessions: new SqliteSessionRepository(db.db),
    transcripts: new SqliteTranscriptRepository(db.db),
    graphs: new SqliteGraphRepository(db.db),
    summaries: new SqliteSummaryRepository(db.db),
    embeddings: new SqliteEmbeddingRepository(db.db),
    qa: new SqliteQaRepository(db.db),
    audioGaps: new SqliteAudioGapRepository(db.db),
  };
  const recording = new RecordingController(bus, store.sessions, (session) => new SessionRuntime(session, bus, config, llm, embedding, store));
  const app = await createServer({
    bus, config, recording, store, embedding,
    providerNames: { stt: "synthetic-worker", llm: llm.name, embedding: embedding.name },
    modules: stubModules(), loopDelay: silentLoopDelay(),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (typeof address !== "object" || !address) throw new Error("Missing test server address");
  const clients: WebSocket[] = [];
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    clients.push(ws);
    await new Promise<void>((done, fail) => { ws.once("open", done); ws.once("error", fail); });
    return ws;
  };
  const seed = (id: string) => {
    store.sessions.create({ id, title: "合成测试会议", startedAt: 1000, endedAt: 2000, durationSec: 1, status: "completed" });
    return required(store.sessions.get(id));
  };
  const gaps = async (id: string): Promise<AudioGap[]> => {
    const response = await app.inject({ url: `/api/session/${id}/audio-gaps` });
    expect(response.statusCode).toBe(200);
    return (response.json() as { sessionId: string; gaps: AudioGap[] }).gaps;
  };
  const document = async (id: string): Promise<SessionDocument> => {
    const response = await app.inject({ url: `/api/session/${id}/export` });
    expect(response.statusCode).toBe(200);
    return SessionDocumentSchema.parse(response.json());
  };
  return {
    ...store, app, recording, worker, modelCalls, connect, seed, gaps, document,
    async crashWorker() { await worker.close(); workerClosed = true; await until(() => recording.current?.sttStatus === "reconnecting" || recording.current?.sttStatus === "failed"); },
    async close() {
      for (const client of clients) client.terminate();
      await recording.stop();
      await app.close();
      if (!workerClosed) await worker.close();
      bus.clear();
      for (const call of modelCalls) call.mockRestore();
      db.close();
    },
  };
}

function frame(ws: WebSocket, sessionId: string, seq: number, startTime: number, captureId = "capture-a", originTime = 0, pcmBase64 = pcm()): void {
  ws.send(JSON.stringify({ cmd: "audio.chunk", seq, pcmBase64, capture: { sessionId, captureId, originTime, startTime } }));
}

function end(ws: WebSocket, sessionId: string, nextSeq: number, endTime: number, captureId = "capture-a", originTime = 0): void {
  ws.send(JSON.stringify({ cmd: "audio.capture.end", capture: { sessionId, captureId, originTime, nextSeq, endTime } }));
}

describe("audio gap runtime, HTTP and export integration", () => {
  it("persists a missing source interval from real WS and preserves it through HTTP export and fresh-id import", async () => {
    const h = await fixture();
    try {
      const id = await h.recording.start("mic");
      const ws = await h.connect();
      frame(ws, id, 0, 0);
      frame(ws, id, 3, 0.3);
      await until(() => h.worker.audioFrames === 2);
      const rows = await h.gaps(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ sessionId: id, stage: "capture_backend", reason: "sequence_gap", certainty: "observed", startTime: 0.1, endTime: 0.3 });
      end(ws, id, 4, 0.4);
      await h.recording.finish();
      const source = await h.document(id);
      expect(source.audioGaps).toEqual(rows);
      const imported = await h.app.inject({ method: "POST", url: "/api/session/import", payload: source });
      expect(imported.statusCode).toBe(201);
      const nextId = (imported.json() as { sessionId: string }).sessionId;
      expect(nextId).not.toBe(id);
      expect(await h.gaps(nextId)).toEqual(rows.map((row) => ({ ...row, sessionId: nextId })));
      expect(h.audioGaps.list(id)).toEqual(rows);
      expect((await h.document(nextId)).audioGaps).toEqual(rows.map((row) => ({ ...row, sessionId: nextId })));
      for (const call of h.modelCalls) expect(call).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it("merges adjacent evidence only within the same session, stage, reason and certainty", async () => {
    const h = await fixture();
    try {
      h.seed("selected"); h.seed("other");
      const evidence = { stage: "capture_backend", reason: "sequence_gap", certainty: "observed", startTime: 1, endTime: 2 } as const;
      const first = h.audioGaps.record("selected", evidence);
      const extended = h.audioGaps.record("selected", { ...evidence, startTime: 2, endTime: 3 });
      expect(extended).toMatchObject({ id: first.id, startTime: 1, endTime: 3 });
      h.audioGaps.record("selected", { ...evidence, stage: "backend_stt", startTime: 3, endTime: 4 });
      h.audioGaps.record("selected", { ...evidence, certainty: "possible", startTime: 3, endTime: 4 });
      h.audioGaps.record("selected", { ...evidence, reason: "capture_tail", startTime: 3, endTime: 4 });
      h.audioGaps.record("other", evidence);
      h.recording.openHistory(required(h.sessions.get("selected")));
      expect(await h.gaps("selected")).toHaveLength(4);
      expect(h.audioGaps.list("other")).toHaveLength(1);
      expect((await h.document("selected")).audioGaps).toHaveLength(4);
    } finally { await h.close(); }
  });

  it("rejects stale status reads and stale capture commands instead of exposing or modifying another session", async () => {
    const h = await fixture();
    try {
      h.seed("other");
      const id = await h.recording.start("mic");
      const ws = await h.connect();
      frame(ws, "other", 5, 0.5);
      end(ws, "other", 9, 0.9);
      frame(ws, id, 0, 0);
      await until(() => h.worker.audioFrames === 1);
      expect(h.audioGaps.list("other")).toEqual([]);
      expect(await h.gaps(id)).toEqual([]);
      for (const foreign of ["other", "unknown"]) {
        const response = await h.app.inject({ url: `/api/session/${foreign}/audio-gaps` });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ error: "session_changed" });
        expect(response.json()).not.toHaveProperty("gaps");
      }
      await h.recording.finish();
      h.recording.openHistory(required(h.sessions.get("other")));
      const stale = await h.app.inject({ url: `/api/session/${id}/audio-gaps` });
      expect(stale.statusCode).toBe(409);
      expect(await h.gaps("other")).toEqual([]);
    } finally { await h.close(); }
  });

  it("rejects malformed PCM, duplicate and reversed sequences before forwarding to the worker", async () => {
    const h = await fixture();
    try {
      const id = await h.recording.start("mic");
      const ws = await h.connect();
      frame(ws, id, 0, 0);
      await until(() => h.worker.audioFrames === 1);
      for (const invalid of ["%%%", "A===", Buffer.alloc(3).toString("base64"), pcm(1.1), ""]) frame(ws, id, 1, 0.1, "capture-a", 0, invalid);
      frame(ws, id, 0, 0);
      frame(ws, id, 1, 0.1);
      frame(ws, id, 0, 0.2);
      frame(ws, id, 2, 0.2);
      await until(() => h.worker.audioFrames === 3);
      await wait(20);
      expect(h.worker.audioFrames).toBe(3);
      expect(await h.gaps(id)).toEqual([]);
    } finally { await h.close(); }
  });

  it("records an entirely missing capture and a missing final tail from explicit end evidence", async () => {
    const h = await fixture();
    try {
      const id = await h.recording.start("mic");
      const ws = await h.connect();
      end(ws, id, 4, 0.4);
      await until(() => h.audioGaps.list(id).length === 1);
      frame(ws, id, 0, 0.4, "capture-b", 0.4);
      end(ws, id, 3, 0.7, "capture-b", 0.4);
      await until(() => h.worker.audioFrames === 1 && h.audioGaps.list(id).length === 2);
      expect(await h.gaps(id)).toEqual([
        expect.objectContaining({ reason: "capture_tail", startTime: 0, endTime: 0.4, certainty: "observed" }),
        expect.objectContaining({ reason: "capture_tail", startTime: 0.5, endTime: 0.7, certainty: "observed" }),
      ]);
      end(ws, id, 3, 0.7, "capture-b", 0.4);
      frame(ws, id, 3, 0.7, "capture-b", 0.4);
      await wait(20);
      expect(h.worker.audioFrames).toBe(1);
      expect(h.audioGaps.list(id)).toHaveLength(2);
    } finally { await h.close(); }
  });

  it("does not retire an active capture when a new capture frame has an impossible sequence origin", async () => {
    const h = await fixture();
    try {
      const id = await h.recording.start("mic");
      const ws = await h.connect();
      frame(ws, id, 0, 0);
      await until(() => h.worker.audioFrames === 1);
      // Seq 1 claims a dropped predecessor but starts exactly at the new capture origin: invalid.
      frame(ws, id, 1, 0.1, "invalid-new-capture", 0.1);
      frame(ws, id, 1, 0.1);
      await wait(20);
      expect(h.worker.audioFrames).toBe(2);
      expect(await h.gaps(id)).toEqual([]);
      end(ws, id, 2, 0.2);
      await wait(10);
      expect(await h.gaps(id)).toEqual([]);
    } finally { await h.close(); }
  });

  it("persists downstream uncertain loss and definite drops while the actual worker socket is down", async () => {
    const h = await fixture();
    try {
      const id = await h.recording.start("mic");
      const ws = await h.connect();
      frame(ws, id, 0, 0);
      await until(() => h.worker.audioFrames === 1);
      await h.crashWorker();
      frame(ws, id, 1, 0.1);
      await until(() => h.audioGaps.list(id).length >= 2);
      expect(await h.gaps(id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: "backend_stt", reason: "worker_disconnect", certainty: "possible", startTime: 0, endTime: 0.1 }),
        expect.objectContaining({ stage: "backend_stt", reason: "worker_unavailable", certainty: "observed", startTime: 0.1, endTime: 0.2 }),
      ]));
      expect(h.audioGaps.list(id).every((row) => row.stage === "backend_stt")).toBe(true);
      expect((await h.document(id)).audioGaps).toEqual(h.audioGaps.list(id));
    } finally { await h.close(); }
  });

  it("opens legacy history and reads gaps without model calls or a claim that missing metadata proves completeness", async () => {
    const h = await fixture();
    try {
      h.recording.openHistory(h.seed("legacy"));
      const source = await h.document("legacy");
      const { audioGaps: _removed, ...oldFile } = source;
      const imported = await h.app.inject({ method: "POST", url: "/api/session/import", payload: oldFile });
      expect(imported.statusCode).toBe(201);
      const nextId = (imported.json() as { sessionId: string }).sessionId;
      const response = await h.app.inject({ url: `/api/session/${nextId}/audio-gaps` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ sessionId: nextId, gaps: [] });
      expect(response.json()).not.toHaveProperty("complete");
      expect(response.json()).not.toHaveProperty("recognized");
      await h.gaps(nextId);
      for (const call of h.modelCalls) expect(call).not.toHaveBeenCalled();
      expect(h.worker.audioFrames).toBe(0);
    } finally { await h.close(); }
  });

  it("refuses late capture-end writes after a completed meeting has been opened for viewing", async () => {
    const h = await fixture();
    try {
      h.recording.openHistory(h.seed("finished"));
      const ws = await h.connect();
      end(ws, "finished", 5, 0.5, "late-capture");
      // There is no recognizer or acknowledgement in viewing mode. Allow the real WS handler to run.
      await wait(20);
      expect(h.recording.state).toBe("viewing");
      expect(await h.gaps("finished")).toEqual([]);
      expect((await h.document("finished")).audioGaps).toEqual([]);
      expect(h.worker.audioFrames).toBe(0);
      for (const call of h.modelCalls) expect(call).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it("rejects foreign, duplicate and inverted imported gap evidence before any durable write", async () => {
    const h = await fixture();
    try {
      h.seed("source");
      const source = await h.document("source");
      const gap = { id: "gap-1", sessionId: "source", stage: "capture_backend", reason: "sequence_gap", certainty: "observed", startTime: 1, endTime: 2, createdAt: 1 };
      const originalCount = h.sessions.list(100).length;
      for (const audioGaps of [[{ ...gap, sessionId: "foreign" }], [gap, gap], [{ ...gap, endTime: 0 }]]) {
        const response = await h.app.inject({ method: "POST", url: "/api/session/import", payload: { ...source, audioGaps } });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: "invalid_session_document" });
        expect(h.sessions.list(100)).toHaveLength(originalCount);
        expect(h.audioGaps.list("source")).toEqual([]);
      }
      for (const call of h.modelCalls) expect(call).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it("keeps persisted evidence after closing and reopening a SQLite file under a Chinese path with spaces", () => {
    const dir = mkdtempSync(join(tmpdir(), "rcc-音频缺口 integration-"));
    const path = join(dir, "会议 数据.sqlite");
    let db = openSqlite(path);
    try {
      new SqliteSessionRepository(db.db).create({ id: "saved", startedAt: 1, endedAt: 2, status: "completed" });
      const saved = new SqliteAudioGapRepository(db.db).record("saved", { stage: "capture_backend", reason: "capture_tail", certainty: "observed", startTime: 2, endTime: 3 });
      db.close();
      db = openSqlite(path);
      expect(new SqliteAudioGapRepository(db.db).list("saved")).toEqual([saved]);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
