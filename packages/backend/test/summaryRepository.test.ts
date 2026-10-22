import { describe, expect, it } from "vitest";
import type { SummaryBlock } from "@rcc/shared";
import { openSqlite } from "../src/store/sqlite.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { SqliteSummaryRepository } from "../src/store/summaryRepository.js";

/** §31: stage summaries are history. The store's job is to make "history" mean append-only. */

function block(overrides: Partial<SummaryBlock> = {}): SummaryBlock {
  return {
    id: "sb-1",
    sessionId: "s1",
    startTime: 0,
    endTime: 30,
    summary: "世界模型能预测下一个状态。",
    keyPoints: ["长期规划", "环境动态"],
    entities: ["世界模型"],
    level: 0,
    sourceBlockIds: [],
    ...overrides,
  };
}

function setup() {
  const store = openSqlite(":memory:");
  new SqliteSessionRepository(store.db).create({ id: "s1", startedAt: 1, status: "recording" });
  return { store, repo: new SqliteSummaryRepository(store.db) };
}

describe("summary repository", () => {
  it("round-trips a block including its lists", () => {
    const { store, repo } = setup();
    repo.append(block());
    expect(repo.list("s1")).toEqual([block()]);
    store.close();
  });

  it("keeps the first write when the same id arrives twice", () => {
    const { store, repo } = setup();
    repo.append(block({ summary: "第一次" }));
    repo.append(block({ summary: "第二次" }));
    expect(repo.count("s1")).toBe(1);
    expect(repo.list("s1")[0]?.summary).toBe("第一次");
    store.close();
  });

  it("orders by level and then by time, and filters by level", () => {
    const { store, repo } = setup();
    repo.append(block({ id: "b-late", startTime: 60, endTime: 90 }));
    repo.append(block({ id: "b-early", startTime: 0, endTime: 30 }));
    repo.append(block({ id: "b-top", level: 1, startTime: 0, endTime: 90, sourceBlockIds: ["b-early", "b-late"] }));
    expect(repo.list("s1").map((entry) => entry.id)).toEqual(["b-early", "b-late", "b-top"]);
    expect(repo.listLevel("s1", 1).map((entry) => entry.id)).toEqual(["b-top"]);
    store.close();
  });

  it("carries the lineage anchor forward", () => {
    const { store, repo } = setup();
    repo.append(block({ id: "b-top", level: 1, parentBlockId: "b-early", sourceBlockIds: ["b-early", "b-late"] }));
    expect(repo.list("s1")[0]).toMatchObject({ parentBlockId: "b-early", sourceBlockIds: ["b-early", "b-late"] });
    store.close();
  });

  it("reads a damaged list column as empty instead of throwing", () => {
    const { store, repo } = setup();
    store.db.prepare(`INSERT INTO summary_blocks (id, session_id, start_time, end_time, summary, key_points, entities, level, source_block_ids, created_at)
      VALUES ('x','s1',0,10,'文本','not json','[]',0,'broken',1)`).run();
    expect(repo.list("s1").map((entry) => entry.keyPoints)).toEqual([[]]);
    store.close();
  });
});
