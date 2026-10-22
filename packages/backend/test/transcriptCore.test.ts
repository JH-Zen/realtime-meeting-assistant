import { describe, expect, it } from "vitest";
import type { TranscriptStore } from "@rcc/shared";
import { openSqlite } from "../src/store/sqlite.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { SqliteTranscriptRepository } from "../src/store/transcriptRepository.js";
import { TranscriptCore } from "../src/transcript/TranscriptCore.js";
import { createBus } from "../src/bus/eventBus.js";
import { segment, tick } from "./helpers.js";

function setup() {
  const store = openSqlite(":memory:");
  const sessions = new SqliteSessionRepository(store.db);
  sessions.create({ id: "s1", startedAt: 1, status: "recording" });
  const repository = new SqliteTranscriptRepository(store.db);
  const bus = createBus();
  return { store, repository, bus, core: new TranscriptCore(bus, repository) };
}

describe("Transcript Core", () => {
  it("persists a final segment and publishes it", async () => {
    const { core, repository, bus } = setup();
    const published: string[] = [];
    bus.on("transcript", "transcript.final", (payload) => published.push(payload.id));

    core.acceptFinal(segment("f1", "今天讨论世界模型。", 0));
    await tick();

    expect(repository.listFinal("s1").map((row) => row.id)).toEqual(["f1"]);
    expect(published).toEqual(["f1"]);
  });

  it("never persists a partial, which is the rule the whole design leans on", async () => {
    const { core, repository, bus } = setup();
    const partials: string[] = [];
    const finals: string[] = [];
    bus.on("ui", "transcript.partial", (payload) => partials.push(payload.id));
    bus.on("ui", "transcript.final", (payload) => finals.push(payload.id));

    core.acceptPartial(segment("p1", "今天讨论世", 1, "partial"));
    await tick();

    expect(partials).toEqual(["p1"]);
    expect(finals).toEqual([]);
    expect(repository.listFinal("s1")).toEqual([]);
    expect(core.count()).toBe(0);
  });

  it("refuses to write a partial straight through the repository", () => {
    const { repository } = setup();
    expect(() => repository.appendFinal(segment("p1", "partial text", 0, "partial"))).toThrow(/refused/);
  });

  it("replaces a partial with its final and ignores a repeated final id", () => {
    const { core, repository } = setup();
    core.acceptPartial(segment("m0", "世界", 0, "partial"));
    core.acceptFinal(segment("m0", "世界模型。", 0));
    core.acceptFinal(segment("m0", "世界模型。", 0));

    expect(repository.listFinal("s1")).toHaveLength(1);
    expect(core.count()).toBe(1);
    expect(core.getPartial("m0")).toBeUndefined();
  });

  it("keeps the partial display buffer bounded", () => {
    const { core } = setup();
    for (let i = 0; i < 40; i++) core.acceptPartial(segment(`p${i}`, `第 ${i} 句`, i, "partial"));

    // A partial is only evicted by the final that supersedes it, and a socket that drops mid-utterance
    // never sends one — so the cap is what keeps a two-hour talk from accumulating orphans.
    expect(core.getPartial("p7")).toBeUndefined();
    expect(core.getPartial("p8")?.text).toBe("第 8 句");
    expect(core.getPartial("p39")?.text).toBe("第 39 句");
  });

  it("returns only the recent window of speech", () => {
    const { core } = setup();
    core.acceptFinal(segment("a", "第一句", 0));
    core.acceptFinal(segment("b", "第二句", 30));
    core.acceptFinal(segment("c", "第三句", 80));

    expect(core.window("s1", 60).map((row) => row.id)).toEqual(["b", "c"]);
    expect(core.window("s1", 10).map((row) => row.id)).toEqual(["c"]);
  });

  it("drops a segment that does not satisfy the canonical schema", () => {
    const { core, repository } = setup();
    core.acceptFinal({ ...segment("bad", "x", 0), text: undefined } as never);
    core.acceptFinal({ ...segment("bad2", "x", 0), sessionId: "" });
    expect(repository.listFinal("s1")).toEqual([]);
  });

  it("exposes durable history through the store, not the ring buffer", () => {
    const { core, repository } = setup();
    core.acceptFinal(segment("f1", "句子", 0));
    repository.appendFinal(segment("f2", "另一句", 5));
    expect(core.allFinals("s1").map((row) => row.id)).toEqual(["f1", "f2"]);
  });

  it("keeps a store failure inside the transcript module instead of throwing at the caller", async () => {
    const failing: TranscriptStore = {
      appendFinal: (row) => {
        if (row.id === "f2") throw new Error("disk I/O error");
      },
      listFinal: () => [],
      getFinal: () => undefined,
    };
    const bus = createBus();
    const core = new TranscriptCore(bus, failing);
    const published: string[] = [];
    const errors: { module: string; code: string }[] = [];
    bus.on("test", "transcript.final", (payload) => published.push(payload.id));
    bus.on("test", "module.error", (payload) => errors.push({ module: payload.module, code: payload.code }));

    // This call runs straight out of the STT socket callback, where nothing catches: throwing here is
    // an uncaught exception, which takes the whole backend down in the middle of a recording.
    expect(() => core.acceptFinal(segment("f1", "第一句", 0))).not.toThrow();
    expect(() => core.acceptFinal(segment("f2", "第二句", 1))).not.toThrow();
    await tick();

    expect(published).toEqual(["f1"]);
    expect(errors).toEqual([{ module: "transcript", code: "append_failed" }]);
    // A line that was never stored must not burn its id, or a redelivery would be swallowed as duplicate.
    expect(core.count()).toBe(1);
  });
});
