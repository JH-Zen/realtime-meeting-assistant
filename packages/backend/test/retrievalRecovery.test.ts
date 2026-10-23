import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModuleError, TranscriptSegment } from "@rcc/shared";
import { createBus, type AppBus } from "../src/bus/eventBus.js";
import type { BackendConfig } from "../src/config/env.js";
import type { EmbeddingProvider } from "../src/retrieval/EmbeddingProvider.js";
import { RetrievalCore } from "../src/retrieval/RetrievalCore.js";
import { SqliteEmbeddingRepository } from "../src/store/embeddingRepository.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { openSqlite, type Sqlite } from "../src/store/sqlite.js";
import { SqliteTranscriptRepository } from "../src/store/transcriptRepository.js";
import { TranscriptCore } from "../src/transcript/TranscriptCore.js";
import { makeConfig, segment, tick } from "./helpers.js";

/**
 * Recovery is explicit: a hole left by a failed live batch (or by a provider/dimension swap) must be
 * discoverable from durable data and repairable on demand, without changing live ingest semantics.
 */

class ControlledEmbedding implements EmbeddingProvider {
  readonly name = "controlled";
  readonly dim: number;
  readonly calls: string[][] = [];
  maxActive = 0;
  /** Calls whose 1-based invocation index is at most this value throw. */
  failFirst = 0;
  /** Calls whose 1-based invocation index is at most this value return one vector too few. */
  shortFirst = 0;
  nonFinite = false;
  hold = false;
  private active = 0;
  private invoked = 0;
  private parked: { resolve: () => void; reject: (error: Error) => void }[] = [];

  constructor(dim = 2) {
    this.dim = dim;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls.push([...texts]);
    this.invoked += 1;
    const call = this.invoked;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.hold) {
        await new Promise<void>((resolve, reject) => this.parked.push({ resolve, reject }));
      }
      if (call <= this.failFirst) throw new Error("model offline");
      const vectors = texts.map((text) => Float32Array.from(vectorOf(text)));
      if (this.nonFinite && vectors[0]) vectors[0] = new Float32Array(this.dim).fill(Number.NaN);
      return call <= this.shortFirst ? vectors.slice(0, Math.max(0, vectors.length - 1)) : vectors;
    } finally {
      this.active -= 1;
    }
  }

  release(): void {
    this.hold = false;
    for (const parked of this.parked.splice(0)) parked.resolve();
  }

  releaseWithError(message = "model released with an error"): void {
    this.hold = false;
    for (const parked of this.parked.splice(0)) parked.reject(new Error(message));
  }

  get embeddedTexts(): string[] {
    return this.calls.flat();
  }
}

/** Two axes only, matching the stub used by the existing retrieval tests. */
function vectorOf(text: string): number[] {
  if (text.includes("世界")) return [1, 0];
  if (text.includes("机器人")) return [0, 1];
  return [0, 0];
}

interface Harness {
  bus: AppBus;
  core: RetrievalCore;
  provider: ControlledEmbedding;
  transcripts: TranscriptCore;
  transcriptStore: SqliteTranscriptRepository;
  embeddings: SqliteEmbeddingRepository;
  errors: ModuleError[];
  store: Sqlite;
  config: BackendConfig;
}

let counter = 0;
const harnesses: Harness[] = [];

function freshSegment(text: string, sessionId = "s1", startTime = 0): TranscriptSegment {
  counter += 1;
  return { ...segment(`r-${counter}`, text, startTime), sessionId };
}

function setup(
  options: {
    retrieval?: Partial<BackendConfig["retrieval"]>;
    provider?: ControlledEmbedding;
    start?: boolean;
  } = {},
): Harness {
  const config = makeConfig({ retrieval: { ...makeConfig().retrieval, ...options.retrieval } });
  const store = openSqlite(":memory:");
  const sessions = new SqliteSessionRepository(store.db);
  sessions.create({ id: "s1", startedAt: 1, status: "recording" });
  sessions.create({ id: "s2", startedAt: 1, status: "recording" });

  const bus = createBus();
  const embeddings = new SqliteEmbeddingRepository(store.db);
  const transcriptStore = new SqliteTranscriptRepository(store.db);
  const transcripts = new TranscriptCore(bus, transcriptStore);
  const provider = options.provider ?? new ControlledEmbedding();
  const core = new RetrievalCore(bus, embeddings, transcripts, provider, config, "s1");
  const errors: ModuleError[] = [];
  bus.onError((error) => errors.push(error));
  if (options.start !== false) core.start();
  const harness = { bus, core, provider, transcripts, transcriptStore, embeddings, errors, store, config };
  harnesses.push(harness);
  return harness;
}

/** Persist finals directly so a test can create an index hole without going through live ingest. */
function seed(r: Harness, texts: string[], sessionId = "s1"): TranscriptSegment[] {
  return texts.map((text, index) => {
    const final = freshSegment(text, sessionId, index);
    r.transcriptStore.appendFinal(final);
    return final;
  });
}

async function liveSay(r: Harness, entries: TranscriptSegment[]): Promise<void> {
  for (const entry of entries) r.transcripts.acceptFinal(entry);
  for (let pass = 0; pass < 4; pass += 1) await tick();
  await r.core.flushPending();
  for (let pass = 0; pass < 4; pass += 1) await tick();
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let pass = 0; pass < 250; pass += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

afterEach(async () => {
  // Registered harnesses are cleaned even when an assertion failed before the test stopped them.
  vi.restoreAllMocks();
  for (const r of harnesses.splice(0)) {
    r.core.stop();
    r.provider.release();
    await r.core.flushPending();
    r.bus.clear();
    r.store.close();
  }
});

describe("retrieval recovery", () => {
  it("does not embed on status, start or history hydration", () => {
    const r = setup({ start: false });
    seed(r, ["世界模型的第一句。", "机器人的第二句。"]);

    expect(r.core.recoveryStatus).toMatchObject({
      sessionId: "s1",
      provider: "controlled",
      total: 2,
      indexed: 0,
      missing: 2,
      busy: false,
      lastError: null,
      completedBatches: 0,
    });

    r.core.start();
    r.transcripts.prime(r.transcripts.allFinals("s1"));

    expect(r.core.recoveryStatus.missing).toBe(2);
    expect(r.provider.calls).toHaveLength(0);
    expect(r.embeddings.count("s1")).toBe(0);
  });

  it("repairs a live batch that failed, once the provider recovers", async () => {
    const provider = new ControlledEmbedding();
    provider.failFirst = 1;
    const r = setup({ provider, retrieval: { batchSize: 1 } });
    const final = freshSegment("世界模型的失败句。", "s1", 1);

    await liveSay(r, [final]);
    expect(r.provider.calls).toHaveLength(1);
    expect(r.core.recoveryStatus.missing).toBe(1);
    expect(r.errors.map((error) => error.code)).toEqual(["embed_failed"]);

    // Reading status must not silently repair the hole.
    expect(r.core.recoveryStatus.missing).toBe(1);
    expect(r.provider.calls).toHaveLength(1);

    provider.failFirst = 0;
    await r.core.rebuildMissing();

    expect(r.core.recoveryStatus).toMatchObject({
      total: 1,
      indexed: 1,
      missing: 0,
      busy: false,
      lastError: null,
      completedBatches: 1,
    });
    expect(r.embeddings.count("s1")).toBe(1);
    expect(r.provider.calls).toHaveLength(2);
    expect(r.errors.map((error) => error.code)).toEqual(["embed_failed"]);

    // The repaired id is already known to live ingest and must not be embedded again.
    r.bus.emit("transcript.final", final);
    for (let pass = 0; pass < 4; pass += 1) await tick();
    await r.core.flushPending();
    expect(r.provider.calls).toHaveLength(2);
  });

  it("stops after three attempts and emits one recoverable error", async () => {
    const provider = new ControlledEmbedding();
    provider.failFirst = 100;
    const r = setup({ provider, retrieval: { batchSize: 1 } });
    seed(r, ["世界模型无法嵌入的一句。"]);

    await r.core.rebuildMissing();

    expect(r.provider.calls).toHaveLength(3);
    expect(r.core.recoveryStatus.missing).toBe(1);
    expect(r.core.recoveryStatus.completedBatches).toBe(0);
    expect(r.core.recoveryStatus.busy).toBe(false);
    expect(r.core.recoveryStatus.lastError).toContain("model offline");
    const recoveryErrors = r.errors.filter((error) => error.code === "embed_rebuild_failed");
    expect(recoveryErrors).toHaveLength(1);
    expect(recoveryErrors[0]).toMatchObject({ module: "retrieval", recoverable: true });

    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(r.provider.calls).toHaveLength(3);
  }, 5_000);

  it("retries after one temporary failure and then completes", async () => {
    const provider = new ControlledEmbedding();
    provider.failFirst = 1;
    const r = setup({ provider });
    seed(r, ["世界模型恢复后的一句。"]);

    await r.core.rebuildMissing();

    expect(r.provider.calls).toHaveLength(2);
    expect(r.core.recoveryStatus).toMatchObject({ missing: 0, lastError: null, completedBatches: 1 });
    expect(r.errors.filter((error) => error.code === "embed_rebuild_failed")).toHaveLength(0);
  });

  it("coalesces concurrent calls into one non-overlapping job", async () => {
    const provider = new ControlledEmbedding();
    provider.hold = true;
    const r = setup({ provider, retrieval: { batchSize: 2 } });
    seed(r, ["世界模型一。", "世界模型二。", "机器人三。", "机器人四。", "世界模型五。"]);

    const first = r.core.rebuildMissing();
    const second = r.core.rebuildMissing();
    const third = r.core.rebuildMissing();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(r.core.recoveryStatus.busy).toBe(true);

    await waitFor(() => r.provider.calls.length >= 1, "the first repair request");
    provider.release();
    await first;

    expect(r.provider.maxActive).toBe(1);
    expect(r.provider.calls).toHaveLength(3);
    expect(r.core.recoveryStatus).toMatchObject({
      total: 5,
      indexed: 5,
      missing: 0,
      busy: false,
      completedBatches: 3,
    });
  });

  it("does not duplicate vectors or re-embed a repaired id on a second run", async () => {
    const r = setup({ retrieval: { batchSize: 2 } });
    const finals = seed(r, ["世界模型一。", "世界模型二。", "机器人三。"]);

    await r.core.rebuildMissing();
    expect(r.provider.embeddedTexts).toHaveLength(3);
    expect(r.embeddings.count("s1")).toBe(3);

    await r.core.rebuildMissing();
    expect(r.provider.embeddedTexts).toHaveLength(3);
    expect(r.embeddings.count("s1")).toBe(3);
    expect(r.core.recoveryStatus.completedBatches).toBe(0);

    const first = finals[0];
    if (!first) throw new Error("seed failed");
    r.bus.emit("transcript.final", first);
    for (let pass = 0; pass < 4; pass += 1) await tick();
    await r.core.flushPending();
    expect(r.provider.embeddedTexts).toHaveLength(3);
  });

  it("repairs preexisting wrong-provider and wrong-dimension rows", async () => {
    const r = setup();
    const finals = seed(r, ["世界模型一句。", "机器人二句。"]);
    const [first, second] = finals;
    if (!first || !second) throw new Error("seed failed");

    r.embeddings.put({
      ownerType: "transcript",
      ownerId: first.id,
      sessionId: "s1",
      provider: "controlled",
      vector: new Float32Array(3).fill(1),
    });
    r.embeddings.put({
      ownerType: "transcript",
      ownerId: second.id,
      sessionId: "s1",
      provider: "legacy",
      vector: new Float32Array(2).fill(1),
    });
    expect(r.core.recoveryStatus).toMatchObject({ total: 2, indexed: 0, missing: 2 });

    await r.core.rebuildMissing();

    expect(r.core.recoveryStatus).toMatchObject({ indexed: 2, missing: 0 });
    expect(r.embeddings.count("s1", "controlled")).toBe(2);
    expect(r.embeddings.count("s1", "legacy")).toBe(0);
    expect(r.embeddings.scan("s1", "transcript", "controlled", 2)).toHaveLength(2);
  });

  it("keeps short and non-finite provider output missing", async () => {
    const provider = new ControlledEmbedding();
    provider.shortFirst = 100;
    const r = setup({ provider });
    seed(r, ["世界模型缺向量的一句。"]);

    await r.core.rebuildMissing();
    expect(r.core.recoveryStatus.missing).toBe(1);
    expect(r.provider.calls).toHaveLength(3);
    expect(r.embeddings.count("s1")).toBe(0);
    expect(r.errors.filter((error) => error.code === "embed_rebuild_failed")).toHaveLength(1);

    provider.shortFirst = 0;
    provider.nonFinite = true;
    await r.core.rebuildMissing();
    expect(r.core.recoveryStatus.missing).toBe(1);
    expect(r.provider.calls).toHaveLength(6);
    expect(r.embeddings.count("s1")).toBe(0);

    provider.nonFinite = false;
    await r.core.rebuildMissing();
    expect(r.core.recoveryStatus.missing).toBe(0);
    expect(r.embeddings.count("s1")).toBe(1);
  }, 5_000);

  it("stop during a held embed prevents any late write or error", async () => {
    const provider = new ControlledEmbedding();
    provider.hold = true;
    const r = setup({ provider });
    seed(r, ["世界模型的暂停句。"]);

    const repair = r.core.rebuildMissing();
    await waitFor(() => r.provider.calls.length === 1, "the held embed");
    r.core.stop();
    provider.release();
    await repair;

    expect(r.embeddings.count("s1")).toBe(0);
    expect(r.provider.calls).toHaveLength(1);
    expect(r.errors.filter((error) => error.code === "embed_rebuild_failed")).toHaveLength(0);
    expect(r.core.recoveryStatus.missing).toBe(1);
  });

  it("stop during backoff cancels the delayed retry", async () => {
    const provider = new ControlledEmbedding();
    provider.failFirst = 100;
    const r = setup({ provider, retrieval: { batchSize: 1 } });
    seed(r, ["世界模型退避句。"]);

    const repair = r.core.rebuildMissing();
    await waitFor(() => r.core.recoveryStatus.lastError !== null, "the first failure");
    expect(r.provider.calls).toHaveLength(1);

    r.core.stop();
    await repair;
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(r.provider.calls).toHaveLength(1);
    expect(r.errors.filter((error) => error.code === "embed_rebuild_failed")).toHaveLength(0);
  }, 5_000);

  it("stop during a held live embed discards a late successful response", async () => {
    const provider = new ControlledEmbedding();
    provider.hold = true;
    const r = setup({ provider });
    r.transcripts.acceptFinal(freshSegment("世界模型的实时暂停成功句。"));
    await waitFor(() => r.provider.calls.length === 1, "the held live embed");

    r.core.stop();
    provider.release();
    await r.core.flushPending();

    expect(r.embeddings.count("s1")).toBe(0);
    expect(r.core.indexedCount).toBe(0);
    expect(r.errors).toHaveLength(0);
  });

  it("stop during a held live embed discards a late rejection", async () => {
    const provider = new ControlledEmbedding();
    provider.hold = true;
    const r = setup({ provider });
    r.transcripts.acceptFinal(freshSegment("世界模型的实时暂停失败句。"));
    await waitFor(() => r.provider.calls.length === 1, "the held live embed");

    r.core.stop();
    provider.releaseWithError();
    await r.core.flushPending();

    expect(r.embeddings.count("s1")).toBe(0);
    expect(r.core.indexedCount).toBe(0);
    expect(r.errors).toHaveLength(0);
  });

  it("retries a failed putBatch transaction and persists the retry", async () => {
    const r = setup();
    seed(r, ["世界模型写库失败后重试的一句。"]);
    const putBatch = vi.spyOn(r.embeddings, "putBatch").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });

    await r.core.rebuildMissing();

    expect(putBatch).toHaveBeenCalledTimes(2);
    expect(r.core.recoveryStatus).toMatchObject({
      total: 1,
      indexed: 1,
      missing: 0,
      lastError: null,
      completedBatches: 1,
    });
    expect(r.embeddings.count("s1")).toBe(1);
    expect(r.errors.filter((error) => error.code === "embed_rebuild_failed")).toHaveLength(0);
  });

  it("keeps a persistent putBatch failure bounded, unindexed and visible", async () => {
    const r = setup();
    seed(r, ["世界模型写库持续失败的一句。"]);
    const putBatch = vi.spyOn(r.embeddings, "putBatch").mockImplementation(() => {
      throw new Error("database is locked");
    });

    await r.core.rebuildMissing();

    expect(putBatch).toHaveBeenCalledTimes(3);
    expect(r.provider.calls).toHaveLength(3);
    expect(r.embeddings.count("s1")).toBe(0);
    expect(r.core.recoveryStatus).toMatchObject({ total: 1, indexed: 0, missing: 1, busy: false });
    expect(r.core.recoveryStatus.lastError).toContain("database is locked");
    expect(r.errors.filter((error) => error.code === "embed_rebuild_failed")).toHaveLength(1);
  }, 5_000);

  it("processes at most eight batches per explicit repair", async () => {
    const r = setup({ retrieval: { batchSize: 2 } });
    seed(r, Array.from({ length: 20 }, (_, index) => `世界模型的第 ${index} 句。`));

    await r.core.rebuildMissing();
    expect(r.provider.calls).toHaveLength(8);
    expect(r.core.recoveryStatus).toMatchObject({
      total: 20,
      indexed: 16,
      missing: 4,
      completedBatches: 8,
    });

    await r.core.rebuildMissing();
    expect(r.core.recoveryStatus).toMatchObject({
      total: 20,
      indexed: 20,
      missing: 0,
      completedBatches: 2,
    });
    expect(r.provider.calls).toHaveLength(10);
  });

  it("never touches another session's transcripts or vectors", async () => {
    const r = setup();
    seed(r, ["世界模型的本人句。"]);
    const otherFinals = seed(r, ["机器人的别人句。"], "s2");
    const other = otherFinals[0];
    if (!other) throw new Error("seed failed");
    r.embeddings.put({
      ownerType: "transcript",
      ownerId: other.id,
      sessionId: "s2",
      provider: "controlled",
      vector: Float32Array.from([0, 1]),
    });

    await r.core.rebuildMissing();

    expect(r.core.recoveryStatus).toMatchObject({ total: 1, indexed: 1, missing: 0 });
    expect(r.embeddings.count("s1")).toBe(1);
    expect(r.embeddings.count("s2", "controlled")).toBe(1);
    expect(r.embeddings.scan("s2", "transcript", "controlled", 2)).toHaveLength(1);
    expect(r.transcriptStore.listFinal("s2")[0]?.text).toBe("机器人的别人句。");
    expect(r.provider.embeddedTexts.join("|")).toBe("世界模型的本人句。");
  });

  it("keeps missing rows discoverable after a restart", async () => {
    const provider = new ControlledEmbedding();
    provider.failFirst = 1;
    const r = setup({ provider, retrieval: { batchSize: 1 } });
    const final = freshSegment("世界模型的重启句。", "s1", 1);
    await liveSay(r, [final]);
    expect(r.core.recoveryStatus.missing).toBe(1);
    r.core.stop();

    const restartedProvider = new ControlledEmbedding();
    const restarted = new RetrievalCore(r.bus, r.embeddings, r.transcripts, restartedProvider, r.config, "s1");
    restarted.start();
    expect(restarted.recoveryStatus).toMatchObject({ total: 1, indexed: 0, missing: 1 });

    await restarted.rebuildMissing();
    expect(restarted.recoveryStatus).toMatchObject({ total: 1, indexed: 1, missing: 0 });
    expect(restartedProvider.embeddedTexts).toEqual(["世界模型的重启句。"]);
  });
});