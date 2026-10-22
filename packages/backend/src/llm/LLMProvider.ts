import type { z } from "zod";

/**
 * LLM seam (design doc §34). One formal provider plus the mock; the interface is OpenAI-compatible
 * because that is the dialect DeepSeek, Qwen, GLM, Kimi and local servers all speak.
 */

export type LLMTask = "mindmap" | "qa" | "summary";

export interface LLMRequest {
  task: LLMTask;
  system: string;
  user: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Ids this request was built from; drives citations, metrics and Mock Mode behaviour. */
  sourceSegmentIds?: string[];
}

export interface LLMResult {
  text: string;
  responseId: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface LLMProvider {
  readonly name: string;
  generate(request: LLMRequest): Promise<LLMResult>;
  /** Yields cumulative text so a dropped chunk cannot leave the UI with a half sentence. */
  stream(request: LLMRequest): AsyncIterable<string>;
  /**
   * Parses and validates model JSON. Implementation must bound its repair retries (§45) and throw
   * `LLMStructuredOutputError` when the model cannot produce valid output — the caller then
   * discards the batch, never the application.
   */
  structuredGenerate<T>(request: LLMRequest, schema: z.ZodType<T>): Promise<Structured<T>>;
}

export interface Structured<T> {
  data: T;
  responseId: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export class LLMStructuredOutputError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly raw?: string,
  ) {
    super(message);
    this.name = "LLMStructuredOutputError";
  }
}
