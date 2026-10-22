import type { AppBus } from "../bus/eventBus.js";
import type { BackendConfig } from "../config/env.js";
import type { LLMProvider } from "../llm/LLMProvider.js";
import type { Session, SttConnection } from "@rcc/shared";
import { MockSTTProvider } from "../stt/MockSTTProvider.js";
import { SherpaSTTProvider } from "../stt/SherpaSTTProvider.js";
import type { STTProvider } from "../stt/STTProvider.js";
import { TranscriptCore } from "../transcript/TranscriptCore.js";
import { GraphStore } from "../graph/GraphStore.js";
import { MindMapAgent } from "../mindmap/MindMapAgent.js";
import { QaCore } from "../qa/QaCore.js";
import { MemoryCore } from "../memory/MemoryCore.js";
import type { SqliteTranscriptRepository } from "../store/transcriptRepository.js";
import type { SqliteGraphRepository } from "../store/graphRepository.js";
import type { SqliteSummaryRepository } from "../store/summaryRepository.js";
import type { SqliteEmbeddingRepository } from "../store/embeddingRepository.js";
import type { SqliteQaRepository } from "../store/qaRepository.js";
import type { EmbeddingProvider } from "../retrieval/EmbeddingProvider.js";
import { RetrievalCore } from "../retrieval/RetrievalCore.js";
import { log } from "../observability/log.js";

/**
 * Everything session-scoped that needs a database. Passed as one object rather than one more
 * positional constructor argument per repository, because the composition root builds all of them
 * anyway.
 */
export interface SessionRepositories {
  transcripts: SqliteTranscriptRepository;
  graphs: SqliteGraphRepository;
  summaries: SqliteSummaryRepository;
  embeddings: SqliteEmbeddingRepository;
  qa: SqliteQaRepository;
}

/**
 * One recording's live services. Everything session-scoped is built here and released on `dispose`,
 * which is what keeps a 60-minute session from accumulating buffers (design doc Test F).
 */
export class SessionRuntime {
  readonly transcript: TranscriptCore;
  readonly graph: GraphStore;
  readonly mindmap: MindMapAgent;
  readonly memory: MemoryCore;
  readonly retrieval: RetrievalCore;
  readonly qa: QaCore;
  private provider: STTProvider | null = null;
  /** Kept as state, not only as an event, so a client that reconnects mid-session can recover it. */
  private sttState: SttConnection = "idle";

  get sttStatus(): SttConnection {
    return this.sttState;
  }

  /** Which engine is producing this session's text, or `null` while nothing is attached. */
  get sttEngine(): string | null {
    return this.provider?.name ?? null;
  }

  private reportStatus(state: SttConnection, attempts: number, message?: string): void {
    this.sttState = state;
    this.bus.emit("stt.status", {
      sessionId: this.session.id,
      state,
      attempts,
      ...(message !== undefined ? { message } : {}),
    });
  }

  constructor(
    readonly session: Session,
    private readonly bus: AppBus,
    private readonly config: BackendConfig,
    llm: LLMProvider,
    embedding: EmbeddingProvider,
    repositories: SessionRepositories,
  ) {
    this.transcript = new TranscriptCore(bus, repositories.transcripts);
    this.graph = new GraphStore(bus, repositories.graphs, session.id);
    this.mindmap = new MindMapAgent(bus, this.graph, llm, config, session.id);
    this.memory = new MemoryCore(bus, repositories.summaries, llm, config, session.id);
    this.retrieval = new RetrievalCore(
      bus,
      repositories.embeddings,
      this.transcript,
      embedding,
      config,
      session.id,
    );
    // The Context Manager (§27) reads the overview and the index through functions, so QA never
    // learns that Memory and Retrieval exist as modules and keeps working when they have nothing
    // to say yet.
    this.qa = new QaCore(
      bus,
      this.transcript,
      this.graph,
      llm,
      config,
      session.id,
      repositories.qa,
      () => this.memory.globalSummary(),
      (question, excludeIds) => this.retrieval.search(question, excludeIds),
    );
    this.graph.hydrate();
  }

  sendAudio(chunk: ArrayBuffer): void {
    this.provider?.sendAudio(chunk);
  }

  /**
   * `mock` replays the scripted lecture; `mic` streams real audio to the local sherpa-onnx worker.
   * `MOCK_STT=true` refuses the worker rather than falling back to the script: a microphone that
   * produces a canned lecture would be worse than one that says why it is not listening.
   */
  async attach(source: "mic" | "mock"): Promise<void> {
    const sessionId = this.session.id;
    if (source === "mic" && this.config.mockStt) {
      const message =
        "MOCK_STT=true，未连接真实 STT。使用麦克风需要以 MOCK_STT=false 启动后端，" +
        "并先运行 python services/stt-worker/stt_worker.py --model-dir <模型目录>";
      this.bus.emit("module.error", {
        module: "stt",
        code: "mock_mode_active",
        message,
        at: Date.now(),
        recoverable: true,
      });
      this.reportStatus("failed", 0, message);
      return;
    }

    const provider: STTProvider =
      source === "mock"
        ? new MockSTTProvider(sessionId, this.config.mockSttSpeed, this.config.mockSttRepeat)
        : new SherpaSTTProvider(sessionId, {
            url: this.config.stt.wsUrl,
            sampleRate: this.config.stt.sampleRate,
          });
    provider.onPartial((segment) => this.transcript.acceptPartial(segment));
    provider.onFinal((segment) => this.transcript.acceptFinal(segment));
    provider.onStatus?.((status) => {
      this.sttState = status.state;
      this.bus.emit("stt.status", status);
    });

    try {
      await provider.connect();
      this.provider = provider;
      this.reportStatus("connected", 0);
    } catch (error) {
      this.bus.emit("module.error", {
        module: "stt",
        code: "connect_failed",
        message: error instanceof Error ? error.message : String(error),
        at: Date.now(),
        recoverable: true,
      });
      this.reportStatus("failed", 0, error instanceof Error ? error.message : String(error));
    }
  }

  async detach(): Promise<void> {
    const provider = this.provider;
    this.provider = null;
    if (!provider) return;
    try {
      await provider.disconnect();
    } catch (error) {
      log.warn("stt disconnect failed", { message: String(error) });
    }
    this.reportStatus("idle", 0);
  }

  /** Called when the session is finished; the retained rows stay in SQLite. */
  dispose(): void {
    this.qa.close();
    this.mindmap.stop();
    this.memory.stop();
    this.retrieval.stop();
    void this.detach();
  }
}
