import { parentPort, workerData } from "node:worker_threads";
import { env, pipeline } from "@huggingface/transformers";
import type { EmbeddingWorkerData, EmbeddingWorkerReply } from "./OnnxEmbeddingProvider.js";

/**
 * The ONNX worker thread (§30, ADR §9 constraint 3).
 *
 * This exists because measured in-process inference stalls the main loop: a 12-segment batch cost
 * ~850 ms and pushed main-thread event-loop delay to p99 404 ms — exactly the UI jank Test F
 * forbids. In a worker the same batches keep the main loop at p99 32 ms, so one process is enough
 * (Rule 6).
 *
 * Weights come from a mirror because `huggingface.co` is unreachable on this machine; the first
 * start downloads into `cacheDir`, later starts read from disk.
 */

const port = parentPort;
if (!port) throw new Error("embeddingWorker must run inside a worker_thread");

const { model, dtype, cacheDir, remoteHost } = workerData as EmbeddingWorkerData;

env.allowRemoteModels = true;
env.allowLocalModels = false;
env.useFSCache = true;
env.cacheDir = cacheDir;
env.remoteHost = remoteHost;
env.remotePathTemplate = "{model}/resolve/{revision}/";

const reply = (message: EmbeddingWorkerReply): void => {
  port.postMessage(message);
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `Tensor.data` is a flat `batch × dim`; slicing preserves the caller's order. */
function sliceVectors(data: ArrayLike<number>, dim: number, count: number): Float32Array[] {
  const vectors: Float32Array[] = [];
  for (let row = 0; row < count; row++) {
    const vector = new Float32Array(dim);
    for (let d = 0; d < dim; d++) vector[d] = Number(data[row * dim + d] ?? 0);
    vectors.push(vector);
  }
  return vectors;
}

const CALL = { pooling: "mean", normalize: true } as const;

/** The slice of the pipeline this worker actually uses, so nothing here depends on its generics. */
type Embed = (texts: string[], options: typeof CALL) => Promise<{ data: unknown; dims: number[] }>;

const startedAt = Date.now();
let embed: Embed;
try {
  // `EMBED_DTYPE` is a plain string in config; these are the values actually used here, and an
  // unsupported one fails at model load with a message the caller turns into `embed_failed`.
  embed = (await pipeline("feature-extraction", model, {
    dtype: dtype as "q8" | "fp32" | "fp16" | "int8" | "uint8",
  })) as unknown as Embed;
} catch (error) {
  reply({ kind: "error", id: null, message: `embedding model load failed: ${errorText(error)}` });
  throw error;
}

const probe = await embed(["维度探测"], CALL);
reply({ kind: "ready", dim: Number(probe.dims.at(-1) ?? 0), loadMs: Date.now() - startedAt });

port.on("message", async (job: { id: number; texts: string[] }) => {
  try {
    const out = await embed(job.texts, CALL);
    const dim = Number(out.dims.at(-1) ?? 0);
    reply({ kind: "result", id: job.id, vectors: sliceVectors(out.data as ArrayLike<number>, dim, job.texts.length) });
  } catch (error) {
    reply({ kind: "error", id: job.id, message: errorText(error) });
  }
});
