import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendConfig } from "../src/config/env.js";
import { OnnxEmbeddingProvider, type EmbeddingWorker, type EmbeddingWorkerData, type EmbeddingWorkerReply } from "../src/retrieval/OnnxEmbeddingProvider.js";

/**
 * The ONNX provider's control logic, tested without the model: the failures below are the ones that
 * would otherwise be silent in production (a wedged worker, a wrong `EMBED_DIM`, a lost job), and none
 * of them needs real weights to prove.
 */

const vector = (seed: number): Float32Array => Float32Array.from([seed, seed + 0.1, seed + 0.2, seed + 0.3]);

class FakeWorker implements EmbeddingWorker {
  readonly jobs: { id: number; texts: string[] }[] = [];
  terminated = false;
  private readonly listeners: ((reply: EmbeddingWorkerReply) => void)[] = [];
  on(_event: "reply", listener: (reply: EmbeddingWorkerReply) => void): void {
    this.listeners.push(listener);
  }
  postMessage(job: { id: number; texts: string[] }): void {
    this.jobs.push(job);
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(reply: EmbeddingWorkerReply): void {
    for (const listener of this.listeners) listener(reply);
  }
}

const embeddingConfig = (overrides: Partial<BackendConfig["embedding"]> = {}): BackendConfig["embedding"] => ({
  mock: false,
  model: "Xenova/test",
  dtype: "q8",
  dim: 4,
  modelDir: "var/embedding-test",
  remoteHost: "https://example.invalid/",
  timeoutMs: 1000,
  loadTimeoutMs: 1000,
  ...overrides,
});

function setup(overrides: Partial<BackendConfig["embedding"]> = {}) {
  const workers: FakeWorker[] = [];
  const spawns: EmbeddingWorkerData[] = [];
  const provider = new OnnxEmbeddingProvider(embeddingConfig(overrides), {
    spawn: (data) => {
      spawns.push(data);
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  return { provider, workers, spawns };
}

/** Every hop the provider takes is a microtask, so a fake-timer flush is enough to run them. */
const flush = async (): Promise<void> => {
  for (let pass = 0; pass < 5; pass++) await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
});

describe("onnx embedding provider", () => {
  it("loads once, then answers in the caller's order", async () => {
    const { provider, workers, spawns } = setup();
    const pending = provider.embed(["第一句", "第二句"]);

    await flush();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toEqual({
      model: "Xenova/test",
      dtype: "q8",
      cacheDir: "var/embedding-test",
      remoteHost: "https://example.invalid/",
    });
    workers[0]?.emit({ kind: "ready", dim: 4, loadMs: 7000 });
    await flush();
    expect(workers[0]?.jobs).toEqual([{ id: 1, texts: ["第一句", "第二句"] }]);
    workers[0]?.emit({ kind: "result", id: 1, vectors: [vector(2), vector(0)] });

    await expect(pending).resolves.toEqual([vector(2), vector(0)]);
    expect(spawns).toHaveLength(1);
  });

  it("runs one batch at a time, because ONNX already saturates the CPU", async () => {
    const { provider, workers } = setup();
    const first = provider.embed(["a"]);
    const second = provider.embed(["b"]);

    await flush();
    const worker = workers[0];
    if (!worker) throw new Error("no worker");
    worker.emit({ kind: "ready", dim: 4, loadMs: 1 });
    await flush();
    // Only the first request has reached the thread: the second waits for the model, not for a slot.
    expect(worker.jobs).toEqual([{ id: 1, texts: ["a"] }]);

    worker.emit({ kind: "result", id: 1, vectors: [vector(0)] });
    await expect(first).resolves.toEqual([vector(0)]);
    await flush();
    expect(worker.jobs.map((job) => job.texts)).toEqual([["a"], ["b"]]);

    worker.emit({ kind: "result", id: 2, vectors: [vector(1)] });
    await expect(second).resolves.toEqual([vector(1)]);
  });

  it("gives up a hung batch on the timeout instead of holding the queue", async () => {
    const { provider, workers } = setup({ timeoutMs: 1000 });
    const pending = provider.embed(["a"]);
    await flush();
    const worker = workers[0];
    if (!worker) throw new Error("no worker");
    worker.emit({ kind: "ready", dim: 4, loadMs: 1 });
    await flush();

    // The model is asked and never answers — the transcript backlog must not wait for it forever.
    await vi.advanceTimersByTimeAsync(1001);
    await expect(pending).rejects.toThrow(/timed out after 1000ms/);

    // A late reply for a dead job is dropped rather than resolving something nobody awaited.
    expect(() => worker.emit({ kind: "result", id: 1, vectors: [vector(0)] })).not.toThrow();
  });

  it("treats a dimension mismatch as a permanent config error", async () => {
    const { provider, workers, spawns } = setup({ dim: 1024 });
    const pending = provider.embed(["a"]);
    await flush();
    const worker = workers[0];
    if (!worker) throw new Error("no worker");
    // A 768-dim model under `EMBED_DIM=1024` would store vectors every later scan discards.
    worker.emit({ kind: "ready", dim: 768, loadMs: 1 });

    await expect(pending).rejects.toThrow(/embedding model returns 768 dims but EMBED_DIM=1024/);
    expect(worker.terminated).toBe(true);
    // Retrying a config bug would loop forever, so nothing new is spawned.
    await expect(provider.embed(["b"])).rejects.toThrow(/768 dims/);
    expect(spawns).toHaveLength(1);
  });

  it("respawns after a transient failure so a network outage can heal", async () => {
    const { provider, workers, spawns } = setup();
    const pending = provider.embed(["a"]);
    await flush();
    const dead = workers[0];
    if (!dead) throw new Error("no worker");
    dead.emit({ kind: "error", id: null, message: "weight download failed" });

    await expect(pending).rejects.toThrow("weight download failed");
    expect(dead.terminated).toBe(true);

    const retry = provider.embed(["b"]);
    await flush();
    expect(spawns).toHaveLength(2);
    const worker = workers[1];
    if (!worker) throw new Error("no second worker");
    worker.emit({ kind: "ready", dim: 4, loadMs: 2 });
    await flush();
    worker.emit({ kind: "result", id: 1, vectors: [vector(3)] });
    await expect(retry).resolves.toEqual([vector(3)]);
  });

  it("ignores a late ready from the worker the load timeout replaced", async () => {
    const { provider, workers, spawns } = setup({ loadTimeoutMs: 1000 });
    const pending = provider.embed(["a"]);
    await flush();
    const slow = workers[0];
    if (!slow) throw new Error("no worker");

    await vi.advanceTimersByTimeAsync(1001);
    await expect(pending).rejects.toThrow(/not ready within 1000ms/);

    const retry = provider.embed(["b"]);
    await flush();
    expect(spawns).toHaveLength(2);
    const replacement = workers[1];
    if (!replacement) throw new Error("no second worker");
    // The superseded thread finally reports in. Its reply is not evidence about the replacement, so
    // the replacement must still be the one that answers — and still be waiting for its own ready.
    slow.emit({ kind: "ready", dim: 4, loadMs: 9000 });
    await flush();
    expect(replacement.jobs).toEqual([]);

    replacement.emit({ kind: "ready", dim: 4, loadMs: 2 });
    await flush();
    replacement.emit({ kind: "result", id: 1, vectors: [vector(1)] });
    await expect(retry).resolves.toEqual([vector(1)]);
  });

  it("fails everything outstanding when disposed", async () => {
    const { provider, workers } = setup();
    const pending = provider.embed(["a"]);
    await flush();
    const worker = workers[0];
    if (!worker) throw new Error("no worker");
    worker.emit({ kind: "ready", dim: 4, loadMs: 1 });
    await flush();

    provider.dispose();
    await expect(pending).rejects.toThrow("disposed");
    expect(worker.terminated).toBe(true);
    await expect(provider.embed(["b"])).rejects.toThrow("closed");
  });
});
