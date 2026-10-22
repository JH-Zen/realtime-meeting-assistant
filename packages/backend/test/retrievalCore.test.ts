import { describe, expect, it, vi } from "vitest";
import type { BackendConfig } from "../src/config/env.js";
import type { ModuleError, TranscriptSegment } from "@rcc/shared";
import { createBus, type AppBus } from "../src/bus/eventBus.js";
import { openSqlite, type Sqlite } from "../src/store/sqlite.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { SqliteEmbeddingRepository } from "../src/store/embeddingRepository.js";
import { SqliteTranscriptRepository } from "../src/store/transcriptRepository.js";
import { TranscriptCore } from "../src/transcript/TranscriptCore.js";
import { RetrievalCore } from "../src/retrieval/RetrievalCore.js";
import { MockEmbeddingProvider } from "../src/retrieval/MockEmbeddingProvider.js";
import type { EmbeddingProvider } from "../src/retrieval/EmbeddingProvider.js";
import { makeConfig, segment, tick } from "./helpers.js";

/**
 * Retrieval has to keep up with a two-hour talk while something else is asking questions, so these
 * tests guard four things: only finals are embedded (§14), the queue is bounded and never overlaps
 * (Test F), a model that cannot answer costs an index entry instead of the module (Test E), and a
 * question resolves to the stored lines the frozen snapshot needs (§30, acceptance Test D).
 */

class StubEmbedding implements EmbeddingProvider {
  readonly name = "stub";
  readonly dim = 2;
  readonly calls: string[][] = [];
  maxActive = 0;
  failFirst = 0;
  shortBy = 0;
  hold = false;
  private active = 0;
  private parked: (() => void)[] = [];

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls.push([...texts]);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.hold) await new Promise<void>((resolve) => this.parked.push(resolve));
      if (this.calls.length <= this.failFirst) throw new Error("model offline");
      const vectors = texts.map((text) => Float32Array.from(vectorOf(text)));
      return this.shortBy > 0 ? vectors.slice(0, Math.max(0, vectors.length - this.shortBy)) : vectors;
    } finally {
      this.active -= 1;
    }
  }

  /** Letting go is one action: leaving `hold` set would park the very next batch. */
  release(): void {
    this.hold = false;
    for (const resolve of this.parked.splice(0)) resolve();
  }

  get embeddedTexts(): string[] {
    return this.calls.flat();
  }
}

/** Two axes only: `世界` and `机器人` are distinguishable, everything else embeds to the zero vector. */
function vectorOf(text: string): number[] {
  if (text.includes("世界")) return [1, 0];
  if (text.includes("机器人")) return [0, 1];
  return [0, 0];
}

interface Harness {
  bus: AppBus;
  core: RetrievalCore;
  provider: EmbeddingProvider;
  stub: StubEmbedding;
  transcripts: TranscriptCore;
  embeddings: SqliteEmbeddingRepository;
  store: Sqlite;
  config: BackendConfig;
  errors: ModuleError[];
}

let counter = 0;

function speak(text: string, startTime: number): TranscriptSegment {
  counter += 1;
  return segment(`t-${counter}`, text, startTime);
}

function setup(
  options: {
    retrieval?: Partial<BackendConfig["retrieval"]>;
    /** The ranking tests want the real lexical provider, not the two-axis stub. */
    lexical?: boolean;
    failFirst?: number;
    shortBy?: number;
    hold?: boolean;
    reuse?: {
      store: Sqlite;
      embeddings: SqliteEmbeddingRepository;
      transcripts: TranscriptCore;
      bus: AppBus;
      config: BackendConfig;
    };
  } = {},
): Harness {
  const config = makeConfig({ retrieval: { ...makeConfig().retrieval, ...options.retrieval } });
  const store = options.reuse?.store ?? openSqlite(":memory:");
  if (!options.reuse) {
    const sessions = new SqliteSessionRepository(store.db);
    sessions.create({ id: "s1", startedAt: 1, status: "recording" });
    sessions.create({ id: "s2", startedAt: 1, status: "recording" });
  }
  const bus = options.reuse?.bus ?? createBus();
  const embeddings = options.reuse?.embeddings ?? new SqliteEmbeddingRepository(store.db);
  const transcripts =
    options.reuse?.transcripts ?? new TranscriptCore(bus, new SqliteTranscriptRepository(store.db));
  const stub = new StubEmbedding();
  stub.failFirst = options.failFirst ?? 0;
  stub.shortBy = options.shortBy ?? 0;
  stub.hold = options.hold ?? false;
  const provider: EmbeddingProvider = options.lexical ? new MockEmbeddingProvider() : stub;
  const core = new RetrievalCore(bus, embeddings, transcripts, provider, config, "s1");
  const errors: ModuleError[] = [];
  bus.onError((error) => errors.push(error));
  core.start();
  return { bus, core, provider, stub, transcripts, embeddings, store, config, errors };
}

async function settle(ms = 5): Promise<void> {
  for (let pass = 0; pass < 4; pass++) await tick();
  await new Promise((resolve) => setTimeout(resolve, ms));
  for (let pass = 0; pass < 4; pass++) await tick();
}

async function say(r: Harness, entries: TranscriptSegment[]): Promise<void> {
  for (const entry of entries) r.transcripts.acceptFinal(entry);
  await r.core.flushPending();
  await settle(0);
}

/** Metrics are plain stdout records, so a test can read the same lines a soak run greps. */
function captureRecords(): { records: () => Record<string, unknown>[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return {
    records: () => chunks.map((chunk) => JSON.parse(chunk.trim()) as Record<string, unknown>),
    restore: () => spy.mockRestore(),
  };
}

describe("retrieval core", () => {
  it("embeds finals and never a partial (§14)", async () => {
    const r = setup();
    r.transcripts.acceptPartial(segment("p-1", "世界模型的半成品句子。", 0, "partial"));
    await settle();
    expect(r.core.indexedCount).toBe(0);
    expect(r.embeddings.count("s1")).toBe(0);

    await say(r, [speak("世界模型能够学习环境动态。", 1)]);
    expect(r.core.indexedCount).toBe(1);
    expect(r.embeddings.count("s1")).toBe(1);
  });

  it("resolves a question into the stored lines closest to it", async () => {
    const r = setup({ lexical: true });
    await say(r, [
      speak("世界模型能够学习环境的动态变化。", 0),
      speak("这项技术可以应用于机器人和自动驾驶。", 100),
      speak("仿真环境与真实环境之间存在差距。", 200),
    ]);

    const hits = await r.core.search("什么是世界模型？", new Set());
    expect(hits[0]?.text).toContain("世界模型");
    expect(hits[0]?.startTime).toBe(0);
  });

  it("leaves the caller's own lines out, so recent speech cannot be quoted twice", async () => {
    const r = setup({ lexical: true });
    const early = speak("世界模型的定义包含环境的动态。", 0);
    const alsoWorldModel = speak("世界模型更适合需要长期规划的任务。", 10);
    await say(r, [early, alsoWorldModel, speak("今天的第二部分讲机器人。", 20)]);

    const hits = await r.core.search("世界模型是什么？", new Set([early.id]));
    expect(hits.map((hit) => hit.id)).not.toContain(early.id);
    expect(hits[0]?.id).toBe(alsoWorldModel.id);
  });

  it("tells an empty index apart from one the Hot Context window already covers", async () => {
    const r = setup();
    const first = speak("世界模型的定义。", 0);
    const second = speak("世界模型的用处。", 10);
    await say(r, [first, second]);

    const out = captureRecords();
    const hits = await r.core.search("世界模型是什么？", new Set([first.id, second.id]));
    out.restore();

    // A session shorter than `hotContextSec` excludes every line, so `candidates: 0` on its own reads
    // exactly like an index that never filled. The packaging acceptance found this by guessing wrong.
    expect(hits).toHaveLength(0);
    const record = out.records().find((entry) => entry.message === "metric:retrieval_search");
    expect(record).toMatchObject({ ok: true, provider: "stub", scanned: 2, candidates: 0, hits: 0 });
  });

  it("drops weak matches instead of padding the answer up to Top K", async () => {
    const r = setup({ retrieval: { topK: 5, minScore: 0.5 } });
    await say(r, [speak("世界模型的定义。", 0), speak("机器人的应用。", 10), speak("中场休息一下。", 20)]);

    const hits = await r.core.search("世界模型怎么定义？", new Set());
    expect(hits.map((hit) => hit.text)).toEqual(["世界模型的定义。"]);
  });

  it("runs one batch at a time instead of piling requests up", async () => {
    const r = setup({ retrieval: { batchSize: 1 }, hold: true });
    const entries = [0, 1, 2, 3, 4, 5].map((i) => speak(`世界模型的第 ${i} 句。`, i));
    for (const entry of entries) r.transcripts.acceptFinal(entry);
    await settle(0);
    expect(r.core.pendingCount).toBeGreaterThan(0);

    r.stub.release();
    await r.core.flushPending();
    expect(r.stub.maxActive).toBe(1);
    expect(r.core.indexedCount).toBe(6);
  });

  it("a failed batch costs that batch, not the module", async () => {
    const r = setup({ failFirst: 1, retrieval: { batchSize: 1 } });
    r.transcripts.acceptFinal(speak("世界模型的第一句。", 0));
    await settle();
    expect(r.errors.map((error) => [error.module, error.code])).toEqual([["retrieval", "embed_failed"]]);
    expect(r.core.indexedCount).toBe(0);

    // The queue must keep moving: a wedged ingest is the Test F failure mode.
    r.transcripts.acceptFinal(speak("世界模型的第二句。", 1));
    await r.core.flushPending();
    await settle(0);
    expect(r.core.indexedCount).toBe(1);
    expect(r.embeddings.count("s1")).toBe(1);
    expect(r.errors.filter((error) => error.code === "embed_failed")).toHaveLength(1);
  });

  it("reports a provider that answers with fewer vectors than it was given", async () => {
    const r = setup({ shortBy: 1, retrieval: { batchSize: 2 } });
    await say(r, [speak("世界模型的一句。", 0), speak("机器人的另一句。", 1)]);

    expect(r.errors.map((error) => error.code)).toContain("embed_short");
    expect(r.core.indexedCount).toBe(1);
  });

  it("caps the backlog rather than queueing a long session into memory", async () => {
    const r = setup({ retrieval: { batchSize: 1, maxPending: 2 }, hold: true });
    for (let i = 0; i < 10; i += 1) r.transcripts.acceptFinal(speak(`积压测试第 ${i} 句。`, i));
    await settle(0);

    expect(r.core.pendingCount).toBeLessThanOrEqual(2);
    expect(r.core.droppedCount).toBeGreaterThan(0);
    expect(r.errors.filter((error) => error.code === "embed_backlog")).toHaveLength(1);

    r.stub.release();
    await r.core.flushPending();
    expect(r.core.pendingCount).toBe(0);
  });

  it("resumes the index after a restart instead of re-embedding the session", async () => {
    const first = setup();
    await say(first, [speak("世界模型的第一句。", 0), speak("机器人的第二句。", 1)]);
    expect(first.stub.embeddedTexts).toHaveLength(2);
    first.core.stop();

    // Same store and same transcript rows: only the new sentence may reach the model.
    const again = setup({
      reuse: {
        store: first.store,
        embeddings: first.embeddings,
        transcripts: first.transcripts,
        bus: first.bus,
        config: first.config,
      },
    });
    expect(again.core.indexedCount).toBe(2);

    again.transcripts.acceptFinal(speak("世界模型的第三句。", 2));
    await again.core.flushPending();
    await settle(0);
    expect(again.stub.embeddedTexts).toEqual(["世界模型的第三句。"]);
    expect(again.embeddings.count("s1")).toBe(3);
  });

  it("does not embed a segment that belongs to another session", async () => {
    const r = setup();
    r.transcripts.acceptFinal({ ...speak("世界模型的一句。", 0), sessionId: "s2" });
    await r.core.flushPending();
    await settle(0);
    expect(r.core.indexedCount).toBe(0);
    expect(r.stub.embeddedTexts).toEqual([]);
  });

  it("indexes the tail that the batch window never reached when the recording stops", async () => {
    const r = setup({ retrieval: { batchSize: 8 } });
    // One sentence is below `batchSize`, so nothing would land without the flush the stop path does.
    await say(r, [speak("世界模型收尾的一句。", 0)]);
    expect(r.embeddings.count("s1")).toBe(1);
  });
});
