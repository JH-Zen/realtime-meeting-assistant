import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { BackendConfig } from "../src/config/env.js";
import { LLMStructuredOutputError, type LLMRequest } from "../src/llm/LLMProvider.js";
import { OpenAICompatProvider } from "../src/llm/OpenAICompatProvider.js";
import { startLlmStub, type LlmStub, type StubReply } from "./llmStubServer.js";

/**
 * The adapter is the only place the OpenAI wire dialect is spoken, and R2 (model output legality)
 * is the load-bearing risk of the whole MindMap path. These tests hold it to the real wire —
 * chunked SSE, HTTP status codes, SDK retries — against a local endpoint, so no API key is needed.
 */

const OperationsSchema = z.object({
  operations: z.array(
    z.object({
      type: z.literal("add_node"),
      node: z.object({ id: z.string().min(1), title: z.string().min(1) }),
    }),
  ),
});

const VALID = '{"operations":[{"type":"add_node","node":{"id":"a","title":"世界模型"}}]}';
const INVALID = '{"operations":[{"type":"add_node","node":{"id":"a"}}]}';

const request: LLMRequest = {
  task: "mindmap",
  system: "只输出 JSON 对象。",
  user: "已存在节点：无\n转录：\n[00:00] 今天讨论世界模型。",
  sourceSegmentIds: ["s-1"],
};

let stub: LlmStub | null = null;

async function providerFor(replies: StubReply[], overrides: Partial<BackendConfig["llm"]> = {}) {
  stub = await startLlmStub(replies);
  const config: BackendConfig["llm"] = {
    baseUrl: stub.baseUrl,
    apiKey: "test-key",
    model: "stub-model",
    timeoutMs: 5000,
    maxRetries: 2,
    disableThinking: true,
    ...overrides,
  };
  return new OpenAICompatProvider(config);
}

afterEach(async () => {
  await stub?.close();
  stub = null;
});

describe("OpenAICompatProvider", () => {
  it("returns validated data with the token accounting the caller bills", async () => {
    const provider = await providerFor([{ content: VALID, promptTokens: 312, completionTokens: 96 }]);

    const result = await provider.structuredGenerate(request, OperationsSchema);

    expect(result.data.operations).toEqual([{ type: "add_node", node: { id: "a", title: "世界模型" } }]);
    expect(result.inputTokens).toBe(312);
    expect(result.outputTokens).toBe(96);
    expect(result.responseId).toMatch(/^stub/);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const sent = stub?.requests[0]?.body;
    expect(sent?.response_format).toEqual({ type: "json_object" });
    expect(sent?.messages.map((message) => message.role)).toEqual(["system", "user"]);
  });

  it("asks the endpoint to stop thinking, because reasoning tokens starve the answer", async () => {
    // Measured on a live endpoint (2026-10-21): at the adapter's own 1200-token budget,
    // deepseek-v4.1-flash and kimi-k3 returned an empty `content` and glm-5.3 returned two characters
    // — the thinking consumed the whole budget — so every structured batch died in the repair loop.
    const provider = await providerFor([{ content: VALID }]);
    await provider.structuredGenerate(request, OperationsSchema);

    expect(stub?.requests[0]?.body.enable_thinking).toBe(false);
  });

  it("leaves the thinking parameter alone when the vendor rejects it", async () => {
    // glm-5.3 answers `400 The value of the enable_thinking parameter is restricted to True`, so the
    // knob has to be able to send nothing at all rather than a value the endpoint refuses.
    const provider = await providerFor([{ content: VALID }], { disableThinking: false });
    await provider.structuredGenerate(request, OperationsSchema);

    expect("enable_thinking" in (stub?.requests[0]?.body ?? {})).toBe(false);
  });

  it("recovers JSON the model wrapped in prose or code fences", async () => {
    const provider = await providerFor([{ content: `好的，结果如下：\n\`\`\`json\n${VALID}\n\`\`\`` }]);

    const result = await provider.structuredGenerate(request, OperationsSchema);

    expect(result.data.operations[0]?.node.title).toBe("世界模型");
    expect(stub?.requests).toHaveLength(1);
  });

  it("repairs once by appending the validation error to the same user prompt", async () => {
    const provider = await providerFor([{ content: INVALID }, { content: VALID }]);

    const result = await provider.structuredGenerate(request, OperationsSchema);

    const requests = stub?.requests ?? [];
    expect(requests).toHaveLength(2);
    const retry = requests[1]?.body.messages[1]?.content ?? "";
    expect(retry).toContain(request.user);
    expect(retry).toContain("上一次输出未通过校验");
    expect(retry).toContain("operations.0.node.title");
    // The first attempt is the untouched prompt, so a well-behaved model is never charged for repair.
    expect(requests[0]?.body.messages[1]?.content).toBe(request.user);
    expect(result.inputTokens).toBeGreaterThan(0);
  });

  it("keeps SDK transport retries from multiplying with the repair budget", async () => {
    // The stub answers 500, 500, then invalid JSON — twice over, so each repair attempt has to walk
    // the SDK's whole retry chain. With the default `LLM_MAX_RETRIES=2` that is
    // (MAX_REPAIR_ATTEMPTS + 1) x (maxRetries + 1) = 6 requests, each allowed to run to
    // `LLM_TIMEOUT_MS`, while `MindMapAgent` holds its single-flight lock: the pile-up §56 forbids.
    const provider = await providerFor([
      { status: 500 },
      { status: 500 },
      { content: INVALID },
      { status: 500 },
      { status: 500 },
      { content: INVALID },
    ]);

    const failure = await provider.structuredGenerate(request, OperationsSchema).catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(LLMStructuredOutputError);
    const requests = stub?.requests ?? [];
    expect(requests).toHaveLength(2);
    // Neither request got an answer, so there was nothing to repair: the retry asks the same question
    // rather than appending a validation error the model never produced.
    expect(requests[1]?.body.messages[1]?.content).toBe(request.user);
  });

  it("gives up with the raw payload instead of looping forever", async () => {
    const provider = await providerFor([{ content: INVALID }], { maxRetries: 1 });

    const failure = await provider.structuredGenerate(request, OperationsSchema).catch((error) => error);

    expect(failure).toBeInstanceOf(LLMStructuredOutputError);
    expect((failure as LLMStructuredOutputError).attempts).toBe(2);
    expect((failure as LLMStructuredOutputError).raw).toBe(INVALID);
    expect(stub?.requests).toHaveLength(2);
  });

  it("yields cumulative text so a dropped chunk cannot leave half a sentence", async () => {
    const provider = await providerFor([{ deltas: ["世界模型", "预测", "下一个状态"] }]);

    const seen: string[] = [];
    for await (const text of provider.stream(request)) seen.push(text);

    expect(seen).toEqual(["世界模型", "世界模型预测", "世界模型预测下一个状态"]);
    expect(stub?.requests[0]?.body.stream).toBe(true);
  });

  it("absorbs a transient server error inside the SDK's bounded retries", async () => {
    const provider = await providerFor([{ status: 500 }, { content: VALID }], { maxRetries: 1 });

    const result = await provider.generate(request);

    expect(result.text).toBe(VALID);
    expect(stub?.requests).toHaveLength(2);
  });

  it("fails forward when the endpoint stays down, without retrying forever", async () => {
    const provider = await providerFor([{ status: 500 }], { maxRetries: 2 });

    await expect(provider.generate(request)).rejects.toThrow();

    // maxRetries 2 = at most 3 attempts, so a dead endpoint costs a bounded number of calls.
    expect(stub?.requests.length).toBeLessThanOrEqual(3);
    expect(stub?.requests.length).toBeGreaterThan(1);
  });

  it("sends the configured model and honours the caller's token ceiling", async () => {
    const provider = await providerFor([{ content: VALID }]);

    await provider.generate({ ...request, maxOutputTokens: 64, temperature: 0 });

    const sent = stub?.requests[0]?.body;
    expect(sent?.model).toBe("stub-model");
  });
});
