import type { AppBus } from "../bus/eventBus.js";
import type { BackendConfig } from "../config/env.js";
import type { LLMProvider } from "../llm/LLMProvider.js";
import type { AudioCapture, AudioCaptureEnd, AudioGapInput, Session, SttConnection } from "@rcc/shared";
import { AudioContinuity } from "../audio/AudioContinuity.js";
import type { SqliteAudioGapRepository } from "../store/audioGapRepository.js";
import type { SqliteRecoveryTaskRepository } from "../store/recoveryTaskRepository.js";
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
  audioGaps?: SqliteAudioGapRepository;
  recoveryTasks?: SqliteRecoveryTaskRepository;
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
  readonly audio: AudioContinuity;
  private provider: STTProvider | null = null;
  private attachmentGeneration = 0;
  private attachAbort: AbortController | null = null;
  private connecting = false;
  private disposed = false;
  private inputPaused = false;
  private detachJob: Promise<void> | null = null;
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
    const recordGap = (gap: AudioGapInput) => {
      if (this.disposed) return;
      try { repositories.audioGaps?.record(session.id, gap); }
      catch (error) {
        this.bus.emit("module.error", { sessionId: session.id, module: "stt", code: "audio_gap_save_failed", message: `音频缺口记录未保存：${String(error)}`, at: Date.now(), recoverable: true });
      }
    };
    this.recordAudioGap = recordGap;
    this.audio = new AudioContinuity(session.id, recordGap);
    this.transcript = new TranscriptCore(bus, repositories.transcripts);
    // Hydration has no bus emissions or derived writes. QA still has recent source text if the
    // historical index is missing, incomplete, or its provider is unavailable.
    this.transcript.prime(repositories.transcripts.listFinal(session.id));
    this.exchanges = () => repositories.qa.listExchanges(session.id);
    this.graph = new GraphStore(bus, repositories.graphs, session.id);
    this.mindmap = new MindMapAgent(bus, this.graph, llm, config, session.id, () => this.transcript.allFinals(session.id), repositories.recoveryTasks);
    this.memory = new MemoryCore(bus, repositories.summaries, llm, config, session.id);
    this.retrieval = new RetrievalCore(
      bus,
      repositories.embeddings,
      this.transcript,
      embedding,
      config,
      session.id,
      repositories.recoveryTasks,
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

  readonly exchanges: () => ReturnType<SqliteQaRepository["listExchanges"]>;

  private readonly recordAudioGap: (gap: AudioGapInput) => void;

  sendAudio(chunk: ArrayBuffer, capture?: AudioCapture, seq?: number): void {
    if (this.disposed || this.inputPaused) return;
    if (!capture) { this.provider?.sendAudio(chunk); return; }
    const position = this.audio.accept(capture, seq ?? -1, chunk.byteLength / 2 / this.config.stt.sampleRate);
    if (position) this.provider?.sendAudio(chunk, position);
  }

  endAudioCapture(capture: AudioCaptureEnd): void { if (!this.disposed) this.audio.end(capture); }

  pauseInput(): void { this.inputPaused = true; this.provider?.pause?.(); }
  resumeInput(): void { this.inputPaused = false; this.provider?.resume?.(); }
  cancelPendingAttach(): void { if (this.connecting) this.attachAbort?.abort(); }

  /**
   * `mock` replays the scripted lecture; `mic` streams real audio to the local sherpa-onnx worker.
   * `MOCK_STT=true` refuses the worker rather than falling back to the script: a microphone that
   * produces a canned lecture would be worse than one that says why it is not listening.
   */
  async attach(source: "mic" | "mock"): Promise<void> {
    if (this.disposed) return;
    const sessionId = this.session.id;
    if (source === "mic" && this.config.mockStt) {
      const message =
        "MOCK_STT=true，未连接真实 STT。使用麦克风需要以 MOCK_STT=false 启动后端，" +
        "并先运行 python services/stt-worker/stt_worker.py --model-dir <模型目录>";
      this.bus.emit("module.error", {
        sessionId,
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
    const generation = ++this.attachmentGeneration;
    const controller = new AbortController();
    this.attachAbort = controller;
    this.connecting = true;
    this.provider = provider;
    const current = () => !this.disposed && !controller.signal.aborted && generation === this.attachmentGeneration && this.provider === provider;
    provider.onAudioGap?.((gap) => { if (current()) this.recordAudioGap(gap); });
    provider.onPartial((segment) => { if (current()) this.transcript.acceptPartial(segment); });
    provider.onFinal((segment) => { if (current()) this.transcript.acceptFinal(segment); });
    provider.onStatus?.((status) => {
      if (current()) { this.sttState = status.state; this.bus.emit("stt.status", status); }
    });

    let abortListener: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_done, fail) => {
        abortListener = () => fail(new DOMException("Recording start cancelled", "AbortError"));
        controller.signal.addEventListener("abort", abortListener, { once: true });
      });
      const connection = provider.connect(controller.signal).then(async () => {
        // Also clean up adapters that finish after ignoring their AbortSignal.
        if (!current()) await provider.disconnect();
      });
      await Promise.race([connection, aborted]);
      if (!current()) return;
      if (this.inputPaused) provider.pause?.();
      this.reportStatus("connected", 0);
    } catch (error) {
      if (!current()) { await provider.disconnect(); return; }
      this.bus.emit("module.error", {
        sessionId,
        module: "stt",
        code: "connect_failed",
        message: error instanceof Error ? error.message : String(error),
        at: Date.now(),
        recoverable: true,
      });
      this.reportStatus("failed", 0, error instanceof Error ? error.message : String(error));
      await provider.disconnect();
      if (this.provider === provider) this.provider = null;
    } finally {
      if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      if (generation === this.attachmentGeneration) this.connecting = false;
    }
  }

  detach(): Promise<void> {
    if (this.detachJob) return this.detachJob;
    const provider = this.provider;
    if (!provider) return Promise.resolve();
    this.cancelPendingAttach();
    this.detachJob = (async () => {
      try {
        // Keep the callbacks attached while a ready recognizer flushes its final accepted audio.
        await provider.disconnect();
      } catch (error) {
        log.warn("stt disconnect failed", { message: String(error) });
      } finally {
        if (this.provider === provider) this.provider = null;
        ++this.attachmentGeneration;
        this.connecting = false;
        if (!this.disposed) this.reportStatus("idle", 0);
      }
    })();
    return this.detachJob;
  }

  /** Called when the session is finished; the retained rows stay in SQLite. */
  dispose(): void {
    this.disposed = true;
    this.cancelPendingAttach();
    this.qa.close();
    this.mindmap.stop();
    this.memory.stop();
    this.retrieval.stop();
    void this.detach();
  }
}
