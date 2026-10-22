import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { Structured, LLMProvider, LLMRequest } from "../src/llm/LLMProvider.js";
import { openSqlite } from "../src/store/sqlite.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { SqliteTranscriptRepository } from "../src/store/transcriptRepository.js";
import { SqliteGraphRepository } from "../src/store/graphRepository.js";
import { TranscriptCore } from "../src/transcript/TranscriptCore.js";
import { GraphStore } from "../src/graph/GraphStore.js";
import { MindMapAgent } from "../src/mindmap/MindMapAgent.js";
import { createBus } from "../src/bus/eventBus.js";
import { makeConfig, segment, tick } from "./helpers.js";
import type { ModuleError } from "@rcc/shared";

class StubLLM implements LLMProvider {
  readonly name = "stub";
  calls = 0;
  constructor(
    private readonly reply: (request: LLMRequest) => unknown,
    private readonly delayMs = 0,
  ) {}

  async generate() {
    return { text: "", responseId: "stub", inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  }

  async *stream() {
    yield "";
  }

  async structuredGenerate<T>(request: LLMRequest, _schema: z.ZodType<T>): Promise<Structured<T>> {
    this.calls += 1;
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return {
      data: this.reply(request) as T,
      responseId: `resp-${this.calls}`,
      latencyMs: this.delayMs,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}

function setup(llm: LLMProvider, overrides = {}) {
  const config = makeConfig(overrides);
  const store = openSqlite(":memory:");
  new SqliteSessionRepository(store.db).create({ id: "s1", startedAt: 1, status: "recording" });
  const bus = createBus();
  const transcripts = new SqliteTranscriptRepository(store.db);
  const transcript = new TranscriptCore(bus, transcripts);
  const graph = new GraphStore(bus, new SqliteGraphRepository(store.db), "s1");
  const agent = new MindMapAgent(bus, graph, llm, config, "s1");
  return { store, bus, transcript, graph, agent, config };
}

const addRoot = {
  operations: [{ type: "add_node", node: { id: "n-ai", title: "人工智能", sourceTranscriptIds: ["a"] } }],
};

describe("MindMap agent", () => {
  it("flushes once the batch threshold is reached", async () => {
    const llm = new StubLLM(() => addRoot);
    const { bus, agent, transcript, graph } = setup(llm, { mindmap: { ...makeConfig().mindmap, minSegments: 2 } });
    const updated: unknown[] = [];
    bus.on("mindmap", "mindmap.updated", (payload) => updated.push(payload));

    agent.start();
    transcript.acceptFinal(segment("a", "人工智能正在扩展。", 0));
    transcript.acceptFinal(segment("b", "世界模型是其中一支。", 8));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(llm.calls).toBe(1);
    expect(updated).toHaveLength(1);
    expect(graph.snapshot().nodes.map((node) => node.title)).toEqual(["人工智能"]);
    agent.stop();
  });

  it("runs only one request at a time and folds the rest into the next buffer", async () => {
    const llm = new StubLLM(() => ({ operations: [] }), 60);
    const { bus, agent, transcript } = setup(llm, {
      mindmap: { minSegments: 1, maxIntervalMs: 5000, windowSec: 60 },
    });
    const skipped: number[] = [];
    bus.on("mindmap", "mindmap.skipped", (payload) => skipped.push(payload.bufferedSegmentCount));

    agent.start();
    transcript.acceptFinal(segment("a", "第一句。", 0));
    transcript.acceptFinal(segment("b", "第二句。", 5));
    transcript.acceptFinal(segment("c", "第三句。", 9));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(llm.calls).toBe(2);
    expect(skipped.length).toBeGreaterThan(0);
    agent.stop();
  });

  /**
   * `consider` only fires at the threshold, so a segment that lands while a request is in flight is
   * left to the interval timer — and a session that ends within `maxIntervalMs` never reaches it.
   * `stop()` then throws the buffer away, so the last thing said never becomes a node.
   */
  it("drains the tail that landed during an in-flight request when asked to flush", async () => {
    const batches: string[][] = [];
    const llm = new StubLLM((request) => {
      batches.push(request.sourceSegmentIds ?? []);
      return { operations: [] };
    }, 60);
    const { agent, transcript } = setup(llm, {
      mindmap: { minSegments: 2, maxIntervalMs: 5000, windowSec: 60 },
    });

    agent.start();
    transcript.acceptFinal(segment("a", "第一句。", 0));
    transcript.acceptFinal(segment("b", "第二句。", 5));
    await tick();
    expect(agent.isBusy).toBe(true);

    transcript.acceptFinal(segment("c", "第三句。", 9));
    await tick();
    expect(agent.pendingCount).toBe(1);

    await agent.flush();

    expect(batches.flat()).toEqual(["a", "b", "c"]);
    expect(agent.pendingCount).toBe(0);
    agent.stop();
  });

  it("flushes on the interval even below the segment threshold", async () => {
    const llm = new StubLLM(() => ({ operations: [] }));
    const { agent, transcript } = setup(llm, {
      mindmap: { minSegments: 50, maxIntervalMs: 40, windowSec: 60 },
    });

    agent.start();
    transcript.acceptFinal(segment("a", "只有一句。", 0));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(llm.calls).toBe(1);
    agent.stop();
  });

  // Shape errors now fail earlier, in the adapter's repair loop (see mindmapWire.test.ts). What
  // reaches the reducer is schema-valid but may still be impossible against the live graph.
  it("discards impossible operations instead of throwing", async () => {
    const llm = new StubLLM(() => ({
      operations: [
        {
          type: "add_node",
          node: { id: "n-orphan", title: "挂在不存在的父节点下", parentId: "n-missing", sourceTranscriptIds: ["a"] },
        },
        { type: "update_node", nodeId: "n-ghost", patch: { title: "改名一个不存在的节点" } },
      ],
    }));
    const { bus, agent, transcript, graph } = setup(llm, {
      mindmap: { minSegments: 1, maxIntervalMs: 5000, windowSec: 60 },
    });
    const warnings: ModuleError[] = [];
    bus.onError((error) => warnings.push(error));

    agent.start();
    transcript.acceptFinal(segment("a", "句子。", 0));
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(graph.snapshot().nodes).toEqual([]);
    expect(warnings.filter((error) => error.module === "mindmap")).toEqual([]);
    agent.stop();
  });

  it("isolates an LLM failure to the MindMap module", async () => {
    const failing: LLMProvider = {
      name: "failing",
      generate: async () => {
        throw new Error("429 rate limited");
      },
      stream: () => {
        throw new Error("429 rate limited");
      },
      structuredGenerate: async () => {
        throw new Error("429 rate limited");
      },
    };
    const { bus, agent, transcript } = setup(failing, {
      mindmap: { minSegments: 1, maxIntervalMs: 5000, windowSec: 60 },
    });
    const errors: ModuleError[] = [];
    const finals: string[] = [];
    bus.onError((error) => errors.push(error));
    bus.on("qa", "transcript.final", (payload) => finals.push(payload.id));

    agent.start();
    transcript.acceptFinal(segment("a", "句子。", 0));
    transcript.acceptFinal(segment("b", "另一句。", 6));
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(errors.some((error) => error.module === "mindmap" && error.code === "update_failed")).toBe(true);
    expect(finals).toEqual(["a", "b"]);
    agent.stop();
  });

  it("discards a response that lands after the session was stopped", async () => {
    const llm = new StubLLM(() => addRoot, 60);
    const { bus, agent, transcript, graph } = setup(llm, {
      mindmap: { minSegments: 1, maxIntervalMs: 5000, windowSec: 60 },
    });
    const updated: unknown[] = [];
    bus.on("mindmap", "mindmap.updated", (payload) => updated.push(payload));

    agent.start();
    transcript.acceptFinal(segment("a", "人工智能正在扩展。", 0));
    await new Promise((resolve) => setTimeout(resolve, 10));
    agent.stop();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(llm.calls).toBe(1);
    expect(updated).toHaveLength(0);
    expect(graph.snapshot().nodes).toEqual([]);
  });

  it("refuses a forced flush once the session is stopped", async () => {
    const llm = new StubLLM(() => addRoot);
    const { agent, graph } = setup(llm, {
      mindmap: { minSegments: 1, maxIntervalMs: 5000, windowSec: 60 },
    });

    agent.start();
    agent.stop();
    await agent.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(llm.calls).toBe(0);
    expect(graph.snapshot().nodes).toEqual([]);
  });

  it("sends only recent finals and the current neighbourhood to the model", async () => {
    let lastRequest = "";
    const llm = new StubLLM((request) => {
      lastRequest = request.user;
      return { operations: [] };
    });
    const { agent, transcript } = setup(llm, { mindmap: { minSegments: 1, maxIntervalMs: 5000, windowSec: 60 } });

    agent.start();
    transcript.acceptFinal(segment("a", "很久以前的一句话。", 0));
    transcript.acceptFinal(segment("b", "刚才的一句话。", 10));
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(lastRequest).toContain("### 本批转写");
    expect(lastRequest).toContain("刚才的一句话。");
    expect(lastRequest).toContain("### 当前相关节点");
    agent.stop();
  });
});
