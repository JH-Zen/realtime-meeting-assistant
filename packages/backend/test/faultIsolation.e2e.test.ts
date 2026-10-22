import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "../src/llm/MockLLMProvider.js";
import type { LLMProvider } from "../src/llm/LLMProvider.js";
import type { EmbeddingProvider } from "../src/retrieval/EmbeddingProvider.js";
import { MOCK_SCRIPT } from "../src/testing/mockScript.js";
import { createHarness, wait } from "./pipelineHarness.js";
import type { AnswerCompleted, GraphOperation, ModuleError } from "@rcc/shared";

/**
 * §56 Test E: kill any AI module and the recording must not notice. The ADR states this as an
 * invariant, so it needs a test that *breaks* things rather than one that assumes the try/catch in
 * the source is enough — the interesting failure mode is a fault that reaches the audio path
 * sideways, through a shared listener or a hot retry loop.
 */

function throwingStream(): LLMProvider["stream"] {
  return () => {
    throw new Error("qa offline");
  };
}

/** MindMap and Memory keep working; only the streaming answer path is dead. */
function qaBroken(): LLMProvider {
  const inner = new MockLLMProvider();
  // Delegated method by method: spreading a class instance would copy only its fields and leave
  // `structuredGenerate` off the object, which is a different fault than the one being tested.
  return {
    name: "qa-broken",
    generate: (request) => inner.generate(request),
    structuredGenerate: (request, schema) => inner.structuredGenerate(request, schema),
    stream: throwingStream(),
  };
}

/** Everything the model is needed for fails, so one fault can be measured across all three modules. */
function allBroken(): LLMProvider {
  const fail = async (): Promise<never> => {
    throw new Error("model offline");
  };
  return {
    name: "all-broken",
    generate: fail,
    structuredGenerate: fail,
    stream: throwingStream(),
  };
}

function indexBroken(): EmbeddingProvider {
  return {
    name: "index-broken",
    dim: 512,
    embed: async () => {
      throw new Error("embedding model offline");
    },
  };
}

describe("fault isolation acceptance (Test E)", () => {
  it("answers nothing when only the QA path is down, and nothing else notices", async () => {
    const h = createHarness({ llm: qaBroken() });
    const finals: string[] = [];
    const batches: GraphOperation[][] = [];
    const answers: AnswerCompleted[] = [];
    const errors: ModuleError[] = [];
    h.bus.on("ui", "transcript.final", (segment) => finals.push(segment.id));
    h.bus.on("ui", "mindmap.updated", (payload) => batches.push(payload.operations));
    h.bus.on("ui", "answer.completed", (payload) => answers.push(payload));
    h.bus.onError((error) => errors.push(error));

    const sessionId = await h.recording.start("mock");
    await wait(400);
    const runtime = h.recording.current;
    if (!runtime) throw new Error("recording did not start");
    await runtime.qa.ask("q1", "世界模型为什么重要？");
    await h.recording.stop();

    // The question still closes its own loop — a degraded answer, not a bubble that never ends.
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ questionId: "q1", degraded: true });
    expect(errors.map((error) => error.module)).toEqual(["qa"]);
    expect(errors[0]).toMatchObject({ code: "answer_failed" });

    // Which is Test E's actual demand: the rest of the session is byte-for-byte what it would be.
    expect(finals).toHaveLength(MOCK_SCRIPT.length);
    expect(h.transcripts.listFinal(sessionId)).toHaveLength(MOCK_SCRIPT.length);
    expect(batches.length).toBeGreaterThan(0);
    expect(runtime.graph.snapshot().nodes.length).toBeGreaterThan(0);
    expect(runtime.memory.globalSummary()).not.toBe("");

    h.close();
  });

  it("answers out of Hot Context when the index is dead, and reports it instead of hushing it", async () => {
    const h = createHarness({ embedding: indexBroken() });
    const answers: AnswerCompleted[] = [];
    const errors: ModuleError[] = [];
    const batches: number[] = [];
    h.bus.on("ui", "answer.completed", (payload) => answers.push(payload));
    h.bus.onError((error) => errors.push(error));
    h.bus.on("ui", "mindmap.updated", (payload) => batches.push(payload.operations.length));

    const sessionId = await h.recording.start("mock");
    await wait(400);
    const runtime = h.recording.current;
    if (!runtime) throw new Error("recording did not start");
    await runtime.retrieval.flushPending();
    await runtime.qa.ask("q1", "世界模型为什么重要？");
    await h.recording.stop();

    expect(runtime.retrieval.indexedCount).toBe(0);
    // A dead index is an enhancement lost, not an answer lost: `degraded` is reserved for the model.
    expect(answers).toHaveLength(1);
    expect(answers[0]?.degraded).toBe(false);
    expect(answers[0]?.text.length).toBeGreaterThan(0);

    const retrievalErrors = errors.filter((error) => error.module === "retrieval");
    // Two distinct failures, both reported and neither fatal: the index cannot be written, and the
    // question cannot be embedded. Silently returning an empty hit list would have hidden both.
    expect(new Set(retrievalErrors.map((error) => error.code))).toEqual(new Set(["embed_failed", "search_failed"]));
    expect(errors.filter((error) => error.module !== "retrieval")).toEqual([]);
    expect(h.transcripts.listFinal(sessionId)).toHaveLength(MOCK_SCRIPT.length);
    expect(batches.length).toBeGreaterThan(0);

    h.close();
  });

  it("cannot let a broken listener reach the audio path", async () => {
    const h = createHarness();
    const batches: number[] = [];
    const errors: ModuleError[] = [];
    // A listener that explodes on every final, next door to the ones the pipeline depends on.
    h.bus.on("ui", "transcript.final", () => {
      throw new Error("listener exploded");
    });
    h.bus.on("ui", "mindmap.updated", (payload) => batches.push(payload.operations.length));
    h.bus.onError((error) => errors.push(error));

    const sessionId = await h.recording.start("mock");
    await wait(400);
    await h.recording.stop();

    expect(h.transcripts.listFinal(sessionId)).toHaveLength(MOCK_SCRIPT.length);
    expect(batches.length).toBeGreaterThan(0);
    // One report per failing event — bounded, and attributable to the listener, not to the bus.
    const failures = errors.filter((error) => error.code === "handler_failed");
    expect(failures).toHaveLength(MOCK_SCRIPT.length);
    expect(new Set(failures.map((error) => error.module))).toEqual(new Set(["ui"]));
    expect(h.recording.current).toBeNull();

    h.close();
  });

  it("keeps a session-long fault storm bounded and silent after stop", async () => {
    let mindmapCalls = 0;
    const broken = allBroken();
    const counting: LLMProvider = {
      ...broken,
      structuredGenerate: (request, schema) => {
        // Memory asks the same provider for stage summaries; only the map's calls have a trigger event
        // to be compared against.
        if (request.task === "mindmap") mindmapCalls += 1;
        return broken.structuredGenerate(request, schema);
      },
    };
    const h = createHarness({ llm: counting, minSegments: 1 });
    const errors: ModuleError[] = [];
    h.bus.onError((error) => errors.push(error));

    const sessionId = await h.recording.start("mock");
    await wait(400);
    const requested = h.bus.snapshot().events["mindmap.update.requested"] ?? 0;
    await h.recording.stop();

    // Subtitles and persistence are the point of the test, and they never depended on the model.
    expect(h.transcripts.listFinal(sessionId)).toHaveLength(MOCK_SCRIPT.length);

    // The retry discipline: one call per trigger, no hot loop out of the failure path itself. Without
    // the buffer swap in `runFlush` this is where a broken model would spin the process.
    expect(mindmapCalls).toBe(requested);
    expect(requested).toBeGreaterThan(0);
    // Only the model-dependent modules report; nothing comes from stt, transcript, graph or bus.
    expect(new Set(errors.map((error) => error.module))).toEqual(new Set(["mindmap", "memory"]));

    const settled = { ...h.bus.snapshot().events };
    await wait(400);
    expect(h.bus.snapshot().events).toEqual(settled);
    expect(h.recording.current).toBeNull();

    h.close();
  });
});
