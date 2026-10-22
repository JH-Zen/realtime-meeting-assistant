import { loadConfig } from "./config/env.js";
import { openSqlite } from "./store/sqlite.js";
import { createBus } from "./bus/eventBus.js";
import { SqliteSessionRepository } from "./store/sessionRepository.js";
import { SqliteTranscriptRepository } from "./store/transcriptRepository.js";
import { SqliteGraphRepository } from "./store/graphRepository.js";
import { SqliteSummaryRepository } from "./store/summaryRepository.js";
import { SqliteEmbeddingRepository } from "./store/embeddingRepository.js";
import { SqliteQaRepository } from "./store/qaRepository.js";
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

/**
 * Composition root. This is the only file that knows every concrete class, which is what keeps the
 * adapters swappable: nothing below it imports a third-party payload type.
 */
async function main(): Promise<void> {
  const config = loadConfig();
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
    log.warn("MOCK_STT=false but no sherpa-onnx model was found", {
      checked: stt?.checked ?? [],
      remedy: stt?.remedy ?? "",
      effect: "缺少模型文件时 worker 起不来，真实转写与字幕都不会出现",
    });
  }

  let llm: LLMProvider;
  if (!config.mockLlm && config.llm.apiKey) {
    llm = new OpenAICompatProvider(config.llm);
  } else {
    if (!config.mockLlm) {
      log.warn("LLM_API_KEY missing, falling back to Mock LLM", { baseUrl: config.llm.baseUrl });
    }
    llm = new MockLLMProvider();
  }

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
    }),
  );

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
    store: { sessions, transcripts, graphs, summaries, qa, embeddings },
    embedding,
  });

  // The dev server runs on another origin; the API is loopback-only, so a permissive header here is
  // not an exposure — it is what lets `vite dev` talk to it without a proxy.
  app.addHook("onSend", async (_request, reply) => {
    reply.header("access-control-allow-origin", "*");
    // The session import is the first HTTP POST the browser makes — everything else rides the
    // websocket, which has no preflight. A JSON body is not a simple request, so the browser asks
    // first; `apiServer` answers that OPTIONS, and these two headers are what make the answer count.
    reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
    reply.header("access-control-allow-headers", "content-type");
  });

  await app.listen({ host: config.host, port: config.port });
  // Nothing here authenticates, and an installed app now serves the whole product from this socket, so
  // leaving loopback is a decision somebody should see in the log rather than discover in a scan.
  if (config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1") {
    log.warn("listening on a non-loopback address; the app and its sessions are reachable from the network", {
      host: config.host,
      port: config.port,
    });
  }
  log.info("backend listening", {
    url: `http://${config.host}:${config.port}`,
    db: config.dbPath,
    staticDir: config.staticDir,
    stt: config.mockStt ? "mock" : "live",
    llm: llm.name,
    embedding: embedding.name,
  });

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal, loopDelay: loopDelay.report() });
    loopDelay.stop();
    await recording.stop();
    await app.close();
    onnx?.dispose();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  log.error("backend failed to start", { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
