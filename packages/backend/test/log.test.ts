import { describe, expect, it, vi } from "vitest";
import { log } from "../src/observability/log.js";

/**
 * The log line is the only durable trace of a fault in an installed app, and every grep in the soak and
 * packaging probes keys on `message`. That makes the field name itself part of the contract: a caller that
 * reports the error text as `{ message }` used to erase the label it was logged under, which is how
 * `embedding worker stopped` and `retrieval search failed` became the same ungroupable line.
 */

function capture(target: "stdout" | "stderr"): { lines: () => unknown[]; restore: () => void } {
  const stream = target === "stdout" ? process.stdout : process.stderr;
  const chunks: string[] = [];
  const spy = vi.spyOn(stream, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return {
    lines: () => chunks.map((chunk) => JSON.parse(chunk.trim())),
    restore: () => spy.mockRestore(),
  };
}

describe("structured log records", () => {
  it("keeps the record's own label when a field is also named message", () => {
    const out = capture("stdout");
    log.warn("embedding worker stopped", { provider: "onnx:Xenova/bge-m3:q8", message: "Cannot find package", permanent: false });
    out.restore();
    const [record] = out.lines() as Record<string, unknown>[];
    expect(record.message).toBe("embedding worker stopped");
    expect(record.detail).toBe("Cannot find package");
    expect(record.provider).toBe("onnx:Xenova/bge-m3:q8");
    expect(record.level).toBe("warn");
  });

  it("does not let a field overwrite the level or the timestamp", () => {
    const out = capture("stdout");
    log.info("metric:loop_delay", { level: "nonsense", ts: "yesterday", max: 12 });
    out.restore();
    const [record] = out.lines() as Record<string, unknown>[];
    expect(record.level).toBe("info");
    expect(String(record.ts)).toMatch(/^20\d\d-/);
    expect(record.detailLevel).toBe("nonsense");
    expect(record.detailTs).toBe("yesterday");
    expect(record.max).toBe(12);
  });

  it("sends errors to stderr and keeps ordinary fields untouched", () => {
    const out = capture("stderr");
    log.error("backend failed to start", { message: "boom", port: 8787 });
    out.restore();
    const records = out.lines() as Record<string, unknown>[];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: "error", message: "backend failed to start", detail: "boom", port: 8787 });
  });
});
