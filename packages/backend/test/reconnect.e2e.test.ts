import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { decodeServerEvent, type ServerEvent } from "@rcc/shared";
import { createServer } from "../src/server/apiServer.js";
import { createBus } from "../src/bus/eventBus.js";
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
import { makeConfig, silentLoopDelay, stubModules } from "./helpers.js";

/**
 * What a reconnect is for (§45). The second socket is a client that has lost everything, so the
 * snapshots it is handed on connect have to restore the whole visible state — including the positions
 * the first client dragged nodes to, because a re-derived layout cannot reproduce those and Test B is
 * judged on the map not jumping.
 */

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function serve() {
  const config = makeConfig({
    mockSttSpeed: 500,
    hotContextSec: 120,
    mindmap: { minSegments: 2, maxIntervalMs: 60, windowSec: 120 },
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
  const base = `http://127.0.0.1:${port}`;
  return { app, recording, url: `ws://127.0.0.1:${port}/ws`, base, close: () => app.close() };
}

async function connect(url: string): Promise<{ ws: WebSocket; events: ServerEvent[] }> {
  const ws = new WebSocket(url);
  const events: ServerEvent[] = [];
  ws.on("message", (raw: Buffer) => {
    const event = decodeServerEvent(raw.toString("utf8"));
    if (event) events.push(event);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, events };
}

const send = (ws: WebSocket, command: unknown) => ws.send(JSON.stringify(command));

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3000): Promise<T> {
  for (let taken = 0; taken < timeoutMs / 25; taken++) {
    const value = read();
    if (value) return value;
    await wait(25);
  }
  throw new Error("timed out waiting for the reconnect snapshot");
}

describe("reconnect resync", () => {
  it("hands a fresh socket the graph and the positions the previous one dragged", async () => {
    const server = await serve();
    const first = await connect(server.url);

    send(first.ws, { cmd: "recording.start", source: "mock" });
    const upsert = await waitFor(() => first.events.find((event) => event.kind === "mindmap.node.upserted"));
    if (upsert?.kind !== "mindmap.node.upserted") throw new Error("expected a node");
    const nodeId = upsert.node.id;

    send(first.ws, { cmd: "mindmap.node.moved", nodeId, x: 1234.5, y: 42.25 });
    // A coordinate for a node this client has already lost must not become a row the next client is
    // told to honour.
    send(first.ws, { cmd: "mindmap.node.moved", nodeId: "n-gone", x: 7, y: 7 });
    await wait(100);

    const second = await connect(server.url);
    const snapshot = await waitFor(() =>
      second.events.find((event) => event.kind === "graph.snapshot" && event.nodes.some((node) => node.id === nodeId)),
    );
    if (snapshot?.kind !== "graph.snapshot") throw new Error("expected a graph snapshot");

    expect(snapshot.positions).toEqual({ [nodeId]: { x: 1234.5, y: 42.25 } });
    // The transcript is part of the same resync: subtitles must not restart from nothing.
    const resync = await waitFor(() => second.events.find((event) => event.kind === "transcript.snapshot"));
    if (resync?.kind !== "transcript.snapshot") throw new Error("expected a transcript snapshot");
    expect(resync.segments.length).toBeGreaterThan(0);

    const session = await (await fetch(`${server.base}/api/session`)).json();
    expect(session.positions[nodeId]).toEqual({ x: 1234.5, y: 42.25, pinned: true });
    expect(session.positions["n-gone"]).toBeUndefined();

    first.ws.close();
    second.ws.close();
    await server.close();
  });
});
