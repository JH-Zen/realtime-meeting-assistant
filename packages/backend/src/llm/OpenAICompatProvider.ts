import OpenAI from "openai";
import type { z } from "zod";
import type { BackendConfig } from "../config/env.js";
import { LLMStructuredOutputError, type LLMProvider, type LLMRequest, type LLMResult, type Structured } from "./LLMProvider.js";

/**
 * OpenAI-compatible Chat Completions — the seam that makes DeepSeek, Qwen, GLM, Kimi and a local
 * server interchangeable by changing `LLM_BASE_URL` only. Adapter-owned: the SDK's message shapes
 * never leave this file.
 */
export class OpenAICompatProvider implements LLMProvider {
  readonly name = "openai-compatible";
  private readonly client: OpenAI;

  constructor(private readonly config: BackendConfig["llm"]) {
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey || "missing-key",
      timeout: config.timeoutMs,
      maxRetries: config.maxRetries,
    });
  }

  /**
   * Vendors in this dialect run reasoning models by default and charge the thinking against
   * `max_tokens`, which starves the answer. The knob and the numbers are in `env.ts`.
   */
  private thinkingToggle(): Record<string, unknown> {
    return this.config.disableThinking ? { enable_thinking: false } : {};
  }

  async generate(request: LLMRequest): Promise<LLMResult> {
    const started = Date.now();
    const completion = await this.client.chat.completions.create({
      model: this.config.model,
      messages: toMessages(request),
      temperature: request.temperature,
      max_tokens: request.maxOutputTokens,
      ...this.thinkingToggle(),
    });
    return {
      text: completion.choices[0]?.message.content ?? "",
      responseId: completion.id,
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  }

  async *stream(request: LLMRequest): AsyncIterable<string> {
    const chunks = await this.client.chat.completions.create({
      model: this.config.model,
      messages: toMessages(request),
      temperature: request.temperature,
      max_tokens: request.maxOutputTokens,
      stream: true,
      ...this.thinkingToggle(),
    });
    let text = "";
    for await (const chunk of chunks) {
      text += chunk.choices[0]?.delta.content ?? "";
      yield text;
    }
  }

  /**
   * Bounded repair loop (§45): ask again once with the validation error appended, then give up and
   * let the caller discard the batch. The SDK's transport retries are switched off for these calls
   * and a transport failure spends one of the attempts here, so **the whole method costs at most
   * `MAX_REPAIR_ATTEMPTS + 1` requests** — measured against the local stub
   * (`llmAdapterContract.test.ts`): leaving `maxRetries` at the default 2 made a flaky endpoint cost
   * 2 repair × 3 transport = 6 calls, each allowed to run to `LLM_TIMEOUT_MS`, while `MindMapAgent`
   * sat on its single-flight lock. Multiplying the two budgets is exactly the "AI 请求堆积" §56
   * forbids, and it is why repair is not simply `LLM_MAX_RETRIES` again.
   */
  async structuredGenerate<T>(request: LLMRequest, schema: z.ZodType<T>): Promise<Structured<T>> {
    const started = Date.now();
    const user = request.user;
    const attempts = MAX_REPAIR_ATTEMPTS + 1;
    let lastError = "";
    let lastRaw = "";
    let nextUser = user;
    let transportFailure: unknown = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let responseId = "";

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const completion = await this.client.chat.completions.create(
          {
            model: this.config.model,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: nextUser },
            ],
            temperature: request.temperature ?? 0.2,
            max_tokens: request.maxOutputTokens ?? 1200,
            response_format: { type: "json_object" },
            ...this.thinkingToggle(),
          },
          { maxRetries: 0 },
        );
        inputTokens += completion.usage?.prompt_tokens ?? 0;
        outputTokens += completion.usage?.completion_tokens ?? 0;
        responseId = completion.id;
        lastRaw = completion.choices[0]?.message.content ?? "";
        transportFailure = null;
      } catch (error) {
        // The model never answered, so there is nothing to repair: ask the same question again and
        // count the retry, rather than handing a transient 500 straight to the caller.
        transportFailure = error;
        nextUser = user;
        continue;
      }
      const parsed = schema.safeParse(readJson(lastRaw));
      if (parsed.success) {
        return { data: parsed.data, responseId, latencyMs: Date.now() - started, inputTokens, outputTokens };
      }
      lastError = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      nextUser = repairPrompt(user, lastError);
    }

    // A run that ended in transport failure says so — swallowing it into a schema message would make
    // the log claim the model answered badly when the endpoint never replied.
    if (transportFailure !== null) throw transportFailure;

    throw new LLMStructuredOutputError(
      `structured output failed after ${attempts} attempts: ${lastError}`,
      attempts,
      lastRaw,
    );
  }
}

const MAX_REPAIR_ATTEMPTS = 1;

function toMessages(request: LLMRequest): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [
    { role: "system", content: request.system },
    { role: "user", content: request.user },
  ];
}

function repairPrompt(user: string, error: string): string {
  return `${user}\n\n上一次输出未通过校验：${error}\n请严格按要求只输出 JSON 对象。`;
}

/** Models wrap JSON in prose or fences more often than is acceptable. */
function readJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return null;
      }
    }
    const brace = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    if (brace.length > 1) {
      try {
        return JSON.parse(brace);
      } catch {
        return null;
      }
    }
    return null;
  }
}
