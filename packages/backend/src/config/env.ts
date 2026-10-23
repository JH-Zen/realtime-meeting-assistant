import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

/**
 * Configuration is read once at boot and frozen. No environment variable is read anywhere else,
 * so a typo in `.env` fails at startup rather than at 03:00 during a recording.
 */

export interface BackendConfig {
  host: string;
  port: number;
  dbPath: string;
  /**
   * The built frontend this process serves at `/`. Resolved like `dbPath`, so the installed app needs
   * only to start with the install directory as its working directory; when the directory holds no
   * `index.html` nothing is mounted, which is how a source checkout keeps using `vite dev`.
   */
  staticDir: string;
  /** When true the audio path is a scripted transcript, not a microphone or STT worker. */
  mockStt: boolean;
  mockLlm: boolean;
  stt: {
    /** localhost WebSocket of the sherpa-onnx worker process (Phase 5). */
    wsUrl: string;
    sampleRate: number;
  };
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    maxRetries: number;
    /**
     * Send `enable_thinking:false`. Measured on a live endpoint (2026-10-21): with thinking on, the
     * adapter's 1200-token budget was consumed entirely by reasoning tokens and three of four models
     * returned an empty or 2-character `content` — so every MindMap batch died in the repair loop and
     * the graph never grew. Turn this off only for a vendor that rejects the parameter (glm-5.3 answers
     * `400 The value of the enable_thinking parameter is restricted to True`), and raise
     * `LLM_TIMEOUT_MS` when you do: the same calls cost 27–106 s with thinking on.
     */
    disableThinking: boolean;
  };
  mindmap: {
    /** §22: flush on either enough segments or enough elapsed speech. */
    minSegments: number;
    maxIntervalMs: number;
    /** §21: how much recent transcript the agent may see. */
    windowSec: number;
  };
  memory: {
    /** §31 cadence, measured on the speech timeline: a pause cannot advance it. */
    windowSec: number;
    /** Hierarchical merge fan-in: this many blocks at one level produce one block above. */
    mergeFactor: number;
    /** A short session still gets its tail summarised at stop with this many finals. */
    minSegments: number;
    /** Ceiling on merge depth, so a multi-hour talk cannot cascade without bound. */
    maxLevel: number;
  };
  hotContextSec: number;
  embedding: {
    /** Deterministic offline vectors, so retrieval is testable with no model on disk (§50). */
    mock: boolean;
    /** Hub id pulled through `remoteHost`; code and weights licences are both registered (Rule 4). */
    model: string;
    /** ONNX quantisation: `q8` is the measured default, `fp32` the accuracy reference. */
    dtype: string;
    /** Part of the row identity, so a model swap cannot mix two vector spaces in one ranking. */
    dim: number;
    /** Where the weights are cached; downloaded on first use because `huggingface.co` is unreachable. */
    modelDir: string;
    remoteHost: string;
    timeoutMs: number;
    /** First start also downloads the weights (~540 MB through the mirror), so it gets its own budget. */
    loadTimeoutMs: number;
  };
  retrieval: {
    /** §30 asks for Top K = 5~15. */
    topK: number;
    /** Hits below this cosine are dropped rather than padded to `topK`. */
    minScore: number;
    /** Finals per provider call; a model that batches well makes the ingest cheap. */
    batchSize: number;
    /** Ingest backlog ceiling — past it, segments are skipped rather than queued forever. */
    maxPending: number;
  };
  /** Mock Mode playback speed; 1 = realtime. E2E tests and soak replays raise it. */
  mockSttSpeed: number;
  /**
   * How many times the script plays per recording (§56 Test F needs tens of minutes of continuous
   * speech from a script that is 79 s long). 1 is the shipped default, so every existing run and test
   * sees exactly one pass; `0` keeps going until the recording is stopped.
   */
  mockSttRepeat: number;
  qa: {
    /**
     * §3: the smallest gap between two accepted questions in one session. The concurrency cap limits
     * how many answers run at once; this limits how fast a client can start them — without it a
     * double-pressed Enter or a scripted client starts an unbounded series of LLM calls, each of
     * which also costs a query embedding. 0 disables the gate and is only for tests.
     */
    minIntervalMs: number;
  };
  observability: {
    /** §47: one `loop_delay` record per window — the number Test F is judged on. */
    loopDelayReportMs: number;
  };
}

export function loadConfig(cwd: string = process.cwd()): BackendConfig {
  // The desktop owns a separate configuration/data root. Browser development keeps the original rule.
  cwd = process.env.RCC_DESKTOP_DATA_ROOT ?? cwd;
  const envFile = process.env.RCC_CONFIG_FILE ?? resolve(cwd, ".env");
  const fileValues = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  return parseConfig({ ...fileValues, ...process.env }, cwd);
}

/** Pure parsing makes precedence, modes and invalid inputs testable without touching user config. */
export function parseConfig(values: NodeJS.ProcessEnv, cwd: string = process.cwd()): BackendConfig {
  const str = (name: string, fallback: string): string => values[name]?.trim() || fallback;
  const int = (name: string, fallback: number, min = 1, max = 2_147_483_647): number => {
    const raw = str(name, String(fallback));
    const parsed = Number(raw);
    if (!/^[+-]?\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new Error(`${name} must be an integer in [${min}, ${max}]`);
    }
    return parsed;
  };
  const bool = (name: string, fallback: boolean): boolean => {
    const raw = str(name, String(fallback)).toLowerCase();
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    throw new Error(`${name} must be true or false (1/0, yes/no, on/off are also accepted)`);
  };
  const float = (name: string, fallback: number, min: number, max: number): number => {
    const parsed = Number(str(name, String(fallback)));
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be a number in [${min}, ${max}]`);
    return parsed;
  };

  const mockLlm = bool("MOCK_LLM", true);
  const config: BackendConfig = {
    host: str("HOST", "127.0.0.1"),
    port: int("PORT", 8787, 0, 65535),
    dbPath: resolve(cwd, str("DB_PATH", "var/rcc.sqlite")),
    staticDir: resolve(cwd, str("STATIC_DIR", "packages/frontend/dist")),
    mockStt: bool("MOCK_STT", true),
    mockLlm,
    stt: {
      wsUrl: str("STT_WS_URL", "ws://127.0.0.1:6006"),
      sampleRate: int("STT_SAMPLE_RATE", 16000),
    },
    llm: {
      baseUrl: str("LLM_BASE_URL", "https://api.deepseek.com/v1"),
      apiKey: str("LLM_API_KEY", ""),
      model: str("LLM_MODEL", "deepseek-chat"),
      timeoutMs: int("LLM_TIMEOUT_MS", 30000),
      // §45: bounded retry, never an unbounded queue.
      maxRetries: int("LLM_MAX_RETRIES", 2, 0, 10),
      disableThinking: bool("LLM_DISABLE_THINKING", true),
    },
    mindmap: {
      minSegments: int("MINDMAP_MIN_SEGMENTS", 6),
      maxIntervalMs: int("MINDMAP_MAX_INTERVAL_MS", 25000),
      windowSec: int("MINDMAP_WINDOW_SEC", 45),
    },
    memory: {
      windowSec: int("SUMMARY_WINDOW_SEC", 240),
      mergeFactor: int("SUMMARY_MERGE_FACTOR", 4, 2, 100),
      minSegments: int("SUMMARY_MIN_SEGMENTS", 1),
      maxLevel: int("SUMMARY_MAX_LEVEL", 2, 0, 10),
    },
    hotContextSec: int("HOT_CONTEXT_SEC", 240),
    embedding: {
      mock: bool("MOCK_EMBEDDING", true),
      // bge-m3 measured 0.91 中文↔英文同义 vs 0.63 无关，正是中英混排演讲需要的能力；
      // 换成 768 维的模型必须同时改 EMBED_DIM，否则第一次嵌入就会大声失败。
      model: str("EMBED_MODEL", "Xenova/bge-m3"),
      dtype: str("EMBED_DTYPE", "q8"),
      dim: int("EMBED_DIM", 1024),
      modelDir: resolve(cwd, str("EMBED_MODEL_DIR", "models/embedding")),
      remoteHost: str("EMBED_REMOTE_HOST", "https://hf-mirror.com/"),
      timeoutMs: int("EMBED_TIMEOUT_MS", 15000),
      loadTimeoutMs: int("EMBED_LOAD_TIMEOUT_MS", 300000),
    },
    retrieval: {
      /** §30 asks for Top K = 5~15. */
      topK: int("RETRIEVAL_TOP_K", 10),
      /** A hit under this cosine is noise, and Hot Context already covers the recent stretch.
       *  0.1 is the Mock floor only: measured on bge-m3, the answer line scores 0.87~0.96, same-topic
       *  distractors 0.71~0.77 and a fully off-topic question still reaches 0.66 — so a real model
       *  needs ~0.75, and the default stays low because `MOCK_EMBEDDING=true` ships. */
      minScore: float("RETRIEVAL_MIN_SCORE", 0.1, -1, 1),
      batchSize: int("EMBED_BATCH_SIZE", 16),
      /** Queue bound: a slow model must not turn a two-hour talk into an unbounded backlog (Test F). */
      maxPending: int("RETRIEVAL_MAX_PENDING", 512),
    },
    mockSttSpeed: int("MOCK_STT_SPEED", 1),
    mockSttRepeat: int("MOCK_STT_REPEAT", 1, 0),
    qa: { minIntervalMs: int("QA_MIN_INTERVAL_MS", 1500, 0) },
    observability: { loopDelayReportMs: int("LOOP_DELAY_REPORT_MS", 10000) },
  };
  if (!["127.0.0.1", "localhost", "::1"].includes(config.host)) throw new Error("HOST must be a loopback address (127.0.0.1, localhost or ::1)");
  if (config.stt.sampleRate !== 16000) throw new Error("STT_SAMPLE_RATE must be 16000 to match microphone PCM output");
  const checkUrl = (name: string, value: string, protocols: string[], local = false) => {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`${name} must be a valid URL`); }
    if (!protocols.includes(url.protocol) || url.username || url.password ||
      (local && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error(`${name} has an unsupported protocol, credentials or host`);
  };
  checkUrl("STT_WS_URL", config.stt.wsUrl, ["ws:", "wss:"], true);
  checkUrl("LLM_BASE_URL", config.llm.baseUrl, ["http:", "https:"]);
  checkUrl("EMBED_REMOTE_HOST", config.embedding.remoteHost, ["http:", "https:"]);
  if (!config.mockLlm && !config.llm.apiKey) throw new Error("MOCK_LLM=false requires LLM_API_KEY; enable MOCK_LLM=true for simulated answers");
  return config;
}
