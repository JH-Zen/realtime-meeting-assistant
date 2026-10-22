import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { BackendConfig } from "../config/env.js";
import { log } from "../observability/log.js";
import type { EmbeddingProvider } from "./EmbeddingProvider.js";

/**
 * Local ONNX embeddings behind the §30 seam, run in a `worker_thread`.
 *
 * The worker is not a performance tuning: measured in-process, a 12-segment batch cost ~850 ms and
 * lifted main-thread event-loop delay to p99 404 ms, which delays subtitles and partials — the shape
 * Test F forbids. Off-thread the same batches leave the main loop at p99 32 ms, so this stays one
 * process (Rule 6) and `RetrievalCore` keeps no knowledge of threads.
 *
 * Requests are serialised: ONNX already saturates the CPU, so a second concurrent batch makes both
 * slower and steals cycles from the recording path.
 */

export interface EmbeddingWorkerData {
  model: string;
  dtype: string;
  cacheDir: string;
  remoteHost: string;
}

export type EmbeddingWorkerReply =
  | { kind: "ready"; dim: number; loadMs: number }
  | { kind: "result"; id: number; vectors: Float32Array[] }
  | { kind: "error"; id: number | null; message: string };

/** The seam the real `Worker` is wrapped into and tests stub: one inbound event, one outbound call. */
export interface EmbeddingWorker {
  postMessage(job: { id: number; texts: string[] }): void;
  on(event: "reply", listener: (reply: EmbeddingWorkerReply) => void): void;
  terminate(): void;
}

interface Pending {
  resolve: (vectors: Float32Array[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type EmbeddingConfig = BackendConfig["embedding"];

export class OnnxEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  private readonly spawn: (data: EmbeddingWorkerData) => EmbeddingWorker;
  private worker: EmbeddingWorker | null = null;
  private starting: Promise<EmbeddingWorker> | null = null;
  private ready: { resolve: (worker: EmbeddingWorker) => void; reject: (error: Error) => void } | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  /**
   * Bumped on every launch and every teardown, and stamped into the reply listener. Without it a
   * superseded thread keeps talking to the provider: a `ready` that arrives after the load timeout
   * resolves the *next* worker's startup, and that worker's `exit` would tear the replacement down.
   */
  private generation = 0;
  /** Deterministic config error (wrong `EMBED_DIM`): retrying cannot help, so every request fails. */
  private permanent: string | null = null;
  private closed = false;

  constructor(
    private readonly config: EmbeddingConfig,
    options: { spawn?: (data: EmbeddingWorkerData) => EmbeddingWorker } = {},
  ) {
    this.dim = config.dim;
    // Part of the stored row identity, so switching models can never rank two vector spaces together.
    this.name = `onnx:${config.model}:${config.dtype}`;
    this.spawn = options.spawn ?? spawnWorker;
  }

  embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (this.closed) return Promise.reject(new Error("embedding provider is closed"));
    if (texts.length === 0) return Promise.resolve([]);
    const result = this.tail.then(() => this.run(texts));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Loading the model takes seconds (7 s warm, tens of seconds when the weights still have to be
   * downloaded), so the first real question must not pay for it. Called at boot and left in flight.
   */
  prewarm(): Promise<EmbeddingWorker> {
    return this.ensure();
  }

  dispose(): void {
    this.closed = true;
    this.generation += 1;
    this.failAll(new Error("embedding provider disposed"));
    const worker = this.worker;
    this.worker = null;
    this.starting = null;
    worker?.terminate();
  }

  private ensure(): Promise<EmbeddingWorker> {
    if (this.worker) return Promise.resolve(this.worker);
    if (this.permanent) return Promise.reject(new Error(this.permanent));
    if (!this.starting) this.starting = this.launch();
    return this.starting;
  }

  private async run(texts: readonly string[]): Promise<Float32Array[]> {
    const worker = await this.ensure();
    const id = this.nextId++;
    return await new Promise<Float32Array[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`embedding timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, texts: [...texts] });
    });
  }

  private launch(): Promise<EmbeddingWorker> {
    const generation = ++this.generation;
    const worker = this.spawn({
      model: this.config.model,
      dtype: this.config.dtype,
      cacheDir: this.config.modelDir,
      remoteHost: this.config.remoteHost,
    });
    this.worker = worker;
    worker.on("reply", (reply) => this.handle(reply, generation));
    const promise = new Promise<EmbeddingWorker>((resolve, reject) => {
      this.ready = { resolve, reject };
    });
    const timer = setTimeout(() => {
      this.stop(`embedding model not ready within ${this.config.loadTimeoutMs}ms`, false);
    }, this.config.loadTimeoutMs);
    // The rejection is delivered to whoever awaited `launch()`; this branch only reaps the timer.
    void promise.catch(() => undefined).finally(() => clearTimeout(timer));
    return promise;
  }

  private handle(reply: EmbeddingWorkerReply, generation: number): void {
    // A reply from a thread this provider has already moved on from is not evidence about anything.
    if (generation !== this.generation) return;
    if (reply.kind === "ready") {
      const worker = this.worker;
      if (!worker) return;
      // A wrong `EMBED_DIM` would otherwise store vectors that every later scan silently discards.
      if (reply.dim !== this.dim) {
        this.stop(`embedding model returns ${reply.dim} dims but EMBED_DIM=${this.dim}`, true);
        return;
      }
      log.info("embedding model ready", { provider: this.name, dim: reply.dim, loadMs: reply.loadMs });
      const ready = this.ready;
      this.ready = null;
      ready?.resolve(worker);
      return;
    }
    if (reply.kind === "result") {
      this.settle(reply.id, reply.vectors);
      return;
    }
    if (reply.id === null) {
      // No weights on disk and the mirror is unreachable is the common case here, and it heals when
      // the network comes back — so this is retryable. A retry costs a load timeout, not a loop.
      this.stop(reply.message, false);
      return;
    }
    this.rejectOne(reply.id, new Error(reply.message));
  }

  /**
   * Tear the worker down and fail whoever is waiting. `permanent` is only for config errors: a
   * transient one must not disable the index for the rest of a two-hour talk.
   */
  private stop(message: string, permanent: boolean): void {
    if (permanent) this.permanent = message;
    log.warn("embedding worker stopped", { provider: this.name, message, permanent });
    // Orphaned before the teardown completes, so the `exit` event this `terminate()` provokes cannot
    // be read as the failure of whatever replaces this worker.
    this.generation += 1;
    const worker = this.worker;
    this.worker = null;
    this.starting = null;
    worker?.terminate();
    this.failAll(new Error(message));
    const ready = this.ready;
    this.ready = null;
    ready?.reject(new Error(message));
  }

  private settle(id: number, vectors: Float32Array[]): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(vectors);
  }

  private rejectOne(id: number, error: Error): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(error);
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
}

/**
 * `dist` is what runs in production, `src` is what `tsx` runs in dev, and `new Worker` needs the file
 * that actually exists — the `.js` specifier alone would resolve to a missing file under `tsx`.
 */
function workerFile(): string {
  const built = new URL("./embeddingWorker.js", import.meta.url);
  return existsSync(fileURLToPath(built))
    ? fileURLToPath(built)
    : fileURLToPath(new URL("./embeddingWorker.ts", import.meta.url));
}

function spawnWorker(data: EmbeddingWorkerData): EmbeddingWorker {
  const worker = new Worker(workerFile(), { workerData: data });
  const listeners: ((reply: EmbeddingWorkerReply) => void)[] = [];
  const emit = (reply: EmbeddingWorkerReply): void => {
    for (const listener of listeners) listener(reply);
  };
  // Set before `terminate()` so the exit event it provokes is not reported as a crash. Each launch
  // gets a fresh wrapper, so these listeners die with the thread they belong to.
  let terminating = false;
  worker.on("message", (reply) => emit(reply as EmbeddingWorkerReply));
  worker.on("error", (error) => emit({ kind: "error", id: null, message: error.message }));
  worker.on("exit", (code) => {
    // Any exit ends the conversation, including code 0: a thread that stops on its own will never
    // answer the job it was given, and silence here would make every caller wait out the full
    // timeout while `launch()` waits out the load timeout on a `ready` that cannot arrive.
    if (terminating) return;
    emit({ kind: "error", id: null, message: `embedding worker exited with code ${code}` });
  });
  return {
    postMessage: (job) => worker.postMessage(job),
    on: (_event, listener) => listeners.push(listener),
    terminate: () => {
      terminating = true;
      void worker.terminate();
    },
  };
}
