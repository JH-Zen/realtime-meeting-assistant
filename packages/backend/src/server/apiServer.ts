import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  decodeClientCommand,
  encodeServerEvent,
  type ClientCommand,
  type ServerEvent,
} from "@rcc/shared";
import type { AppBus } from "../bus/eventBus.js";
import type { BackendConfig } from "../config/env.js";
import { log } from "../observability/log.js";
import type { LoopDelayMonitor } from "../observability/loopDelay.js";
import type { ModuleStatus } from "../observability/modules.js";
import type { RecordingController } from "../recording/RecordingController.js";
import type { EmbeddingProvider } from "../retrieval/EmbeddingProvider.js";
import { exportSessionDocument, sessionFileName } from "../session/sessionExport.js";
import { importSessionDocument, type ImportRepositories } from "../session/sessionImport.js";
import { registerStaticFiles } from "./staticFiles.js";

/**
 * The client is a remote listener on the same bus. Everything the browser may do arrives as a
 * validated command; everything it learns leaves as a validated event. Nothing else crosses the
 * boundary, so the frontend cannot steer the graph directly (§20).
 *
 * The one exception is the session file (§13 OPEN-10): a downloadable artifact is an HTTP body, not a
 * bus event, so export and import are the two routes that talk to the store directly instead of
 * through the recording.
 *
 * The other is the page itself. An installed app ships no dev server, so `/*` hands out the built
 * frontend (`staticFiles.ts`) — but it reads only the file a URL names and touches neither store nor
 * bus, so the boundary above still holds for everything that can change the graph.
 */
export interface ServerDeps {
  bus: AppBus;
  config: BackendConfig;
  recording: RecordingController;
  providerNames: { stt: string; llm: string; embedding: string };
  /** Optional modules read off the disk at boot. An installed app ships core only, so this is how a missing
   *  M1/M2/M3 reaches a caller instead of staying in a log file nobody opens. */
  modules: ModuleStatus[];
  /** Live window of main-loop delay; the debug panel shows the worst thing a soak run can reveal. */
  loopDelay: LoopDelayMonitor;
  /** Every repository an export reads or an import writes, assembled by the composition root. */
  store: ImportRepositories;
  embedding: EmbeddingProvider;
}

/** A 60-minute session is a few hundred KB of text, and the default 1 MB limit would refuse it. */
const BODY_LIMIT_BYTES = 32 * 1024 * 1024;

export async function createServer(deps: ServerDeps) {
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  app.get("/health", () => ({
    ok: true,
    state: deps.recording.state,
    sessionId: deps.recording.sessionId,
    elapsedSec: round1(deps.recording.elapsedSec()),
    mockStt: deps.config.mockStt,
    mockLlm: deps.config.mockLlm,
    providers: deps.providerNames,
    modules: deps.modules,
  }));

  app.get("/api/session", () => {
    const runtime = deps.recording.current;
    if (!runtime) {
      return { sessionId: null, state: deps.recording.state, segments: [], nodes: [], edges: [], positions: {} };
    }
    const graph = runtime.graph.snapshot();
    return {
      sessionId: runtime.session.id,
      state: deps.recording.state,
      elapsedSec: round1(deps.recording.elapsedSec()),
      segments: runtime.transcript.allFinals(runtime.session.id),
      nodes: graph.nodes,
      edges: graph.edges,
      positions: runtime.graph.positions(),
    };
  });

  /**
   * One session as a downloadable file (§13 OPEN-10). Reading a session other than the live one needs
   * nothing special — every repository method already took an explicit id; what was missing was a
   * caller.
   */
  app.get<{ Params: { id: string } }>("/api/session/:id/export", (request, reply) => {
    const document = exportSessionDocument(deps.store, request.params.id);
    if (!document) {
      reply.code(404).send({ error: "no_such_session", sessionId: request.params.id });
      return;
    }
    // Sent so a link or a `curl -O` lands on a name that says which session the file came from.
    reply.header("content-disposition", `attachment; filename="${sessionFileName(request.params.id)}"`);
    return document;
  });

  /**
   * Import a file under a fresh id and open it as a history the user can ask questions about. The id
   * is the server's rather than the file's, because a second import of the same file must not
   * overwrite the first — and because `questions.id` is globally unique, which is the one identity the
   * importer has to namespace (see `sessionImport`).
   */
  app.post("/api/session/import", async (request, reply) => {
    const state = deps.recording.state;
    if (state === "recording" || state === "paused") {
      // Refuse before writing, so no session is left imported-but-unopened.
      reply.code(409).send({ error: "recording_in_progress", message: "请先结束当前录音，再导入历史会话" });
      return;
    }
    const sessionId = randomUUID();
    const outcome = await importSessionDocument(deps.store, request.body, deps.embedding, { sessionId });
    if (!outcome.ok) {
      log.warn("session import refused", { sessionId, issues: outcome.issues.length });
      reply.code(400).send({ error: "invalid_session_document", issues: outcome.issues });
      return;
    }
    const session = deps.store.sessions.get(outcome.sessionId);
    const opened = session ? deps.recording.openHistory(session) : false;
    reply.code(201).send({ sessionId: outcome.sessionId, opened, counts: outcome.counts });
  });

  /**
   * The Q&A a session recorded. Answers stream and are never replayed, so a tab that reloads — or one
   * that opened an imported session — has nowhere else to read what was already asked (§13 OPEN-10).
   */
  app.get<{ Params: { id: string } }>("/api/session/:id/questions", (request, reply) => {
    if (!deps.store.sessions.get(request.params.id)) {
      reply.code(404).send({ error: "no_such_session", sessionId: request.params.id });
      return;
    }
    return { sessionId: request.params.id, exchanges: deps.store.qa.listExchanges(request.params.id) };
  });

  /**
   * Answers the preflight a JSON `POST` provokes (a websocket never sends one). The headers themselves
   * are set by the `onSend` hook in the composition root, next to the origin decision they belong to;
   * without this route Fastify would reply 404 to `OPTIONS` and the browser would report the import as
   * a network failure with no reason in it.
   */
  app.options("/api/*", (_request, reply) => {
    reply.code(204).send();
  });

  /** Debug panel feed (§48): queue depth and counters that are not part of the UI contract. */
  app.get("/api/debug", () => {
    const runtime = deps.recording.current;
    return {
      bus: deps.bus.snapshot(),
      recording: { state: deps.recording.state, elapsedSec: round1(deps.recording.elapsedSec()) },
      mindmap: {
        pending: runtime?.mindmap.pendingCount ?? 0,
        busy: runtime?.mindmap.isBusy ?? false,
        nodeCount: runtime?.graph.snapshot().nodes.length ?? 0,
      },
      memory: {
        pending: runtime?.memory.pendingCount ?? 0,
        busy: runtime?.memory.isBusy ?? false,
        blocks: runtime?.memory.blockCount ?? 0,
      },
      retrieval: {
        pending: runtime?.retrieval.pendingCount ?? 0,
        busy: runtime?.retrieval.isBusy ?? false,
        indexed: runtime?.retrieval.indexedCount ?? 0,
        dropped: runtime?.retrieval.droppedCount ?? 0,
        topK: deps.config.retrieval.topK,
      },
      // The mic path fails for one of three reasons — Mock Mode is on, the worker is not running, or
      // the sample rates disagree — and each one needs a different fix, so all three are visible here.
      stt: {
        mockMode: deps.config.mockStt,
        workerUrl: deps.config.stt.wsUrl,
        sampleRate: deps.config.stt.sampleRate,
        state: runtime?.sttStatus ?? "idle",
        engine: runtime?.sttEngine ?? null,
      },
      recentOperations: runtime?.graph.recentOperations(12) ?? [],
      // Read, not consumed: the periodic `loop_delay` metric record is what a soak run is grepped for.
      loopDelay: deps.loopDelay.snapshot(),
      // Test F asks for "no leak", which is a slope over time, not a snapshot — so the heap has to be
      // on the same sampled surface as the queue depths instead of living only in a profiler session.
      process: (() => {
        const usage = process.memoryUsage();
        return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed, externalBytes: usage.external };
      })(),
    };
  });

  app.get("/ws", { websocket: true }, (socket: WebSocket) => {
    const send = (event: ServerEvent) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(encodeServerEvent(event));
    };
    const runtime = deps.recording.current;
    const sessionId = runtime?.session.id ?? "";

    const offs = [
      deps.bus.on("ui", "transcript.partial", (segment) => send({ kind: "transcript.partial", segment })),
      deps.bus.on("ui", "transcript.final", (segment) => send({ kind: "transcript.final", segment })),
      deps.bus.on("ui", "recording.started", (payload) => send({ kind: "recording.started", ...payload })),
      deps.bus.on("ui", "recording.paused", (payload) => send({ kind: "recording.paused", ...payload })),
      deps.bus.on("ui", "recording.resumed", (payload) => send({ kind: "recording.resumed", ...payload })),
      deps.bus.on("ui", "recording.stopped", (payload) => send({ kind: "recording.stopped", ...payload })),
      deps.bus.on("ui", "stt.status", (payload) => send({ kind: "stt.status", ...payload })),
      deps.bus.on("ui", "mindmap.updated", (payload) => send({ kind: "mindmap.updated", ...payload })),
      deps.bus.on("ui", "mindmap.node.upserted", (node) => send({ kind: "mindmap.node.upserted", node })),
      deps.bus.on("ui", "mindmap.skipped", (payload) => send({ kind: "mindmap.skipped", ...payload })),
      deps.bus.on("ui", "summary.updated", (payload) => send({ kind: "summary.updated", ...payload })),
      deps.bus.on("ui", "answer.started", (payload) => send({ kind: "answer.started", ...payload })),
      deps.bus.on("ui", "answer.token", (payload) => send({ kind: "answer.token", ...payload })),
      deps.bus.on("ui", "answer.completed", (payload) => send({ kind: "answer.completed", ...payload })),
      deps.bus.on("ui", "answer.rejected", (payload) => send({ kind: "answer.rejected", ...payload })),
      deps.bus.on("ui", "module.error", (error) => send({ kind: "module.error", ...error })),
    ];

    // A client that connects mid-session must see the current tree, not only what arrives next — and
    // must see it at the coordinates the last client left it, or Test B's "重载后图不能跳" is a
    // promise nobody can keep. Only dragged positions are sent; the rest the client re-derives.
    const graph = runtime?.graph.snapshot();
    send({
      kind: "session.snapshot",
      ...(sessionId ? { sessionId } : {}),
      state: deps.recording.state,
      elapsedSec: round1(deps.recording.elapsedSec()),
      stt: runtime?.sttStatus ?? "idle",
      serverTime: Date.now(),
    });
    if (graph && runtime) {
      const positions = pinnedPositions(runtime.graph.positions());
      send({ kind: "graph.snapshot", sessionId, nodes: graph.nodes, edges: graph.edges, positions });
    }
    if (runtime) {
      send({
        kind: "transcript.snapshot",
        sessionId,
        segments: runtime.transcript.allFinals(sessionId),
      });
    }

    socket.on("message", (raw: Buffer) => {
      const command = decodeClientCommand(raw.toString("utf8"));
      if (!command) {
        log.warn("dropped malformed client command", { bytes: raw.length });
        return;
      }
      void handleCommand(command, deps, send);
    });

    socket.on("close", () => {
      for (const off of offs) off();
    });
    socket.on("error", (error: Error) => log.warn("websocket error", { message: error.message }));
  });

  // Mounted last, and still only as a fallback: every route above is a more specific pattern than `/*`,
  // so `/health` and `/api/*` keep answering even when a file of the same name exists in the build.
  registerStaticFiles(app, deps.config.staticDir);

  return app;
}

async function handleCommand(
  command: ClientCommand,
  deps: ServerDeps,
  send: (event: ServerEvent) => void,
): Promise<void> {
  const runtime = deps.recording.current;
  switch (command.cmd) {
    case "recording.start":
      await deps.recording.start(command.source);
      break;
    case "recording.pause":
      deps.recording.pause();
      break;
    case "recording.resume":
      deps.recording.resume();
      break;
    case "recording.stop":
      await deps.recording.stop();
      break;
    case "audio.chunk":
      deps.recording.provideAudio(toArrayBuffer(Buffer.from(command.pcmBase64, "base64")));
      break;
    case "mindmap.forceUpdate":
      await runtime?.mindmap.flush();
      break;
    case "mindmap.node.moved":
      // The node has to exist: the client is a remote listener and may hold an id its own tree has
      // already dropped, and an orphan row would outlive the node it belonged to.
      if (runtime?.graph.graphState.nodes[command.nodeId]) {
        runtime.graph.savePosition(command.nodeId, command.x, command.y, true);
      }
      break;
    case "question.ask":
      // The answer streams back over the same socket as the subtitles; nothing here awaits it.
      if (!runtime) {
        send({
          kind: "module.error",
          module: "qa",
          code: "qa_no_session",
          message: "还没有进行中的记录，无法就内容提问",
          at: Date.now(),
          recoverable: true,
        });
        break;
      }
      await runtime.qa.ask(command.questionId, command.text);
      break;
  }
}

/** Only a dragged position is restored; a layout-derived one is allowed to move when the tree grows. */
function pinnedPositions(saved: Record<string, { x: number; y: number; pinned: boolean }>) {
  const out: Record<string, { x: number; y: number }> = {};
  for (const [nodeId, position] of Object.entries(saved)) {
    if (position.pinned) out[nodeId] = { x: position.x, y: position.y };
  }
  return out;
}

/** The STT seam takes a standalone buffer; a Node `Buffer` may share a pooled ArrayBuffer. */
function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
