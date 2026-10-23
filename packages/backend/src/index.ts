import { loadConfig } from "./config/env.js";
import { openSqlite } from "./store/sqlite.js";
import { createBus } from "./bus/eventBus.js";
import { SqliteSessionRepository } from "./store/sessionRepository.js";
import { SqliteTranscriptRepository } from "./store/transcriptRepository.js";
import { SqliteGraphRepository } from "./store/graphRepository.js";
import { SqliteSummaryRepository } from "./store/summaryRepository.js";
import { SqliteEmbeddingRepository } from "./store/embeddingRepository.js";
import { SqliteQaRepository } from "./store/qaRepository.js";
import { SqliteAudioGapRepository } from "./store/audioGapRepository.js";
import { SqliteRecoveryTaskRepository } from "./store/recoveryTaskRepository.js";
import { MockLLMProvider } from "./llm/MockLLMProvider.js";
import { OpenAICompatProvider } from "./llm/OpenAICompatProvider.js";
import type { LLMProvider } from "./llm/LLMProvider.js";
import { MockEmbeddingProvider } from "./retrieval/MockEmbeddingProvider.js";
import { OnnxEmbeddingProvider } from "./retrieval/OnnxEmbeddingProvider.js";
import type { EmbeddingProvider } from "./retrieval/EmbeddingProvider.js";
import { SessionRuntime } from "./runtime/SessionRuntime.js";
import { RecordingController } from "./recording/RecordingController.js";
import { createServer } from "./server/apiServer.js";
import { deriveModules, missingEmbeddingModules } from "./observability/modules.js";
import { log } from "./observability/log.js";
import { createLoopDelayMonitor } from "./observability/loopDelay.js";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * Composition root. This is the only file that knows every concrete class, which is what keeps the
 * adapters swappable: nothing below it imports a third-party payload type.
 */
async function main(): Promise<void> {
  const instanceId = process.env.RCC_DESKTOP_INSTANCE;
  const desktopToken = process.env.RCC_DESKTOP_TOKEN;
  if (instanceId && (!process.send || !desktopToken)) throw new Error("Desktop requires a private IPC channel");
  // Install the parent-loss handler before opening stores or starting providers. A crashing desktop
  // closes its IPC handle; it never needs to enumerate or take ownership of another process.
  let parentGone = false;
  let shutdownRequested = false;
  let shutdown: (reason: string) => Promise<void> = async () => { parentGone = true; };
  if (instanceId) {
    process.once("disconnect", () => {
      parentGone = true;
      setTimeout(() => process.exit(1), 12_000).unref();
      void shutdown("desktop-disconnected");
    });
  }
  const config = loadConfig();
  if (instanceId) {
    config.host = "127.0.0.1";
    config.port = 0;
  }
  const store = openSqlite(config.dbPath);
  const bus = createBus();

  bus.onError((error) => {
    log.error(`module ${error.module} failed`, { code: error.code, message: error.message });
  });

  const sessions = new SqliteSessionRepository(store.db);
  const transcripts = new SqliteTranscriptRepository(store.db);
  const graphs = new SqliteGraphRepository(store.db);
  const summaries = new SqliteSummaryRepository(store.db);
  const embeddings = new SqliteEmbeddingRepository(store.db);
  const qa = new SqliteQaRepository(store.db);
  const audioGaps = new SqliteAudioGapRepository(store.db);
  const recoveryTasks = new SqliteRecoveryTaskRepository(store.db);
  // A single process startup boundary, before any restored runtime can create new work.
  recoveryTasks.interruptRunning();

  // Optional modules are read off the disk, not off an install-time ledger — see `observability/modules.ts`.
  const modules = deriveModules({
    root: process.cwd(),
    embeddingModelDir: config.embedding.modelDir,
    embeddingModel: config.embedding.model,
  });
  for (const module of modules) {
    const fields = { label: module.label, checked: module.checked };
    if (module.installed) log.info(`module ${module.id} installed`, fields);
    else log.warn(`module ${module.id} missing`, { ...fields, remedy: module.remedy });
  }

  const embeddingGaps = missingEmbeddingModules(modules);
  if (!config.embedding.mock && embeddingGaps.length > 0) {
    // Deliberately no Mock substitution: `MOCK_EMBEDDING=false` asks for real vectors, and quietly serving a
    // lexical floor instead is the silent fallback §50 forbids. The provider stays as configured, so every
    // failure is reported where it happens — this line is what makes it diagnosable before the first question.
    log.error("MOCK_EMBEDDING=false but the real embedding modules are not installed", {
      missing: embeddingGaps.map((module) => module.id),
      remedy: embeddingGaps.map((module) => module.remedy).join("；"),
      effect: "检索会持续失败；装好模块后重启即恢复。录音、导图、摘要不受影响，也可把 MOCK_EMBEDDING 改回 true 使用 Mock 检索",
    });
  }
  if (!config.mockStt && modules.some((module) => module.id === "m3" && !module.installed)) {
    const stt = modules.find((module) => module.id === "m3");
    log.warn("MOCK_STT=false and no in-package sherpa-onnx model was found", {
      checked: stt?.checked ?? [],
      remedy: stt?.remedy ?? "",
      effect: "安装包内未发现模型；若已从独立目录启动 STT worker，请以采集前的通道就绪检查为准",
    });
  }

  const llm: LLMProvider = config.mockLlm ? new MockLLMProvider() : new OpenAICompatProvider(config.llm);

  // Mock vectors keep the whole retrieval path testable with no download (§50); the ONNX provider
  // runs in a worker thread because inference measured off-thread is the only way to keep subtitles
  // moving (ADR §9.2 D-13).
  const onnx = config.embedding.mock ? null : new OnnxEmbeddingProvider(config.embedding);
  const embedding: EmbeddingProvider = onnx ?? new MockEmbeddingProvider();
  if (onnx && config.retrieval.minScore < 0.5) {
    log.warn("RETRIEVAL_MIN_SCORE is below the measured similarity floor of the real model", {
      minScore: config.retrieval.minScore,
      suggestion: 0.75,
      model: config.embedding.model,
    });
  }
  if (!onnx) {
    log.info("using mock embeddings", { note: "MOCK_EMBEDDING=true，检索质量为词法下界" });
  } else {
    // Warming up costs seconds (or a first-time download), so it must not land on the first question.
    void onnx
      .prewarm()
      .then(() => log.info("embedding provider prewarmed", { provider: onnx.name }))
      .catch((error: unknown) =>
        log.warn("embedding prewarm failed, retrieval will retry on first use", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
  }

  const recording = new RecordingController(bus, sessions, (session) =>
    new SessionRuntime(session, bus, config, llm, embedding, {
      transcripts,
      graphs,
      summaries,
      embeddings,
      qa,
      audioGaps,
      recoveryTasks,
    }),
  );
  if (recording.restoreSelected()) {
    log.info("restored saved session for review", { sessionId: recording.sessionId, input: "not-attached" });
  }

  // Sampled from boot so the first recording is already covered: Test F is judged on this number.
  const loopDelay = createLoopDelayMonitor(config.observability.loopDelayReportMs);
  loopDelay.start();

  const app = await createServer({
    bus,
    config,
    recording,
    providerNames: { stt: config.mockStt ? "mock" : "live", llm: llm.name, embedding: embedding.name },
    modules,
    loopDelay,
    store: { sessions, transcripts, graphs, summaries, qa, embeddings, audioGaps },
    embedding,
    recoveryTasks,
    desktop: instanceId && desktopToken ? { instanceId, token: desktopToken } : undefined,
    browserAccess: instanceId ? undefined : { token: randomBytes(32).toString("hex"), instanceId: randomUUID() },
  });

  shutdown = async (reason: string) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    log.info("shutting down", { reason, loopDelay: loopDelay.report() });
    // Also bounds cleanup after loss of the parent or shutdown of Windows.
    const deadline = setTimeout(() => process.exit(1), 12_000);
    deadline.unref();
    loopDelay.stop();
    try {
      // Refuse new commands while recording.stop drains the last accepted audio and derived work.
      for (const client of app.websocketServer.clients) client.close(1001, "application exiting");
      await recording.stop();
      await app.close();
      onnx?.dispose();
      store.close();
      log.info("backend cleanup complete", { reason });
      process.exit(0);
    } catch (error) {
      log.error("backend cleanup failed", { message: error instanceof Error ? error.message : String(error) });
      onnx?.dispose();
      store.close();
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  if (instanceId) {
    process.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("instanceId" in message) || message.instanceId !== instanceId) return;
      if (!("type" in message)) return;
      if (message.type === "rcc.shutdown") void shutdown("desktop-request");
      if (message.type === "rcc.status" && "requestId" in message && process.connected) {
        process.send?.({ type: "rcc.status", instanceId, requestId: message.requestId, state: recording.state });
      }
    });
  }
  if (parentGone) { await shutdown("desktop-lost-during-startup"); return; }
  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  if (!address || typeof address !== "object") throw new Error("No listening address");
  const url = `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${address.port}`;
  log.info("backend listening", {
    url,
    db: config.dbPath,
    staticDir: config.staticDir,
    stt: config.mockStt ? "mock" : "live",
    llm: llm.name,
    embedding: embedding.name,
  });

  if (instanceId && process.connected && !parentGone && !shutdownRequested) {
    process.send?.({ type: "rcc.ready", instanceId, pid: process.pid, url });
  } else if (instanceId) await shutdown("desktop-lost-during-listen");
}

main().catch((error: unknown) => {
  log.error("backend failed to start", { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
