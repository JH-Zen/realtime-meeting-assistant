import { describe, expect, it } from "vitest";
import { RecoveryTaskSchema } from "../src/recovery.js";

const oldTask = () => ({
  id: "task", sessionId: "session", kind: "retrieval", status: "running", startedAt: 100,
  finishedAt: null, initialMissing: 2, remaining: null, completedBatches: 0,
  failureCode: null, attempts: [],
});
const liveTask = () => ({ ...oldTask(), trigger: "live", sourceSegmentIds: ["source-1", "source-2"] });

describe("live task provenance contract", () => {
  it("reads old persisted jobs without fabricating source or trigger fields", () => {
    const value = RecoveryTaskSchema.parse(oldTask());
    expect(value).toEqual(oldTask());
    expect(value).not.toHaveProperty("trigger");
    expect(value).not.toHaveProperty("sourceSegmentIds");
  });
  it("accepts explicit manual provenance without forcing source identities", () => {
    const value = RecoveryTaskSchema.parse({ ...oldTask(), trigger: "manual" });
    expect(value.trigger).toBe("manual");
    expect(value).not.toHaveProperty("sourceSegmentIds");
  });
  it("preserves 512 unique source IDs including a valid long transcript ID", () => {
    const ids = Array.from({ length: 512 }, (_, i) => `source-${i}`);
    ids[0] = "源".repeat(1024);
    const value = RecoveryTaskSchema.parse({ ...liveTask(), initialMissing: 512, sourceSegmentIds: ids });
    expect(value.sourceSegmentIds).toEqual(ids);
    expect(value.sourceSegmentIds?.[0]).toHaveLength(1024);
  });
  it("rejects missing, empty, duplicate, mismatched and over-limit live identity lists", () => {
    for (const sourceSegmentIds of [undefined, null, [], [""], ["a", "a"], ["a"], Array.from({ length: 513 }, (_, i) => `id-${i}`)]) {
      expect(RecoveryTaskSchema.safeParse({ ...liveTask(), sourceSegmentIds }).success).toBe(false);
    }
  });
  it("rejects unknown provenance and strips content/error extensions", () => {
    expect(RecoveryTaskSchema.safeParse({ ...liveTask(), trigger: "imported" }).success).toBe(false);
    const value = RecoveryTaskSchema.parse({ ...liveTask(), prompt: "synthetic private prompt", rawError: "synthetic secret error", modelOutput: "synthetic model text" });
    expect(value).not.toHaveProperty("prompt");
    expect(value).not.toHaveProperty("rawError");
    expect(value).not.toHaveProperty("modelOutput");
    expect(value.sourceSegmentIds).toEqual(["source-1", "source-2"]);
  });
  it("keeps partial output distinct from completed work", () => {
    const value = RecoveryTaskSchema.parse({ ...liveTask(), status: "incomplete", finishedAt: 120, remaining: 1, failureCode: "incomplete_output",
      attempts: [{ batch: 1, attempt: 1, inputCount: 2, savedCount: 1, outcome: "incomplete", startedAt: 101, finishedAt: 119 }] });
    expect(value.status).toBe("incomplete");
    expect(value.completedBatches).toBe(0);
    expect(value.remaining).toBe(1);
  });
  it("accepts fixed live failure codes without storing raw provider errors", () => {
    for (const failureCode of ["backlog_full", "invalid_output", "partial_graph"]) {
      const value = RecoveryTaskSchema.parse({ ...liveTask(), status: "failed", finishedAt: 120, remaining: 2, failureCode });
      expect(value.failureCode).toBe(failureCode);
    }
    expect(RecoveryTaskSchema.safeParse({ ...liveTask(), failureCode: "raw arbitrary error" }).success).toBe(false);
  });
  it("still refuses false success and unfinished attempts in terminal live tasks", () => {
    expect(RecoveryTaskSchema.safeParse({ ...liveTask(), status: "succeeded", finishedAt: 120, remaining: 1 }).success).toBe(false);
    expect(RecoveryTaskSchema.safeParse({ ...liveTask(), status: "interrupted", finishedAt: 120,
      attempts: [{ batch: 1, attempt: 1, inputCount: 2, savedCount: 0, outcome: "running", startedAt: 101, finishedAt: null }] }).success).toBe(false);
  });
});
