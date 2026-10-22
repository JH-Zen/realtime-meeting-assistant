import { describe, expect, it } from "vitest";
import type { BackendConfig } from "../src/config/env.js";
import type { ModuleError, SummaryBlock } from "@rcc/shared";
import type { z } from "zod";
import { createBus, type AppBus } from "../src/bus/eventBus.js";
import { MemoryCore } from "../src/memory/MemoryCore.js";
import { openSqlite, type Sqlite } from "../src/store/sqlite.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { SqliteSummaryRepository } from "../src/store/summaryRepository.js";
import { SqliteTranscriptRepository } from "../src/store/transcriptRepository.js";
import { TranscriptCore } from "../src/transcript/TranscriptCore.js";
import { LLMStructuredOutputError, type LLMProvider, type LLMRequest, type LLMResult, type Structured } from "../src/llm/LLMProvider.js";
import { makeConfig, segment, tick } from "./helpers.js";

/**
 * Memory is the module that decides what a long talk is *about* once the words have scrolled out of
 * Hot Context, so these tests guard three things: the cadence is measured on the speech timeline and
 * only ever advanced by finals (§31), history is append-only and lineage is recorded (§31), and a
 * model that cannot answer costs one block instead of the module (§44, Test E).
 */

const DEFAULTS = { windowSec: 30, mergeFactor: 3, minSegments: 1, maxLevel: 2 };
const memoryConfig = (overrides: Partial<typeof DEFAULTS> = {}): BackendConfig["memory"] => ({
  ...DEFAULTS,
  ...overrides,
});

class SummaryStub implements LLMProvider {
  readonly name = "stub";
  stageCalls = 0;
  mergeCalls = 0;
  maxActive = 0;
  private active = 0;
  readonly requests: LLMRequest[] = [];
  private parked = Promise.resolve();
  private openGate: () => void = () => {};

  constructor(
    private readonly opts: { failStages?: number; failMerges?: number; delayMs?: number; holdStages?: boolean } = {},
  ) {
    if (opts.holdStages) {
      this.parked = new Promise<void>((resolve) => {
        this.openGate = resolve;
      });
    }
  }

  /** Lets the parked stage requests go; only meaningful together with `holdStages`. */
  releaseStages(): void {
    this.openGate();
  }

  async generate(): Promise<LLMResult> {
    return { text: "{}", responseId: "gen", inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  }

  async *stream(): AsyncIterable<string> {
    yield "";
  }

  /** Counts overlap as well as calls: single-flight must mean one request at a time, not one per tick. */
  async structuredGenerate<T>(request: LLMRequest, _schema: z.ZodType<T>): Promise<Structured<T>> {
    const isStage = request.user.includes("### 本阶段转写");
    const before = isStage ? this.stageCalls++ : this.mergeCalls++;
    this.requests.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      // Parked indefinitely rather than for a fixed delay: a test that waits for the chain cannot be
      // beaten by the clock, and one that does not must fail rather than pass by accident.
      if (isStage && this.opts.holdStages) await this.parked;
      if (this.opts.delayMs) await new Promise((resolve) => setTimeout(resolve, this.opts.delayMs));
      if (isStage && before < (this.opts.failStages ?? 0)) {
        throw new LLMStructuredOutputError("model output was not valid JSON", 2, "{");
      }
      if (!isStage && before < (this.opts.failMerges ?? 0)) {
        throw new LLMStructuredOutputError("model output was not valid JSON", 2, "{");
      }
      const label = isStage ? `阶段${before + 1}` : `合并${before + 1}`;
      return {
        data: { summary: `${label}摘要`, keyPoints: [`${label}要点`], entities: ["世界模型"] } as T,
        responseId: `resp-${isStage ? "s" : "m"}${before + 1}`,
        latencyMs: 1,
        inputTokens: 10,
        outputTokens: 5,
      };
    } finally {
      this.active -= 1;
    }
  }
}

/**
 * The real repository, with one write armable so a failure can be placed exactly where the module
 * decides what to record. Only the given level is hit, and only once: a merge parent must be able to
 * fail without taking the stage block written just before it down with it.
 */
class FlakySummaryRepository extends SqliteSummaryRepository {
  failNextWriteAtLevel: number | null = null;

  override append(block: SummaryBlock): void {
    if (this.failNextWriteAtLevel === block.level) {
      this.failNextWriteAtLevel = null;
      throw new Error("SQLITE_IOERR: disk write failed");
    }
    super.append(block);
  }
}

function setup(
  opts: { failStages?: number; failMerges?: number; delayMs?: number; holdStages?: boolean } = {},
  memory: Partial<typeof DEFAULTS> = {},
  /** A restart rebuilds the module over the same store: the summaries must survive it. */
  reuse?: { store: Sqlite; summaries: FlakySummaryRepository; transcript: TranscriptCore; bus: AppBus; config: BackendConfig },
): Harness {
  const store = reuse?.store ?? openSqlite(":memory:");
  if (!reuse) new SqliteSessionRepository(store.db).create({ id: "s1", startedAt: 1, status: "recording" });
  const summaries = reuse?.summaries ?? new FlakySummaryRepository(store.db);
  const bus = reuse?.bus ?? createBus();
  const transcript = reuse?.transcript ?? new TranscriptCore(bus, new SqliteTranscriptRepository(store.db));
  const config = reuse?.config ?? makeConfig({ memory: memoryConfig(memory) });
  const llm = new SummaryStub(opts);
  const core = new MemoryCore(bus, summaries, llm, config, "s1");
  const updated: SummaryBlock[] = [];
  const errors: ModuleError[] = [];
  bus.on("memory", "summary.updated", (payload) => updated.push(payload.block));
  bus.onError((error) => errors.push(error));
  core.start();
  return { bus, core, llm, transcript, summaries, store, config, updated, errors };
}

type Harness = ReturnType<typeof setup>;

let counter = 0;
/** One final per entry; `segment()` puts endTime at +3s. */
async function speak(r: Harness, times: number[]): Promise<void> {
  for (const time of times) {
    counter += 1;
    r.transcript.acceptFinal(segment(`t-${counter}`, `第 ${time} 秒的句子。`, time));
  }
  await settle();
}

async function settle(ms = 5): Promise<void> {
  for (let pass = 0; pass < 4; pass++) await tick();
  await new Promise((resolve) => setTimeout(resolve, ms));
  for (let pass = 0; pass < 4; pass++) await tick();
}

describe("memory core", () => {
  it("summarises on the speech timeline, not the wall clock", async () => {
    const r = setup();
    await speak(r, [0, 10, 20]);
    expect(r.llm.stageCalls).toBe(0);
    expect(r.core.blockCount).toBe(0);

    await speak(r, [30]);
    expect(r.core.blockCount).toBe(1);
    const block = r.updated[0];
    expect(block?.level).toBe(0);
    expect(block?.startTime).toBe(0);
    expect(block?.endTime).toBe(33);
    expect(block?.sourceBlockIds).toEqual([]);
    expect(r.summaries.list("s1").map((entry) => entry.id)).toEqual([block?.id]);
    expect(r.errors).toEqual([]);
  });

  it("waits out silence instead of summarising an empty window", async () => {
    const r = setup();
    await speak(r, [0, 10, 20]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle();
    expect(r.llm.stageCalls).toBe(0);
    expect(r.core.blockCount).toBe(0);
  });

  it("cannot be triggered by a partial", async () => {
    const r = setup();
    for (const time of [0, 10, 20, 30, 40, 50]) {
      counter += 1;
      r.transcript.acceptPartial(segment(`p-${counter}`, `还没说完 ${time}`, time));
    }
    await settle();
    expect(r.llm.stageCalls).toBe(0);
    expect(r.core.pendingCount).toBe(0);
    expect(r.summaries.count("s1")).toBe(0);
  });

  it("folds a full group upward and keeps the children", async () => {
    const r = setup();
    await speak(r, [0, 10, 20, 30]);
    await speak(r, [40, 50, 60, 70]);
    await speak(r, [80, 90, 100, 110]);

    const blocks = r.summaries.list("s1");
    expect(blocks.filter((block) => block.level === 0)).toHaveLength(3);
    expect(blocks.filter((block) => block.level === 1)).toHaveLength(1);

    const merged = blocks.find((block) => block.level === 1);
    const children = blocks.filter((block) => block.level === 0);
    expect(merged?.sourceBlockIds).toEqual(children.map((block) => block.id));
    expect(merged?.parentBlockId).toBe(children[0]?.id);
    expect([merged?.startTime, merged?.endTime]).toEqual([0, 113]);
    expect(r.summaries.count("s1")).toBe(4);
    expect(r.llm.mergeCalls).toBe(1);
  });

  it("reports a failed stage summary and keeps going", async () => {
    const r = setup({ failStages: 1 });
    await speak(r, [0, 10, 20, 30]);
    expect(r.core.blockCount).toBe(0);
    expect(r.core.pendingCount).toBe(0);
    expect(errors(r).map(([module, code]) => [module, code])).toEqual([["memory", "summary_failed"]]);

    await speak(r, [40, 50, 60, 70]);
    expect(r.core.blockCount).toBe(1);
    expect(r.llm.stageCalls).toBe(2);
  });

  it("leaves children pending when a merge fails and retries on the next block", async () => {
    const r = setup({ failMerges: 1 });
    await speak(r, [0, 10, 20, 30]);
    await speak(r, [40, 50, 60, 70]);
    await speak(r, [80, 90, 100, 110]);
    expect(r.summaries.count("s1")).toBe(3);
    expect(errors(r)).toContainEqual(["memory", "merge_failed"]);

    await speak(r, [120, 130, 140, 150]);
    const blocks = r.summaries.list("s1");
    expect(blocks.filter((block) => block.level === 1)).toHaveLength(1);
    expect(blocks.filter((block) => block.level === 0)).toHaveLength(4);
  });

  it("keeps children pending when a merged block cannot be written", async () => {
    // The merge asked the model, got an answer, and the row for that answer then failed to reach the
    // store. The queue had already dropped the children, so they stayed in the history but were
    // invisible to every later merge for the rest of the session.
    const r = setup();
    r.summaries.failNextWriteAtLevel = 1;
    await speak(r, [0, 10, 20, 30]);
    await speak(r, [40, 50, 60, 70]);
    await speak(r, [80, 90, 100, 110]);
    expect(r.summaries.count("s1")).toBe(3);
    expect(errors(r)).toContainEqual(["memory", "merge_failed"]);

    await speak(r, [120, 130, 140, 150]);
    expect(r.summaries.list("s1").filter((block) => block.level === 1)).toHaveLength(1);
  });

  it("runs one summary request at a time", async () => {
    const r = setup({ delayMs: 25 });
    await speak(r, [0, 10, 20]);
    counter += 1;
    r.transcript.acceptFinal(segment(`t-${counter}`, "第 30 秒的句子。", 30));
    await tick();
    // Speech keeps arriving while the model is still writing the first block.
    await speak(r, [40, 50, 60, 70]);
    await settle(40);

    expect(r.llm.maxActive).toBe(1);
    expect(r.core.blockCount).toBe(2);
    const second = r.updated.at(-1);
    expect(second?.startTime).toBe(40);
    expect(second?.endTime).toBe(73);
  });

  it("builds a bounded overview for the QA context", async () => {
    const r = setup({},{ mergeFactor: 99 });
    expect(r.core.globalSummary()).toBe("");
    await speak(r, [0, 10, 20, 30]);
    await speak(r, [40, 50, 60, 70]);
    await speak(r, [80, 90, 100, 110]);
    await speak(r, [120, 130, 140, 150]);
    await speak(r, [160, 170, 180, 190]);
    const overview = r.core.globalSummary();
    expect(overview).toContain("阶段5摘要");
    expect(overview).not.toContain("阶段1摘要");
    expect(overview.split("\n")).toHaveLength(4);

    const merged = setup();
    await speak(merged, [0, 10, 20, 30]);
    await speak(merged, [40, 50, 60, 70]);
    await speak(merged, [80, 90, 100, 110]);
    expect(merged.core.globalSummary()).toContain("【整体");
    expect(merged.core.globalSummary()).toContain("合并1摘要");
  });

  it("summarises the tail at stop, but only when there is something to summarise", async () => {
    const r = setup();
    await speak(r, [0, 10]);
    expect(r.core.pendingCount).toBe(2);
    await r.core.flushRemaining();
    await settle();
    expect(r.core.blockCount).toBe(1);
    expect(r.updated[0]?.endTime).toBe(13);

    const quiet = setup({}, { minSegments: 5 });
    await speak(quiet, [0, 10]);
    await quiet.core.flushRemaining();
    await settle();
    expect(quiet.core.blockCount).toBe(0);
  });

  /**
   * `trigger` used to hand `running` whatever `flushWindow` returned — including the no-op it returns
   * when the model is still busy. `flushRemaining` then believed the chain was done, `stop()` cleared
   * the window, and the closing sentences were never summarised. `windowSec: 0` makes every window due
   * so the second final reaches that branch.
   */
  it("waits for the summary that is still in flight when the recording ends", async () => {
    const r = setup({ holdStages: true }, { windowSec: 0 });
    await speak(r, [0]); // the window is due at once, so this request parks mid-flight
    await speak(r, [10]); // the next trigger finds the model busy: the old code stored that no-op
    expect(r.core.isBusy).toBe(true);
    expect(r.core.pendingCount).toBe(1);

    const drained = r.core.flushRemaining();
    await settle();
    r.llm.releaseStages();
    await drained;

    expect(r.core.blockCount).toBe(2);
    expect(r.core.pendingCount).toBe(0);
    const covered = r.llm.requests.flatMap((request) => request.sourceSegmentIds ?? []);
    expect(covered).toHaveLength(2);
    expect(new Set(covered).size).toBe(2);
    r.core.stop();
  });

  it("re-primes after a restart without folding absorbed blocks again", async () => {
    const first = setup();
    await speak(first, [0, 10, 20, 30]);
    await speak(first, [40, 50, 60, 70]);
    await speak(first, [80, 90, 100, 110]);
    expect(first.summaries.count("s1")).toBe(4);
    first.core.stop();

    const restarted = setup({}, {}, first);
    expect(restarted.core.blockCount).toBe(4);
    expect(restarted.core.pendingCount).toBe(0);

    await speak(restarted, [120, 130, 140, 150]);
    expect(restarted.llm.mergeCalls).toBe(0);
    expect(restarted.summaries.list("s1").filter((block) => block.level === 1)).toHaveLength(1);
    expect(restarted.summaries.count("s1")).toBe(5);
  });
});

function errors(r: Harness): [string, string][] {
  return r.errors.map((error) => [error.module, error.code] as [string, string]);
}
