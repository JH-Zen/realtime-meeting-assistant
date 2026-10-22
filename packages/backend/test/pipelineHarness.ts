import { openSqlite } from "../src/store/sqlite.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { SqliteTranscriptRepository } from "../src/store/transcriptRepository.js";
import { SqliteGraphRepository } from "../src/store/graphRepository.js";
import { SqliteSummaryRepository } from "../src/store/summaryRepository.js";
import { SqliteEmbeddingRepository } from "../src/store/embeddingRepository.js";
import { SqliteQaRepository } from "../src/store/qaRepository.js";
import { MockLLMProvider } from "../src/llm/MockLLMProvider.js";
import { MockEmbeddingProvider } from "../src/retrieval/MockEmbeddingProvider.js";
import type { EmbeddingProvider } from "../src/retrieval/EmbeddingProvider.js";
import { SessionRuntime } from "../src/runtime/SessionRuntime.js";
import type { LLMProvider } from "../src/llm/LLMProvider.js";
import { RecordingController } from "../src/recording/RecordingController.js";
import { createBus } from "../src/bus/eventBus.js";
import { makeConfig } from "./helpers.js";

export interface HarnessOptions {
  llm?: LLMProvider;
  embedding?: EmbeddingProvider;
  minSegments?: number;
  maxIntervalMs?: number;
  hotContextSec?: number;
  repeat?: number;
  /** When false the runtime attaches the live provider instead of the script, so a worker stub stands in for Python. */
  mockStt?: boolean;
  /** WebSocket address of a fake worker, only meaningful together with `mockStt: false`. */
  sttWsUrl?: string;
}

export interface Harness {
  bus: ReturnType<typeof createBus>;
  recording: RecordingController;
  transcripts: SqliteTranscriptRepository;
  graphs: SqliteGraphRepository;
  summaries: SqliteSummaryRepository;
  embeddings: SqliteEmbeddingRepository;
  sessions: SqliteSessionRepository;
  close: () => void;
}

/**
 * The §52 path with every component real except the models: mock transcript → Transcript Core →
 * store → bus → the AI modules. The script plays at 500× so a minute of "speech" lands in a few
 * hundred milliseconds, which is what makes a fault-injection assertion cheap enough to keep.
 */
export function createHarness(options: HarnessOptions = {}): Harness {
  const config = makeConfig({
    mockSttSpeed: 500,
    ...(options.repeat === undefined ? {} : { mockSttRepeat: options.repeat }),
    ...(options.mockStt === undefined ? {} : { mockStt: options.mockStt }),
    ...(options.sttWsUrl === undefined ? {} : { stt: { wsUrl: options.sttWsUrl, sampleRate: 16000 } }),
    mindmap: {
      minSegments: options.minSegments ?? 2,
      maxIntervalMs: options.maxIntervalMs ?? 60,
      windowSec: 120,
    },
    ...(options.hotContextSec === undefined ? {} : { hotContextSec: options.hotContextSec }),
  });
  const store = openSqlite(":memory:");
  const sessions = new SqliteSessionRepository(store.db);
  const transcripts = new SqliteTranscriptRepository(store.db);
  const graphs = new SqliteGraphRepository(store.db);
  const summaries = new SqliteSummaryRepository(store.db);
  const embeddings = new SqliteEmbeddingRepository(store.db);
  const qa = new SqliteQaRepository(store.db);
  const bus = createBus();
  const llm = options.llm ?? new MockLLMProvider();
  const embedding = options.embedding ?? new MockEmbeddingProvider();
  const recording = new RecordingController(bus, sessions, (session) =>
    new SessionRuntime(session, bus, config, llm, embedding, {
      transcripts,
      graphs,
      summaries,
      embeddings,
      qa,
    }),
  );
  return {
    bus,
    recording,
    transcripts,
    graphs,
    summaries,
    embeddings,
    sessions,
    close: () => store.close(),
  };
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
