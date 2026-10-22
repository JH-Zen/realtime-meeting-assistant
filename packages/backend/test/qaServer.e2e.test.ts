import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { decodeServerEvent, type ServerEvent } from "@rcc/shared";
import { createServer } from "../src/server/apiServer.js";
import { createBus } from "../src/bus/eventBus.js";
import type { BackendConfig } from "../src/config/env.js";
import { MockLLMProvider } from "../src/llm/MockLLMProvider.js";
import { RecordingController } from "../src/recording/RecordingController.js";
import { SessionRuntime } from "../src/runtime/SessionRuntime.js";
import { openSqlite } from "../src/store/sqlite.js";
import { SqliteGraphRepository } from "../src/store/graphRepository.js";
import { SqliteSummaryRepository } from "../src/store/summaryRepository.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { SqliteTranscriptRepository } from "../src/store/transcriptRepository.js";
import { SqliteEmbeddingRepository } from "../src/store/embeddingRepository.js";
import { SqliteQaRepository } from "../src/store/qaRepository.js";
import { MockEmbeddingProvider } from "../src/retrieval/MockEmbeddingProvider.js";
import { MOCK_SCRIPT } from "../src/testing/mockScript.js";
import { makeConfig, silentLoopDelay, stubModules } from "./helpers.js";

/**
 * Question answering over the real socket: the command is validated, the answer streams back as
 * frames the client can actually decode, and the recording keeps running underneath it (§27, and
 * acceptance Test C — "录音过程中问…录音继续 / STT继续 / MindMap继续 / QA回答"). Killing a module
 * and watching the rest survive is Test E, and lives in `faultIsolation.e2e.test.ts`.
 */

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function serve(overrides: Partial<BackendConfig> = {}) {
  const config = makeConfig({
    mockSttSpeed: 500,
    hotContextSec: 120,
    mindmap: { minSegments: 2, maxIntervalMs: 60, windowSec: 120 },
    ...overrides,
  });
  const store = openSqlite(":memory:");
  const bus = createBus();
  const transcripts = new SqliteTranscriptRepository(store.db);
  const llm = new MockLLMProvider();
  const recording = new RecordingController(bus, new SqliteSessionRepository(store.db), (session) =>
    new SessionRuntime(session, bus, config, llm, new MockEmbeddingProvider(), {
      transcripts,
      graphs: new SqliteGraphRepository(store.db),
      summaries: new SqliteSummaryRepository(store.db),
      embeddings: new SqliteEmbeddingRepository(store.db),
      qa: new SqliteQaRepository(store.db),
    }),
  );
  const app = await createServer({
    bus,
    config,
    recording,
    providerNames: { stt: "mock", llm: "mock", embedding: "mock" },
    modules: stubModules(),
    loopDelay: silentLoopDelay(),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { app, bus, recording, db: store.db, url: `ws://127.0.0.1:${port}`, close: () => app.close() };
}

async function connect(url: string): Promise<{ ws: WebSocket; events: ServerEvent[]; undecodable: unknown[] }> {
  const ws = new WebSocket(url);
  const events: ServerEvent[] = [];
  const undecodable: unknown[] = [];
  ws.on("message", (raw: Buffer) => {
    const text = raw.toString("utf8");
    const event = decodeServerEvent(text);
    if (event) events.push(event);
    else undecodable.push(JSON.parse(text));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, events, undecodable };
}

const send = (ws: WebSocket, command: unknown) => ws.send(JSON.stringify(command));

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3000): Promise<T> {
  for (let taken = 0; taken < timeoutMs / 25; taken++) {
    const value = read();
    if (value) return value;
    await wait(25);
  }
  throw new Error("timed out waiting for the answer to finish");
}

describe("QA over the websocket", () => {
  it("streams a decoded answer while the recording keeps producing finals (Test C)", async () => {
    const server = await serve();
    const client = await connect(`${server.url}/ws`);

    send(client.ws, { cmd: "recording.start", source: "mock" });
    await wait(400);
    const finalsBefore = client.events.filter((event) => event.kind === "transcript.final").length;
    expect(finalsBefore).toBeGreaterThan(0);

    send(client.ws, { cmd: "question.ask", questionId: "q-1", text: "世界模型是什么？" });

    const finished = await waitFor(() =>
      client.events.find((event) => event.kind === "answer.completed" && event.questionId === "q-1"),
    );
    const tokens = client.events.filter(
      (event): event is Extract<ServerEvent, { kind: "answer.token" }> =>
        event.kind === "answer.token" && event.questionId === "q-1",
    );
    // Type predicate rather than a boolean: the row below compares the stored snapshot against the
    // event's, and the union only narrows if the finder says which member it matched.
    const started = client.events.find(
      (event): event is Extract<ServerEvent, { kind: "answer.started" }> =>
        event.kind === "answer.started" && event.questionId === "q-1",
    );

    expect(client.undecodable).toEqual([]);
    expect(started?.snapshotId).toBeTruthy();
    expect(tokens.length).toBeGreaterThan(1);
    // Cumulative, monotonically growing text — the client renders it without stitching.
    expect(tokens.every((token, index) => token.text.length >= (tokens[index - 1]?.text.length ?? 0))).toBe(true);
    if (finished.kind !== "answer.completed" || !started) throw new Error("expected an answer");
    expect(finished.text).toContain("世界模型");
    expect(finished.degraded).toBe(false);
    expect(finished.citations.length).toBeGreaterThan(0);

    // Test C's other three clauses, named so a reader can find them. The mock here plays the whole
    // 79 s script in ~158 ms (`mockSttSpeed: 500`), so "STT 继续 / MindMap 继续" can only be read as
    // completeness in this session, not simultaneity with the answer: the question must not cost a
    // single final, and the map must still have grown. Strict overlap of a token and a final is what
    // the 60-minute soak supplies, where QA and the map really do run in the same minutes.
    expect(client.events.filter((event) => event.kind === "transcript.final")).toHaveLength(MOCK_SCRIPT.length);
    expect(client.events.filter((event) => event.kind === "mindmap.updated").length).toBeGreaterThan(0);

    // §40 history through the production wiring: what the socket streamed must be readable afterwards,
    // or a reload loses the exchange — which is exactly the dead-table defect OPEN-4 was.
    const stored = server.db
      .prepare(
        `SELECT q.snapshot_id, a.text, a.citations, a.duration_ms, a.degraded
           FROM questions q JOIN answers a ON a.question_id = q.id WHERE q.id = ?`,
      )
      .get("q-1") as unknown as {
      snapshot_id: string;
      text: string;
      citations: string;
      duration_ms: number;
      degraded: number;
    };
    expect(stored.snapshot_id).toBe(started.snapshotId);
    expect(stored.text).toBe(finished.text);
    expect(JSON.parse(stored.citations)).toEqual(finished.citations);
    expect(stored.degraded).toBe(0);

    // The question must not have taken the recording with it.
    send(client.ws, { cmd: "recording.stop" });
    const stopped = await waitFor(() => client.events.find((event) => event.kind === "recording.stopped"));
    expect(stopped.kind).toBe("recording.stopped");
    expect(client.events.filter((event) => event.kind === "module.error")).toEqual([]);

    client.ws.close();
    await server.close();
  });

  it("refuses the next question on the wire instead of queueing it", async () => {
    // §3: a pile-up of AI requests is the failure being prevented, so the refusal has to reach the
    // client as a frame it can decode — a question that is dropped in silence looks identical to one
    // whose answer is still coming.
    const server = await serve({ qa: { minIntervalMs: 60_000 } });
    const client = await connect(`${server.url}/ws`);

    send(client.ws, { cmd: "recording.start", source: "mock" });
    await wait(300);
    send(client.ws, { cmd: "question.ask", questionId: "q-1", text: "世界模型是什么？" });
    await waitFor(() =>
      client.events.find((event) => event.kind === "answer.completed" && event.questionId === "q-1"),
    );

    send(client.ws, { cmd: "question.ask", questionId: "q-2", text: "紧接着再问一次。" });
    const refusal = await waitFor(() =>
      client.events.find((event) => event.kind === "answer.rejected" && event.questionId === "q-2"),
    );
    if (refusal.kind !== "answer.rejected") throw new Error("expected a refusal");
    expect(refusal.reason).toBe("rate_limited");
    expect(refusal.retryAfterMs).toBeGreaterThan(0);
    expect(refusal.message).toContain("秒");

    expect(client.undecodable).toEqual([]);
    expect(client.events.some((event) => event.kind === "answer.started" && event.questionId === "q-2")).toBe(false);
    expect(client.events.filter((event) => event.kind === "module.error")).toEqual([]);
    // The refused question is not half-remembered either: nothing was spent on it, so nothing is stored.
    expect(server.db.prepare("SELECT id FROM questions WHERE id = 'q-2'").all()).toEqual([]);

    client.ws.close();
    await server.close();
  });

  it("answers without a recording instead of hanging the client", async () => {
    const server = await serve();
    const client = await connect(`${server.url}/ws`);

    send(client.ws, { cmd: "question.ask", questionId: "q-0", text: "现在能问吗？" });

    const failure = await waitFor(() =>
      client.events.find(
        (event) => event.kind === "module.error" && event.module === "qa" && event.code === "qa_no_session",
      ),
    );
    expect(failure.kind).toBe("module.error");
    expect(client.events.some((event) => event.kind === "answer.started")).toBe(false);

    client.ws.close();
    await server.close();
  });
});
