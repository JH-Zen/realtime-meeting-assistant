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
import { registerDesktopAccess } from "./desktopAccess.js";
import { registerBrowserAccess, type BrowserAccessOptions } from "./browserAccess.js";
import { recordingSttReadiness } from "../stt/probe.js";
import type { SqliteRecoveryTaskRepository } from "../store/recoveryTaskRepository.js";

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
  recoveryTasks?: SqliteRecoveryTaskRepository;
  desktop?: { instanceId: string; token: string };
  browserAccess?: BrowserAccessOptions;
}

/** A 60-minute session is a few hundred KB of text, and the default 1 MB limit would refuse it. */
const BODY_LIMIT_BYTES = 32 * 1024 * 1024;

export async function createServer(deps: ServerDeps) {
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });
  // Register after the WS plugin so a refused upgrade still runs its socket cleanup hook.
  if (deps.desktop) registerDesktopAccess(app, deps.desktop.token);
  else if (deps.browserAccess) registerBrowserAccess(app, deps.browserAccess);

  app.get("/health", () => ({
    ok: true,
    ...(deps.desktop ? { instanceId: deps.desktop.instanceId, pid: process.pid } : {}),
    state: deps.recording.state,
    sessionId: deps.recording.sessionId,
    elapsedSec: round1(deps.recording.elapsedSec()),
    mockStt: deps.config.mockStt,
    mockLlm: deps.config.mockLlm,
    providers: deps.providerNames,
    modules: deps.modules,
  }));

  app.get("/api/modes", () => ({
    stt: deps.config.mockStt ? "mock" : "live",
    llm: deps.providerNames.llm,
    embedding: deps.providerNames.embedding,
    embeddingReady: deps.config.embedding.mock || deps.modules.filter((module) => module.id === "m1" || module.id === "m2").every((module) => module.installed),
  }));

  app.get<{ Querystring: { source?: string } }>("/api/recording/preflight", async (request, reply) => {
    if (request.query.source === "mock") return { ready: true, message: "本次输入为模拟讲解，不进行语音识别。" };
    if (request.query.source !== undefined && request.query.source !== "mic") return reply.code(400).send({ ready: false, message: "未知输入来源。" });
    return recordingSttReadiness(deps.config, deps.recording.current);
  });

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

  app.get<{ Querystring: { limit?: string; offset?: string } }>("/api/sessions", (request, reply) => {
    const limit = pageNumber(request.query.limit, 50, 1, 100);
    const offset = pageNumber(request.query.offset, 0, 0, 1_000_000);
    if (limit === null || offset === null) return reply.code(400).send({ error: "invalid_pagination", message: "会议列表分页参数无效。" });
    const rows = deps.store.sessions.list(limit + 1, offset);
    return { sessions: rows.slice(0, limit), hasMore: rows.length > limit };
  });

  app.post<{ Params: { id: string } }>("/api/session/:id/open", (request, reply) => {
    const session = deps.store.sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "no_such_session", message: "本机找不到这场会议。" });
    if (!deps.recording.openHistory(session)) return reply.code(409).send({ error: "recording_in_progress", message: "请先结束当前录音，等待整理完成后再打开历史会议。" });
    return { sessionId: session.id, opened: true };
  });

  app.get<{ Params: { id: string } }>("/api/session/:id/retrieval", (request, reply) => {
    const runtime = deps.recording.current;
    if (!runtime || runtime.session.id !== request.params.id) {
      return reply.code(409).send({ error: "session_changed", message: "当前会议已切换，请在目标会议中重试。" });
    }
    // Comparing durable text and usable vectors is read-only; opening history never calls a model.
    return runtime.retrieval.recoveryStatus;
  });

  app.get<{ Params: { id: string } }>("/api/session/:id/audio-gaps", (request, reply) => {
    if (deps.recording.sessionId !== request.params.id) return reply.code(409).send({ error: "session_changed", message: "当前会议已切换。" });
    return { sessionId: request.params.id, gaps: deps.store.audioGaps?.list(request.params.id) ?? [] };
  });

  app.get<{ Params: { id: string }; Querystring: { scope?: string } }>("/api/session/:id/recovery-tasks", (request, reply) => {
    if (!deps.recording.current || deps.recording.sessionId !== request.params.id) {
      return reply.code(409).send({ error: "session_changed", message: "当前会议已切换，请重新打开目标会议。" });
    }
    const scope = request.query.scope ?? "all";
    if (scope !== "manual" && scope !== "live" && scope !== "all") return reply.code(400).send({ error: "invalid_scope", message: "任务记录范围无效。" });
    if (!deps.recoveryTasks) return reply.code(503).send({ error: "audit_unavailable", message: "补建任务记录不可用，不能确认历史尝试。" });
    try { return { sessionId: request.params.id, tasks: deps.recoveryTasks.list(request.params.id, 10, scope) }; }
    catch { return reply.code(503).send({ error: "audit_read_failed", message: "补建任务记录读取失败，请检查日志和磁盘空间。" }); }
  });

  app.post<{ Params: { id: string } }>("/api/session/:id/retrieval/rebuild", (request, reply) => {
    const runtime = deps.recording.current;
    if (!runtime || runtime.session.id !== request.params.id) {
      return reply.code(409).send({ error: "session_changed", message: "当前会议已切换，请在目标会议中重试。" });
    }
    if (deps.recording.state !== "viewing" || deps.recording.transitioning) {
      return reply.code(409).send({ error: "recording_in_progress", message: "请先结束录音，等待整理完成后再补建检索索引。" });
    }
    // The runtime owns the job and cancels it on selection/exit. HTTP disconnects don't start a
    // second job, and the route returns immediately so status and normal UI remain responsive.
    void runtime.retrieval.rebuildMissing().catch((error: unknown) => {
      log.warn("explicit index recovery failed", { sessionId: runtime.session.id, message: String(error) });
    });
    return reply.code(202).send({ accepted: true, status: runtime.retrieval.recoveryStatus });
  });

  app.get<{ Params: { id: string } }>("/api/session/:id/mindmap/recovery", (request, reply) => {
    const runtime = deps.recording.current;
    if (!runtime || runtime.session.id !== request.params.id) {
      return reply.code(409).send({ error: "session_changed", message: "当前会议已切换，请在目标会议中重试。" });
    }
    return runtime.mindmap.recoveryStatus;
  });

  app.post<{ Params: { id: string }; Body?: { allowUntracked?: boolean } }>("/api/session/:id/mindmap/rebuild", (request, reply) => {
    const runtime = deps.recording.current;
    if (!runtime || runtime.session.id !== request.params.id) {
      return reply.code(409).send({ error: "session_changed", message: "当前会议已切换，请在目标会议中重试。" });
    }
    if (deps.recording.state !== "viewing" || deps.recording.transitioning) {
      return reply.code(409).send({ error: "recording_in_progress", message: "请先结束录音，等待整理完成后再补建导图。" });
    }
    if (request.body !== undefined && (request.body === null || typeof request.body !== "object" || Array.isArray(request.body) ||
      (request.body.allowUntracked !== undefined && typeof request.body.allowUntracked !== "boolean"))) {
      return reply.code(400).send({ error: "invalid_recovery_options", message: "导图补建选项无效。" });
    }
    if (runtime.mindmap.recoveryStatus.legacyUntracked && request.body?.allowUntracked !== true) {
      return reply.code(409).send({ error: "untracked_graph", message: "这份导图没有处理记录；补建可能重复或调整已有节点，请阅读提示后明确启动。" });
    }
    void runtime.mindmap.rebuildMissing();
    return reply.code(202).send({ accepted: true, status: runtime.mindmap.recoveryStatus });
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
    if (state === "recording" || state === "paused" || deps.recording.transitioning) {
      // Refuse before writing if input is active. A later concurrent selection/start is respected
      // below: the imported copy stays in the list without stealing that newer selection.
      reply.code(409).send({ error: "recording_in_progress", message: "请先结束当前录音，再导入历史会话" });
      return;
    }
    const selectionVersion = deps.recording.selectionVersion;
    const sessionId = randomUUID();
    const outcome = await importSessionDocument(deps.store, request.body, deps.embedding, { sessionId });
    if (!outcome.ok) {
      log.warn("session import refused", { sessionId, issues: outcome.issues.length });
      reply.code(400).send({ error: "invalid_session_document", issues: outcome.issues });
      return;
    }
    const session = deps.store.sessions.get(outcome.sessionId);
    const opened = session ? deps.recording.openHistory(session, selectionVersion) : false;
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
    let audioSessionId: string | null = null;
    const send = (event: ServerEvent) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(encodeServerEvent(event));
    };
    const offs = [
      deps.bus.on("ui", "session.changed", (payload) => {
        if (payload.sessionId === deps.recording.sessionId) sendSessionSnapshot(deps.recording, send);
      }),
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
    sendSessionSnapshot(deps.recording, send);

    socket.on("message", (raw: Buffer) => {
      const command = decodeClientCommand(raw.toString("utf8"));
      if (!command) {
        log.warn("dropped malformed client command", { bytes: raw.length });
        return;
      }
      if (command.cmd === "audio.chunk" && command.capture?.sessionId === deps.recording.sessionId) audioSessionId = command.capture.sessionId;
      void handleCommand(command, deps, send).catch((error: unknown) => {
        log.error("client command failed", { command: command.cmd, message: String(error) });
        send({ kind: "module.error", module: "bus", code: "command_failed", message: `操作未完成：${error instanceof Error ? error.message : String(error)}`, at: Date.now(), recoverable: true });
      });
    });

    socket.on("close", () => {
      if (audioSessionId && audioSessionId === deps.recording.sessionId) deps.recording.current?.audio.transportLost(deps.recording.elapsedSec());
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
      await deps.recording.finish();
      break;
    case "session.close":
      if (deps.recording.state === "recording" || deps.recording.state === "paused" || deps.recording.transitioning) {
        throw new Error("请先结束录音，等待整理完成后再关闭会议。");
      }
      await deps.recording.closeSession();
      break;
    case "audio.chunk":
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(command.pcmBase64)) break;
      {
        const bytes = Buffer.from(command.pcmBase64, "base64");
        if (bytes.length === 0 || bytes.length % 2 !== 0 || bytes.length > deps.config.stt.sampleRate * 2) break;
        deps.recording.provideAudio(toArrayBuffer(bytes), command.capture, command.seq);
      }
      break;
    case "audio.capture.end":
      deps.recording.endAudioCapture(command.capture);
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
      if (command.sessionId && command.sessionId !== runtime?.session.id) {
        send({ kind: "answer.rejected", sessionId: command.sessionId, questionId: command.questionId, reason: "session_changed", message: "当前会议已切换，这个问题未发送给新会议。请在目标会议中重新提问。", retryAfterMs: 0 });
        break;
      }
      // The answer streams back over the same socket as the subtitles; nothing here awaits it.
      if (!runtime) {
        send({
          kind: "module.error",
          module: "qa",
          code: "qa_no_session",
          message: "请先开始录音或打开一场本机会议，再就内容提问",
          at: Date.now(),
          recoverable: true,
        });
        break;
      }
      await runtime.qa.ask(command.questionId, command.text);
      break;
  }
}

/** Every selection and reconnect uses the same ordered replacement, including saved Q&A. */
function sendSessionSnapshot(recording: RecordingController, send: (event: ServerEvent) => void): void {
  const runtime = recording.current;
  const sessionId = runtime?.session.id;
  send({
    kind: "session.snapshot",
    ...(runtime ? { sessionId, session: runtime.session } : {}),
    state: recording.state,
    elapsedSec: round1(recording.elapsedSec()),
    stt: runtime?.sttStatus ?? "idle",
    serverTime: Date.now(),
  });
  if (!runtime || !sessionId) return;
  const graph = runtime.graph.snapshot();
  send({ kind: "graph.snapshot", sessionId, nodes: graph.nodes, edges: graph.edges, positions: pinnedPositions(runtime.graph.positions()) });
  send({ kind: "transcript.snapshot", sessionId, segments: runtime.transcript.allFinals(sessionId) });
  send({ kind: "answers.snapshot", sessionId, exchanges: runtime.exchanges(), pendingQuestionIds: runtime.qa.pendingQuestionIds });
}

function pageNumber(raw: unknown, fallback: number, min: number, max: number): number | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
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
