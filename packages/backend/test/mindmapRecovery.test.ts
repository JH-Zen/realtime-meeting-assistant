import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { Structured, LLMProvider, LLMRequest } from "../src/llm/LLMProvider.js";
import { openSqlite, type Sqlite } from "../src/store/sqlite.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { SqliteTranscriptRepository } from "../src/store/transcriptRepository.js";
import { SqliteGraphRepository } from "../src/store/graphRepository.js";
import { TranscriptCore } from "../src/transcript/TranscriptCore.js";
import { GraphStore } from "../src/graph/GraphStore.js";
import { MindMapAgent } from "../src/mindmap/MindMapAgent.js";
import { createBus, type AppBus } from "../src/bus/eventBus.js";
import { makeConfig, segment, tick } from "./helpers.js";
import type { BackendConfig } from "../src/config/env.js";
import type { ModuleError } from "@rcc/shared";

type Reply = (request: LLMRequest, call: number) => unknown | Promise<unknown>;

class ScriptedLLM implements LLMProvider {
  readonly name = "scripted";
  readonly calls: LLMRequest[] = [];
  private reply: Reply;

  constructor(reply: Reply) {
    this.reply = reply;
  }

  replyWith(reply: Reply): void {
    this.reply = reply;
  }

  async generate() {
    return { text: "", responseId: "scripted", inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  }

  async *stream() {
    yield "";
  }

  async structuredGenerate<T>(request: LLMRequest, _schema: z.ZodType<T>): Promise<Structured<T>> {
    this.calls.push(request);
    const call = this.calls.length;
    const data = await this.reply(request, call);
    return {
      data: data as T,
      responseId: `resp-${call}`,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}

interface Harness {
  sessionId: string;
  bus: AppBus;
  transcript: TranscriptCore;
  graph: GraphStore;
  repo: SqliteGraphRepository;
  agent: MindMapAgent;
  config: BackendConfig;
}

const openDbs: Sqlite[] = [];
const harnesses: Harness[] = [];

function freshDb(): Sqlite {
  const store = openSqlite(":memory:");
  openDbs.push(store);
  return store;
}

function attach(
  db: Sqlite,
  sessionId: string,
  llm: LLMProvider,
  mindmap: Partial<BackendConfig["mindmap"]> = {},
): Harness {
  new SqliteSessionRepository(db.db).create({ id: sessionId, startedAt: 1, status: "recording" });
  const base = makeConfig();
  const config = makeConfig({
    mindmap: { ...base.mindmap, maxIntervalMs: 5000, ...mindmap },
  });
  const bus = createBus();
  const transcript = new TranscriptCore(bus, new SqliteTranscriptRepository(db.db));
  const repo = new SqliteGraphRepository(db.db);
  const graph = new GraphStore(bus, repo, sessionId);
  const agent = new MindMapAgent(bus, graph, llm, config, sessionId, () => transcript.allFinals(sessionId));
  const harness = { sessionId, bus, transcript, graph, repo, agent, config };
  harnesses.push(harness);
  return harness;
}

function setup(llm: LLMProvider, mindmap: Partial<BackendConfig["mindmap"]> = {}): Harness {
  return attach(freshDb(), "s1", llm, mindmap);
}

function segmentFor(sessionId: string, id: string, startTime: number) {
  return { ...segment(id, `关于 ${id} 的句子。`, startTime), sessionId };
}

function addFinals(harness: Harness, ...ids: string[]): void {
  for (const [index, id] of ids.entries()) {
    harness.transcript.acceptFinal(segmentFor(harness.sessionId, id, index * 10));
  }
}

const addRoot = {
  operations: [
    {
      type: "add_node",
      node: { id: "n-ai", title: "人工智能", sourceTranscriptIds: ["a"] },
    },
  ],
};

function addNodeFor(request: LLMRequest) {
  const ids = request.sourceSegmentIds ?? [];
  const first = ids[0] ?? "unknown";
  return {
    operations: [
      {
        type: "add_node",
        node: { id: `n-${first}`, title: `节点 ${first}`, sourceTranscriptIds: ids },
      },
    ],
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred promise is not initialized"); };
  let reject: (reason?: unknown) => void = () => { throw new Error("Deferred promise is not initialized"); };
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function collectEvents(bus: AppBus) {
  const updates: unknown[] = [];
  const errors: ModuleError[] = [];
  bus.on("mindmap", "mindmap.updated", (payload) => updates.push(payload));
  bus.onError((error) => errors.push(error));
  return { updates, errors };
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    try {
      harness.agent.stop();
    } catch {
      // Cleanup must continue for the remaining harnesses.
    }
    harness.bus.clear();
  }
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // Already closed by a failed setup; nothing else to release.
    }
  }
  vi.restoreAllMocks();
});

describe("MindMap recovery", () => {
  it("reads historical finals without starting or calling the model", () => {
    const llm = new ScriptedLLM(() => ({ operations: [] }));
    const harness = setup(llm, { minSegments: 2 });
    addFinals(harness, "a", "b");

    expect(llm.calls).toHaveLength(0);
    expect(harness.agent.recoveryStatus).toMatchObject({
      sessionId: "s1",
      total: 2,
      processed: 0,
      missing: 2,
      busy: false,
      legacyUntracked: false,
    });
    expect(harness.agent.recoveryStatus.lastError).toBeFalsy();
    expect(llm.calls).toHaveLength(0);
    expect(harness.graph.snapshot().nodes).toEqual([]);
  });

  it("rebuilds a historical agent that was never started", async () => {
    const llm = new ScriptedLLM((request) => addNodeFor(request));
    const harness = setup(llm, { minSegments: 2 });
    addFinals(harness, "a", "b");

    expect(harness.agent.isBusy).toBe(false);
    await harness.agent.rebuildMissing();

    expect(harness.graph.snapshot().nodes.map((node) => node.id)).toEqual(["n-a"]);
    expect(harness.agent.recoveryStatus).toMatchObject({
      total: 2,
      processed: 2,
      missing: 0,
      busy: false,
    });
  });

  it("marks an empty-operations batch processed and does not repeat it", async () => {
    const llm = new ScriptedLLM(() => ({ operations: [] }));
    const harness = setup(llm, { minSegments: 2 });
    addFinals(harness, "a", "b", "c");

    await harness.agent.rebuildMissing();

    expect(llm.calls).toHaveLength(2);
    expect(harness.agent.recoveryStatus).toMatchObject({
      total: 3,
      processed: 3,
      missing: 0,
      busy: false,
    });
    expect(harness.agent.recoveryStatus.completedBatches).toBe(2);
    expect(harness.graph.snapshot().nodes).toEqual([]);

    await harness.agent.rebuildMissing();
    expect(llm.calls).toHaveLength(2);
  });

  it("retries a transient model failure and then records the batch success", async () => {
    const llm = new ScriptedLLM((request, call) => {
      if (call === 1) throw new Error("temporary 429");
      return addNodeFor(request);
    });
    const harness = setup(llm, { minSegments: 2 });
    addFinals(harness, "a", "b");

    await harness.agent.rebuildMissing();

    expect(llm.calls).toHaveLength(2);
    expect(harness.agent.recoveryStatus).toMatchObject({
      total: 2,
      processed: 2,
      missing: 0,
      busy: false,
    });
    expect([...harness.graph.processedSegmentIds()].sort()).toEqual(["a", "b"]);
    expect(harness.graph.snapshot().nodes.map((node) => node.id)).toEqual(["n-a"]);
  });

  it("stops after three failed attempts and recovers on a later rebuild", async () => {
    const llm = new ScriptedLLM(() => {
      throw new Error("provider down");
    });
    const harness = setup(llm, { minSegments: 2 });
    addFinals(harness, "a", "b");

    await harness.agent.rebuildMissing();

    expect(llm.calls).toHaveLength(3);
    expect(harness.agent.recoveryStatus).toMatchObject({
      total: 2,
      processed: 0,
      missing: 2,
      busy: false,
    });
    expect(harness.agent.recoveryStatus.lastError).toBeTruthy();
    expect(harness.graph.processedSegmentIds().size).toBe(0);
    expect(harness.graph.snapshot().nodes).toEqual([]);

    llm.replyWith((request) => addNodeFor(request));
    await harness.agent.rebuildMissing();

    expect(llm.calls).toHaveLength(4);
    expect(harness.agent.recoveryStatus).toMatchObject({ processed: 2, missing: 0 });
    expect(harness.graph.snapshot().nodes.map((node) => node.id)).toEqual(["n-a"]);
  });

  it("processes at most eight batches per rebuild", async () => {
    const llm = new ScriptedLLM(() => ({ operations: [] }));
    const harness = setup(llm, { minSegments: 1 });
    addFinals(harness, ...Array.from({ length: 9 }, (_, index) => `s${index}`));

    await harness.agent.rebuildMissing();

    expect(llm.calls).toHaveLength(8);
    expect(harness.agent.recoveryStatus).toMatchObject({
      total: 9,
      processed: 8,
      missing: 1,
    });
    expect(harness.agent.recoveryStatus.completedBatches).toBe(8);

    await harness.agent.rebuildMissing();

    expect(llm.calls).toHaveLength(9);
    expect(harness.agent.recoveryStatus).toMatchObject({ processed: 9, missing: 0 });
  });

  it("merges concurrent rebuild calls into a single flight", async () => {
    const gate = deferred<unknown>();
    const llm = new ScriptedLLM(() => gate.promise);
    const harness = setup(llm, { minSegments: 3 });
    addFinals(harness, "a", "b", "c");

    const first = harness.agent.rebuildMissing();
    await tick();
    expect(llm.calls).toHaveLength(1);
    expect(harness.agent.recoveryStatus.busy).toBe(true);

    const second = harness.agent.rebuildMissing();
    await tick();
    expect(llm.calls).toHaveLength(1);

    gate.resolve({ operations: [] });
    await Promise.all([first.catch(() => undefined), second.catch(() => undefined)]);

    expect(llm.calls).toHaveLength(1);
    expect(harness.agent.recoveryStatus).toMatchObject({
      processed: 3,
      missing: 0,
      busy: false,
    });
  });

  it("waits for a live request to settle before rebuilding", async () => {
    const gate = deferred<unknown>();
    const llm = new ScriptedLLM(() => gate.promise);
    const harness = setup(llm, { minSegments: 1 });
    harness.agent.start();
    addFinals(harness, "a");
    await tick();
    expect(llm.calls).toHaveLength(1);

    const rebuild = harness.agent.rebuildMissing();
    await tick();
    expect(llm.calls).toHaveLength(1);

    gate.resolve({ operations: [] });
    await tick();
    await rebuild.catch(() => undefined);

    expect(harness.agent.recoveryStatus.busy).toBe(false);
  });

  it("does not write a recovery response that arrives after stop", async () => {
    const gate = deferred<unknown>();
    const llm = new ScriptedLLM(() => gate.promise);
    const harness = setup(llm, { minSegments: 2 });
    addFinals(harness, "a", "b");
    const events = collectEvents(harness.bus);

    const rebuild = harness.agent.rebuildMissing();
    await tick();
    expect(llm.calls).toHaveLength(1);

    harness.agent.stop();
    gate.resolve(addRoot);
    await rebuild.catch(() => undefined);
    await tick();

    expect(events.updates).toHaveLength(0);
    expect(events.errors).toHaveLength(0);
    expect(harness.graph.snapshot().nodes).toEqual([]);
    expect(harness.graph.processedSegmentIds().size).toBe(0);
    expect(harness.agent.recoveryStatus.processed).toBe(0);
  });

  it("does not report or retry a recovery rejection that arrives after stop", async () => {
    const gate = deferred<unknown>();
    const llm = new ScriptedLLM(() => gate.promise);
    const harness = setup(llm, { minSegments: 2 });
    addFinals(harness, "a", "b");
    const events = collectEvents(harness.bus);

    const rebuild = harness.agent.rebuildMissing();
    await tick();
    expect(llm.calls).toHaveLength(1);

    harness.agent.stop();
    gate.reject(new Error("late failure"));
    await rebuild.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(llm.calls).toHaveLength(1);
    expect(events.errors).toHaveLength(0);
    expect(harness.graph.snapshot().nodes).toEqual([]);
    expect(harness.graph.processedSegmentIds().size).toBe(0);
    expect(harness.agent.recoveryStatus.lastError).toBeFalsy();
  });

  it("leaves a batch missing when its transaction fails, then applies it on retry", async () => {
    const llm = new ScriptedLLM((request) => addNodeFor(request));
    const harness = setup(llm, { minSegments: 2 });
    addFinals(harness, "a", "b");
    const putSpy = vi.spyOn(harness.repo, "recordProcessedSegments").mockImplementation(() => {
      throw new Error("disk full");
    });

    await harness.agent.rebuildMissing();

    expect(putSpy).toHaveBeenCalledTimes(3);
    expect(harness.agent.recoveryStatus).toMatchObject({
      total: 2,
      processed: 0,
      missing: 2,
    });
    expect(harness.agent.recoveryStatus.lastError).toBeTruthy();
    expect(harness.graph.snapshot().nodes).toEqual([]);
    expect(harness.graph.processedSegmentIds().size).toBe(0);

    putSpy.mockRestore();
    await harness.agent.rebuildMissing();

    expect(harness.agent.recoveryStatus).toMatchObject({ processed: 2, missing: 0 });
    expect(harness.graph.processedSegmentIds().size).toBe(2);
    expect(harness.graph.snapshot().nodes.map((node) => node.id)).toEqual(["n-a"]);
  });

  it("bounds persistent write failures and keeps them unindexed", async () => {
    const llm = new ScriptedLLM((request) => addNodeFor(request));
    const harness = setup(llm, { minSegments: 2 });
    addFinals(harness, "a", "b");
    const putSpy = vi.spyOn(harness.repo, "recordProcessedSegments").mockImplementation(() => {
      throw new Error("disk full");
    });

    await harness.agent.rebuildMissing();

    expect(putSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(putSpy.mock.calls.length).toBeLessThanOrEqual(3);
    expect(llm.calls.length).toBeLessThanOrEqual(3);
    expect(harness.agent.recoveryStatus).toMatchObject({
      total: 2,
      processed: 0,
      missing: 2,
    });
    expect(harness.agent.recoveryStatus.lastError).toBeTruthy();
    expect(harness.graph.snapshot().nodes).toEqual([]);
    expect(harness.graph.processedSegmentIds().size).toBe(0);
  });

  it("reads the processed ledger after rebuilding the graph and agent", async () => {
    const llm = new ScriptedLLM((request) => addNodeFor(request));
    const harness = setup(llm, { minSegments: 2 });
    addFinals(harness, "a", "b");

    await harness.agent.rebuildMissing();
    const callsBefore = llm.calls.length;

    const graph = new GraphStore(harness.bus, harness.repo, "s1");
    graph.hydrate();
    expect([...graph.processedSegmentIds()].sort()).toEqual(["a", "b"]);

    const agent = new MindMapAgent(
      harness.bus,
      graph,
      llm,
      harness.config,
      "s1",
      () => harness.transcript.allFinals("s1"),
    );
    expect(agent.recoveryStatus).toMatchObject({
      total: 2,
      processed: 2,
      missing: 0,
      legacyUntracked: false,
    });

    await agent.rebuildMissing();
    expect(llm.calls).toHaveLength(callsBefore);
    expect(graph.snapshot().nodes.map((node) => node.id)).toEqual(["n-a"]);
  });

  it("keeps recovery ledgers and graphs isolated per session", async () => {
    const db = freshDb();
    const llmOne = new ScriptedLLM((request) => addNodeFor(request));
    const llmTwo = new ScriptedLLM((request) => addNodeFor(request));
    const one = attach(db, "s1", llmOne, { minSegments: 1 });
    const two = attach(db, "s2", llmTwo, { minSegments: 1 });
    addFinals(one, "a");
    addFinals(two, "b");

    await one.agent.rebuildMissing();
    await two.agent.rebuildMissing();

    expect([...one.graph.processedSegmentIds()]).toEqual(["a"]);
    expect([...two.graph.processedSegmentIds()]).toEqual(["b"]);
    expect(one.graph.snapshot().nodes.map((node) => node.id)).toEqual(["n-a"]);
    expect(two.graph.snapshot().nodes.map((node) => node.id)).toEqual(["n-b"]);
    expect(one.agent.recoveryStatus).toMatchObject({
      sessionId: "s1",
      total: 1,
      processed: 1,
      missing: 0,
    });
    expect(two.agent.recoveryStatus).toMatchObject({
      sessionId: "s2",
      total: 1,
      processed: 1,
      missing: 0,
    });
    expect(llmOne.calls.flatMap((call) => call.sourceSegmentIds ?? [])).toEqual(["a"]);
    expect(llmTwo.calls.flatMap((call) => call.sourceSegmentIds ?? [])).toEqual(["b"]);
  });

  it("flags a legacy graph without a ledger instead of treating it as recovered", () => {
    const llm = new ScriptedLLM(() => ({ operations: [] }));
    const harness = setup(llm, { minSegments: 2 });
    addFinals(harness, "a", "b");
    harness.repo.upsertNode("s1", {
      id: "legacy-node",
      title: "旧节点",
      sourceTranscriptIds: ["a"],
      createdAt: 1,
      updatedAt: 1,
    });
    const graph = new GraphStore(harness.bus, harness.repo, "s1");
    graph.hydrate();
    const agent = new MindMapAgent(
      harness.bus,
      graph,
      llm,
      harness.config,
      "s1",
      () => harness.transcript.allFinals("s1"),
    );

    expect(graph.processedSegmentIds().size).toBe(0);
    expect(agent.recoveryStatus).toMatchObject({
      sessionId: "s1",
      total: 2,
      processed: 0,
      missing: 2,
      legacyUntracked: true,
    });
    expect(llm.calls).toHaveLength(0);
    expect(graph.snapshot().nodes.map((node) => node.id)).toEqual(["legacy-node"]);
  });

  it("does not apply part of a batch when any operation is rejected", async () => {
    let illegal = true;
    const llm = new ScriptedLLM(() =>
      illegal
        ? {
            operations: [
              {
                type: "add_node",
                node: { id: "n-ok", title: "合法节点", sourceTranscriptIds: ["a"] },
              },
              {
                type: "update_node",
                nodeId: "n-ghost",
                patch: { title: "非法修改" },
              },
            ],
          }
        : {
            operations: [
              {
                type: "add_node",
                node: { id: "n-ok", title: "合法节点", sourceTranscriptIds: ["a"] },
              },
            ],
          },
    );
    const harness = setup(llm, { minSegments: 1 });
    addFinals(harness, "a");

    await harness.agent.rebuildMissing();

    expect(llm.calls).toHaveLength(3);
    expect(harness.agent.recoveryStatus).toMatchObject({
      total: 1,
      processed: 0,
      missing: 1,
    });
    expect(harness.agent.recoveryStatus.lastError).toBeTruthy();
    expect(harness.graph.snapshot().nodes).toEqual([]);
    expect(harness.graph.processedSegmentIds().size).toBe(0);

    illegal = false;
    await harness.agent.rebuildMissing();

    expect(harness.agent.recoveryStatus).toMatchObject({ processed: 1, missing: 0 });
    expect(harness.graph.snapshot().nodes.map((node) => node.id)).toEqual(["n-ok"]);
    expect([...harness.graph.processedSegmentIds()]).toEqual(["a"]);
  });
});
