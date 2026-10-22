import { afterEach, describe, expect, it } from "vitest";
import type { GraphOperation, ModuleError, TranscriptSegment } from "@rcc/shared";
import type { BackendConfig } from "../src/config/env.js";
import { createBus } from "../src/bus/eventBus.js";
import { GraphStore } from "../src/graph/GraphStore.js";
import { MindMapAgent } from "../src/mindmap/MindMapAgent.js";
import { OpenAICompatProvider } from "../src/llm/OpenAICompatProvider.js";
import { openSqlite } from "../src/store/sqlite.js";
import { SqliteGraphRepository } from "../src/store/graphRepository.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { SqliteTranscriptRepository } from "../src/store/transcriptRepository.js";
import { TranscriptCore } from "../src/transcript/TranscriptCore.js";
import { makeConfig, segment, tick } from "./helpers.js";
import { startLlmStub, type LlmStub, type StubReply } from "./llmStubServer.js";

/**
 * The chain the design doc mandates — LLM Output → Schema Validation → Graph Engine → Graph Store →
 * UI — exercised with the model replaced by a local OpenAI-compatible endpoint, so the JSON really
 * crosses HTTP and the SDK really parses it. No API key, and nothing here is mocked below the wire.
 */

interface Runtime {
  bus: ReturnType<typeof createBus>;
  transcript: TranscriptCore;
  graph: GraphStore;
  agent: MindMapAgent;
  repo: SqliteGraphRepository;
  transcripts: SqliteTranscriptRepository;
}

let stub: LlmStub | null = null;

async function runtime(replies: StubReply[], llm: Partial<BackendConfig["llm"]> = {}): Promise<Runtime> {
  stub = await startLlmStub(replies);
  const config = makeConfig({
    mindmap: { minSegments: 2, maxIntervalMs: 5000, windowSec: 120 },
    llm: { baseUrl: stub.baseUrl, apiKey: "test-key", model: "stub-model", timeoutMs: 4000, maxRetries: 0, disableThinking: false },
    ...llm,
  });
  const store = openSqlite(":memory:");
  new SqliteSessionRepository(store.db).create({ id: "s1", startedAt: 1, status: "recording" });
  const bus = createBus();
  const transcripts = new SqliteTranscriptRepository(store.db);
  const repo = new SqliteGraphRepository(store.db);
  const graph = new GraphStore(bus, repo, "s1");
  const agent = new MindMapAgent(bus, graph, new OpenAICompatProvider(config.llm), config, "s1");
  return { bus, transcript: new TranscriptCore(bus, transcripts), graph, agent, repo, transcripts };
}

const speak = async (r: Runtime, texts: string[], offset = 0): Promise<void> => {
  for (const [index, text] of texts.entries()) {
    r.transcript.acceptFinal(segment(`seg-${offset + index}`, text, (offset + index) * 10));
  }
  for (let i = 0; i < 8; i++) await tick();
};

/** The agent stays busy until the response has been applied, so that plus a request count is the signal. */
async function settle(r: Runtime, expectedRequests: number): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if ((stub?.requests.length ?? 0) >= expectedRequests && !r.agent.isBusy) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (let i = 0; i < 4; i++) await tick();
}

const opsPayload = (operations: unknown[]) => ({ content: JSON.stringify({ operations }) });

afterEach(async () => {
  await stub?.close();
  stub = null;
});

describe("mindmap over the real LLM wire", () => {
  it("applies nodes that arrived as JSON, and persists them", async () => {
    const r = await runtime([
      opsPayload([
        { type: "add_node", node: { id: "n-world", title: "世界模型", sourceTranscriptIds: ["seg-0"] } },
        {
          type: "add_node",
          node: { id: "n-dyn", title: "学习环境动态", parentId: "n-world", sourceTranscriptIds: ["seg-1"] },
        },
      ]),
    ]);
    const batches: GraphOperation[][] = [];
    r.bus.on("ui", "mindmap.updated", (payload) => batches.push(payload.operations));

    r.agent.start();
    await speak(r, ["今天讨论世界模型。", "世界模型能够学习环境的动态变化。"]);
    await settle(r, 1);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((op) => op.type)).toEqual(["add_node", "add_node"]);
    expect(r.graph.snapshot().nodes.map((row) => row.title)).toEqual(["世界模型", "学习环境动态"]);
    // The same rows the UI reads must be the rows SQLite holds — one authority, not two.
    expect(r.repo.loadNodes("s1").map((row) => row.id)).toEqual(["n-world", "n-dyn"]);
  });

  // Shape errors earn a repair attempt (last case); these are well-formed requests the graph simply
  // cannot honour, so the reducer discards them and the legal operations still land.
  it("discards an impossible operation while keeping the legal ones", async () => {
    const r = await runtime([
      opsPayload([
        { type: "add_node", node: { id: "n-ok", title: "人工智能", sourceTranscriptIds: ["seg-0"] } },
        {
          type: "add_node",
          node: { id: "n-orphan", title: "挂在不存在的父节点下", parentId: "n-ghost", sourceTranscriptIds: ["seg-1"] },
        },
        { type: "add_edge", edge: { id: "e1", source: "n-ok", target: "n-ghost" } },
      ]),
    ]);
    const errors: ModuleError[] = [];
    r.bus.onError((error) => errors.push(error));

    r.agent.start();
    await speak(r, ["人工智能正在扩展到世界模型。", "语言模型预测下一个词。"]);
    await settle(r, 1);

    expect(r.graph.snapshot().nodes.map((row) => row.id)).toEqual(["n-ok"]);
    expect(errors.filter((error) => error.module === "mindmap")).toEqual([]);
    // Only the surviving operation may reach the client, so the UI cannot render a phantom edge.
    expect(stub?.requests).toHaveLength(1);
  });

  it("degrades only the map when the endpoint is down, leaving the transcript intact", async () => {
    const r = await runtime([{ status: 503 }]);
    const errors: ModuleError[] = [];
    const finals: TranscriptSegment[] = [];
    r.bus.onError((error) => errors.push(error));
    r.bus.on("ui", "transcript.final", (segmentPayload) => finals.push(segmentPayload));

    r.agent.start();
    await speak(r, ["第一句。", "第二句。"]);
    await settle(r, 1);

    expect(r.graph.snapshot().nodes).toEqual([]);
    expect(errors.map((error) => [error.module, error.code])).toEqual([["mindmap", "update_failed"]]);
    expect(finals).toHaveLength(2);
    expect(r.transcripts.listFinal("s1")).toHaveLength(2);
  });

  it("repairs a rejected response before it reaches the graph engine", async () => {
    const r = await runtime([
      opsPayload([{ type: "add_node", node: { id: "n-x" } }]),
      opsPayload([{ type: "add_node", node: { id: "n-x", title: "仿真到真实差距", sourceTranscriptIds: ["seg-0"] } }]),
    ]);

    r.agent.start();
    await speak(r, ["训练世界模型的代价是仿真与真实的差距。", "评估的关键是一致性。"]);
    await settle(r, 2);

    expect(stub?.requests).toHaveLength(2);
    expect(r.graph.snapshot().nodes.map((row) => row.title)).toEqual(["仿真到真实差距"]);
    const retry = stub?.requests[1]?.body.messages[1]?.content ?? "";
    expect(retry).toContain("上一次输出未通过校验");
  });

  it("bounds the repair at one retry and stays usable afterwards", async () => {
    const r = await runtime([opsPayload([{ type: "add_node", node: { id: "n-x" } }])]);
    const errors: ModuleError[] = [];
    r.bus.onError((error) => errors.push(error));

    r.agent.start();
    await speak(r, ["训练世界模型的代价是仿真与真实的差距。", "评估的关键是一致性。"]);
    await settle(r, 2);

    // The stub repeats its last reply, so the model is stubborn: one attempt plus exactly one repair.
    expect(stub?.requests).toHaveLength(2);
    expect(r.graph.snapshot().nodes).toEqual([]);
    expect(errors.map((error) => [error.module, error.code])).toEqual([["mindmap", "update_failed"]]);
    expect(r.transcripts.listFinal("s1")).toHaveLength(2);

    // A failed batch must not wedge the single-flight lock.
    await speak(r, ["第三句。", "第四句。"], 2);
    await settle(r, 3);
    expect(stub?.requests).toHaveLength(4);
  });
});
