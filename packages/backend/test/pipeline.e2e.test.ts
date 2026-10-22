import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { MOCK_SCRIPT, MOCK_SCRIPT_SPAN_SEC, mockSegmentId } from "../src/testing/mockScript.js";
import { MockLLMProvider } from "../src/llm/MockLLMProvider.js";
import type { LLMProvider, LLMRequest } from "../src/llm/LLMProvider.js";
import { formatClock } from "../src/prompts/format.js";
import { createHarness as harness, wait } from "./pipelineHarness.js";
import type { AnswerCompleted, GraphOperation, ModuleError } from "@rcc/shared";

/**
 * The §52 end-to-end path with every component real except the model:
 * mock transcript → Transcript Core → store → bus → MindMap agent → operations → graph update.
 * The script plays at 500× so the whole minute of "speech" lands in a few hundred milliseconds.
 */

describe("mock pipeline e2e", () => {
  it("grows the graph from the scripted transcript, incrementally", async () => {
    const h = harness();
    const batches: GraphOperation[][] = [];
    const errors: ModuleError[] = [];
    const finals: string[] = [];
    let stopped: { segmentCount: number; durationSec: number } | null = null;

    h.bus.on("ui", "mindmap.updated", (payload) => {
      batches.push(payload.operations);
    });
    h.bus.on("ui", "transcript.final", (segment) => {
      finals.push(segment.id);
    });
    h.bus.on("ui", "recording.stopped", (payload) => {
      stopped = { segmentCount: payload.segmentCount, durationSec: payload.durationSec };
    });
    h.bus.onError((error) => errors.push(error));

    const sessionId = await h.recording.start("mock");
    await wait(400);
    const runtime = h.recording.current;
    await h.recording.stop();

    expect(errors).toEqual([]);
    expect(finals).toEqual(MOCK_SCRIPT.map((_, index) => mockSegmentId(sessionId, index)));

    // Only finals are durable, and they are exactly the scripted lines.
    expect(h.transcripts.listFinal(sessionId).map((row) => row.text)).toEqual(MOCK_SCRIPT.map((line) => line.text));

    // Every published operation is additive: the tree grows, it is never regenerated.
    const operations = batches.flat();
    expect(new Set(operations.map((op) => op.type))).toEqual(new Set(["add_node"]));
    expect(operations.length).toBeGreaterThan(3);

    const nodes = runtime?.graph.snapshot().nodes ?? [];
    expect(nodes.map((node) => node.title)).toEqual(
      expect.arrayContaining(["世界模型", "人工智能", "学习环境动态"]),
    );
    // Parents resolve against nodes the same agent created earlier, so the tree is connected.
    expect(nodes.filter((node) => node.parentId).length).toBeGreaterThan(0);
    // Layout is derived, never stored: the only coordinates the server holds are the ones a user
    // dragged (ADR §6.1 D-17), and nobody dragged in this run.
    expect(runtime?.graph.positions() ?? {}).toEqual({});

    // The operation log is the replay-proof audit trail (§5).
    expect(h.graphs.seenOpIds(sessionId).length).toBe(operations.length);
    expect(stopped).toEqual({ segmentCount: MOCK_SCRIPT.length, durationSec: expect.any(Number) });

    h.close();
  });

  it("keeps subtitles flowing when the MindMap model is unavailable (Test E)", async () => {
    const brokenLlm: LLMProvider = {
      name: "broken",
      generate: async () => {
        throw new Error("offline");
      },
      stream: () => {
        throw new Error("offline");
      },
      structuredGenerate: async () => {
        throw new Error("offline");
      },
    };
    const h = harness({ llm: brokenLlm, minSegments: 1 });
    const finals: string[] = [];
    const errors: ModuleError[] = [];
    h.bus.on("ui", "transcript.final", (segment) => {
      finals.push(segment.id);
    });
    h.bus.onError((error) => errors.push(error));

    await h.recording.start("mock");
    await wait(300);
    await h.recording.stop();

    expect(finals).toHaveLength(MOCK_SCRIPT.length);
    expect(errors.length).toBeGreaterThan(0);
    // Test E's promise is about what keeps working: only the modules that need the model fail, and
    // the audio path reports nothing.
    expect(new Set(errors.map((error) => error.module))).toEqual(new Set(["mindmap", "memory"]));

    h.close();
  });

  it("publishes nothing for a MindMap response that proposes no change", async () => {
    const emptyLlm: LLMProvider = {
      name: "empty",
      generate: async () => ({ text: "", responseId: "r", inputTokens: 0, outputTokens: 0, latencyMs: 0 }),
      stream: async function* () {
        yield "";
      },
      structuredGenerate: async <T>(request: LLMRequest, schema: z.ZodType<T>) => ({
        // Returned through the caller's own schema: if the real summary/graph schemas change shape,
        // this mock fails loudly instead of quietly handing back something that no longer parses.
        data: schema.parse(
          request.task === "summary"
            ? { summary: "模型没有给出新信息。", keyPoints: [], entities: [] }
            : { operations: [] },
        ),
        responseId: "r",
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
      }),
    };
    const h = harness({ llm: emptyLlm });
    let updates = 0;
    h.bus.on("ui", "mindmap.updated", () => {
      updates += 1;
    });

    await h.recording.start("mock");
    await wait(300);
    const graph = h.recording.current?.graph;
    await h.recording.stop();

    expect(updates).toBeGreaterThan(0);
    expect(graph?.snapshot().nodes ?? ["unexpected node"]).toEqual([]);
    h.close();
  });

  // Both recordings mint the same scripted segment ids and the same node titles, so this is the
  // case a globally-unique primary key silently throws away.
  it("writes append-only stage summaries from the same finals the map used", async () => {
    const h = harness();
    const frames: { id: string; level: number; startTime: number; endTime: number }[] = [];
    const errors: ModuleError[] = [];
    h.bus.on("ui", "summary.updated", (payload) => {
      frames.push(payload.block);
    });
    h.bus.onError((error) => errors.push(error));

    const sessionId = await h.recording.start("mock");
    await wait(400);
    const runtime = h.recording.current;
    await h.recording.stop();

    expect(errors).toEqual([]);
    expect(frames.length).toBeGreaterThan(0);

    const blocks = h.summaries.list(sessionId);
    expect(blocks.map((block) => block.id)).toEqual(frames.map((frame) => frame.id));
    expect(new Set(blocks.map((block) => block.level))).toEqual(new Set([0]));
    // Windows are contiguous and never overlap: one stretch of speech is summarised exactly once.
    for (const [index, block] of blocks.entries()) {
      expect(block.endTime).toBeGreaterThan(block.startTime);
      if (index > 0) expect(block.startTime).toBeGreaterThan(blocks[index - 1]?.endTime ?? 0);
    }
    expect(blocks[0]?.summary).toContain("本阶段共");
    expect(blocks[0]?.entities.length).toBeGreaterThan(0);
    // The whole script is covered by the first window through the last one.
    expect(blocks[0]?.startTime).toBe(0);
    expect(blocks.at(-1)?.endTime).toBeGreaterThanOrEqual(MOCK_SCRIPT.length * 10 - 1);
    expect(runtime?.memory.globalSummary()).toContain("【");
    expect(runtime?.memory.pendingCount).toBe(0);

    h.close();
  });

  it("answers from a line that has left Hot Context, citing the index (Test D)", async () => {
    // §56 Test D asks for "a line from about ten minutes ago". The script only spans 79 s of speech
    // time, so this pins the mechanism at mock scale: a window short enough that the target has
    // scrolled out, the index is the only place it can come from, and the citation must point back
    // at its own speech time. The 10-minute-and-longer version is the Phase 9 run's job, not this file's.
    const qaUsers: string[] = [];
    const inner = new MockLLMProvider();
    const spy: LLMProvider = {
      name: inner.name,
      generate: (request) => inner.generate(request),
      structuredGenerate: (request, schema) => inner.structuredGenerate(request, schema),
      stream: (request: LLMRequest) => {
        if (request.task === "qa") qaUsers.push(request.user);
        return inner.stream(request);
      },
    };

    const h = harness({ llm: spy, hotContextSec: 15 });
    const completed: AnswerCompleted[] = [];
    const errors: ModuleError[] = [];
    h.bus.on("ui", "answer.completed", (payload) => {
      completed.push(payload);
    });
    h.bus.onError((error) => errors.push(error));

    const sessionId = await h.recording.start("mock");
    await wait(400);
    const runtime = h.recording.current;
    if (!runtime) throw new Error("recording did not start");
    await runtime.retrieval.flushPending();

    const targetId = mockSegmentId(sessionId, 2);
    const hot = runtime.transcript.window(sessionId, 15);
    expect(runtime.retrieval.indexedCount).toBe(MOCK_SCRIPT.length);
    expect(runtime.retrieval.droppedCount).toBe(0);
    // Precondition: the asked-about line really is outside the window, so a hit cannot come from there.
    expect(hot.map((segment) => segment.id)).not.toContain(targetId);

    await runtime.qa.ask("q1", "这项技术能用在哪些场景，比如机器人和自动驾驶？");

    expect(errors).toEqual([]);
    expect(qaUsers).toHaveLength(1);
    expect(qaUsers[0]).toContain("### 检索到的历史转写\n[00:20] 这项技术可以应用于机器人和自动驾驶。");
    // The two context sections must not quote the same sentence twice: everything still in the window
    // is excluded from the index query.
    const user = qaUsers[0] ?? "";
    const archivedSection = user.split("### 检索到的历史转写")[1]?.split("### 问题")[0] ?? "";
    for (const item of hot) expect(archivedSection).not.toContain(formatClock(item.startTime));

    expect(completed).toHaveLength(1);
    expect(completed[0]?.degraded).toBe(false);
    expect(completed[0]?.citations).toEqual(expect.arrayContaining([{ transcriptId: targetId, startTime: 20 }]));

    await h.recording.stop();
    h.close();
  });

  it("keeps growing the map across repeated passes of the script", async () => {
    // Test F replays one 79 s script for tens of minutes. If the second pass matched the first by
    // title, the map would plateau at eight nodes and the soak would measure nothing at all.
    const passes = 3;
    const h = harness({ repeat: passes });
    const finals: string[] = [];
    h.bus.on("ui", "transcript.final", (segment) => {
      finals.push(segment.id);
    });

    const want = MOCK_SCRIPT.length * passes;
    const sessionId = await h.recording.start("mock");
    // One pass plays in 79 s / 500 = 158 ms and each extra pass is chained after the previous span, so
    // three passes only finish at ~476 ms. A fixed `wait(500)` left 24 ms of margin and dropped the
    // last final whenever the machine was busy — wait for the schedule to drain instead of racing it,
    // including the map batch the last final still has to produce.
    const drained = () =>
      finals.length >= want && (h.recording.current?.graph.snapshot().nodes.length ?? 0) >= want;
    for (let waited = 0; !drained() && waited < 3000; waited += 20) await wait(20);
    const runtime = h.recording.current;
    await h.recording.stop();

    expect(finals).toHaveLength(MOCK_SCRIPT.length * passes);
    expect(new Set(finals).size).toBe(finals.length);
    expect(h.transcripts.listFinal(sessionId)).toHaveLength(finals.length);

    const nodes = runtime?.graph.snapshot().nodes ?? [];
    expect(nodes).toHaveLength(MOCK_SCRIPT.length * passes);
    expect(new Set(nodes.map((node) => node.id)).size).toBe(nodes.length);
    expect(nodes.map((node) => node.title)).toEqual(
      expect.arrayContaining(["世界模型", "世界模型·2", "世界模型·3", "学习环境动态·2"]),
    );
    // Each pass roots its own branch: a repeated line never re-parents onto the earlier pass.
    for (const node of nodes) {
      if (!node.parentId) continue;
      expect(nodes.some((candidate) => candidate.id === node.parentId)).toBe(true);
      const pass = /[·](\d+)$/.exec(node.title)?.[1] ?? "1";
      const parent = nodes.find((candidate) => candidate.id === node.parentId);
      expect(/[·](\d+)$/.exec(parent?.title ?? "")?.[1] ?? "1").toBe(pass);
    }
    // Speech time keeps running forward instead of restarting at zero.
    expect(h.transcripts.listFinal(sessionId).at(-2)?.startTime).toBeGreaterThan(MOCK_SCRIPT_SPAN_SEC);

    h.close();
  });

  it("keeps two recordings in one database apart", async () => {
    const h = harness();

    const first = await h.recording.start("mock");
    await wait(400);
    await h.recording.stop();

    const second = await h.recording.start("mock");
    await wait(400);
    await h.recording.stop();

    const texts = MOCK_SCRIPT.map((line) => line.text);
    expect(h.transcripts.listFinal(first).map((row) => row.text)).toEqual(texts);
    expect(h.transcripts.listFinal(second).map((row) => row.text)).toEqual(texts);
    expect(h.graphs.loadNodes(first)).toHaveLength(MOCK_SCRIPT.length);
    expect(h.graphs.loadNodes(second)).toHaveLength(MOCK_SCRIPT.length);
    h.close();
  });

  it("flushes the untriggered tail when the recording stops", async () => {
    // Neither trigger can fire: the script is shorter than `minSegments`, and the interval is
    // longer than the whole session. Without a flush on stop these lines would never be mapped.
    const h = harness({ minSegments: MOCK_SCRIPT.length + 1, maxIntervalMs: 60_000 });
    const sessionId = await h.recording.start("mock");
    await wait(400);

    expect(h.recording.current?.mindmap.pendingCount).toBe(MOCK_SCRIPT.length);
    expect(h.graphs.loadNodes(sessionId)).toHaveLength(0);

    await h.recording.stop();

    expect(h.graphs.loadNodes(sessionId)).toHaveLength(MOCK_SCRIPT.length);
    h.close();
  });

  /**
   * The other half of the tail: the request that is already *in flight* when the recording ends.
   * `stop()` marks the agent closed and a response landing after that is discarded, so the drain has
   * to wait for the chain instead of treating a busy agent as nothing to do. This is the ordinary
   * case — the recogniser closes the last sentences in milliseconds, the model takes seconds.
   */
  it("waits for the map request that is still in flight when the recording stops", async () => {
    const delegate = new MockLLMProvider();
    const batches: string[][] = [];
    const llm: LLMProvider = {
      name: "slow",
      generate: (request) => delegate.generate(request),
      stream: (request) => delegate.stream(request),
      structuredGenerate: async (request, schema) => {
        if (request.task !== "mindmap") return delegate.structuredGenerate(request, schema);
        batches.push(request.sourceSegmentIds ?? []);
        // Every answer takes longer than the rest of the stop sequence, so nothing lands by accident.
        await wait(120);
        return delegate.structuredGenerate(request, schema);
      },
    };

    const h = harness({ llm, minSegments: 2, maxIntervalMs: 60_000 });
    const finals: string[] = [];
    h.bus.on("ui", "transcript.final", (segment) => finals.push(segment.id));

    const sessionId = await h.recording.start("mock");
    for (let i = 0; i < 200 && finals.length < MOCK_SCRIPT.length; i++) await wait(5);

    expect(finals).toHaveLength(MOCK_SCRIPT.length);
    expect(h.recording.current?.mindmap.isBusy).toBe(true);

    await h.recording.stop();

    // Every final is requested exactly once, and every answer is applied before the session closes.
    expect(batches.flat().sort()).toEqual([...finals].sort());
    expect(h.graphs.loadNodes(sessionId)).toHaveLength(MOCK_SCRIPT.length);
    h.close();
  });
});
