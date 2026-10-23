import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/env.js";

describe("strict runtime configuration", () => {
  it("keeps offline defaults and explicitly accepted false values", () => {
    const config = parseConfig({ MOCK_STT: "false", MOCK_LLM: "on", MOCK_EMBEDDING: "off", PORT: "0", MOCK_STT_REPEAT: "0", QA_MIN_INTERVAL_MS: "0" });
    expect(config.mockStt).toBe(false);
    expect(config.mockLlm).toBe(true);
    expect(config.embedding.mock).toBe(false);
    expect(config.port).toBe(0);
    expect(config.mockSttRepeat).toBe(0);
    expect(config.qa.minIntervalMs).toBe(0);
  });
  it.each([
    ["MOCK_STT", "flase"], ["MOCK_EMBEDDING", "maybe"], ["PORT", "8787junk"],
    ["PORT", "65536"], ["PORT", "-1"], ["MOCK_STT_SPEED", "0"], ["EMBED_DIM", "1.5"],
    ["LLM_TIMEOUT_MS", "0"], ["SUMMARY_MERGE_FACTOR", "1"], ["RETRIEVAL_MIN_SCORE", "0.4junk"],
    ["RETRIEVAL_MIN_SCORE", "Infinity"], ["RETRIEVAL_MIN_SCORE", "1.1"], ["HOST", "0.0.0.0"],
    ["STT_SAMPLE_RATE", "8000"], ["STT_WS_URL", "ws://remote.invalid:6006"], ["LLM_BASE_URL", "file:///tmp/model"],
  ])("refuses invalid %s instead of silently coercing it", (name, value) => {
    expect(() => parseConfig({ [name]: value })).toThrow(name);
  });
  it("fails a requested real LLM without a key instead of switching the provider", () => {
    expect(() => parseConfig({ MOCK_LLM: "false" })).toThrow("LLM_API_KEY");
    expect(parseConfig({ MOCK_LLM: "false", LLM_API_KEY: "test-only-key" }).mockLlm).toBe(false);
  });
});
