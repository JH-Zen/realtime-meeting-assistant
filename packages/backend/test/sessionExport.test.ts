import { describe, expect, it } from "vitest";
import { parseSessionDocument } from "@rcc/shared";
import type { MindMapNode, SummaryBlock, TranscriptSegment } from "@rcc/shared";
import { openSqlite, type Sqlite } from "../src/store/sqlite.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { SqliteGraphRepository } from "../src/store/graphRepository.js";
import { SqliteSummaryRepository } from "../src/store/summaryRepository.js";
import { SqliteTranscriptRepository } from "../src/store/transcriptRepository.js";
import { SqliteQaRepository } from "../src/store/qaRepository.js";
import { exportSessionDocument, sessionFileName } from "../src/session/sessionExport.js";

/**
 * The one property that makes an export worth having: whatever this assembles must be something the
 * importer accepts. Every field is written through the real repositories so the test reads the same
 * rows a finished recording leaves behind.
 */
function setup(): { store: Sqlite; repos: ReturnType<typeof repositories>; close: () => void } {
  const store = openSqlite(":memory:");
  const repos = repositories(store);
  return { store, repos, close: () => store.close() };
}

function repositories(store: Sqlite) {
  const db = store.db;
  new SqliteSessionRepository(db).create({ id: "s1", startedAt: 1000, status: "recording" });
  return {
    sessions: new SqliteSessionRepository(db),
    transcripts: new SqliteTranscriptRepository(db),
    graphs: new SqliteGraphRepository(db),
    summaries: new SqliteSummaryRepository(db),
    qa: new SqliteQaRepository(db),
  };
}

const segment = (id: string, text: string, startTime: number): TranscriptSegment => ({
  id,
  sessionId: "s1",
  text,
  startTime,
  endTime: startTime + 2,
  type: "final",
  createdAt: 1000 + startTime * 1000,
});

const node = (id: string, title: string, parentId?: string): MindMapNode => ({
  id,
  title,
  summary: `${title}的摘要`,
  ...(parentId ? { parentId } : {}),
  sourceTranscriptIds: ["t-1"],
  createdAt: 1,
  updatedAt: 2,
});

const block = (id: string): SummaryBlock => ({
  id,
  sessionId: "s1",
  startTime: 0,
  endTime: 4,
  summary: "开场介绍了世界模型",
  keyPoints: ["世界模型"],
  entities: ["LLM"],
  level: 0,
  sourceBlockIds: [],
});

describe("exportSessionDocument", () => {
  it("produces a document the importer accepts, carrying every part of the session", () => {
    const { repos, close } = setup();
    repos.transcripts.appendFinal(segment("t-1", "世界模型预测下一个状态", 0));
    repos.transcripts.appendFinal(segment("t-2", "语言模型预测下一个词", 4));
    repos.graphs.upsertNode("s1", node("root", "世界模型"));
    repos.graphs.upsertNode("s1", node("child", "预测下一状态", "root"));
    repos.graphs.saveEdges("s1", [{ id: "e-1", source: "root", target: "child", relation: "包含" }]);
    repos.summaries.append(block("b-1"));
    repos.qa.recordQuestion({ id: "q-1", sessionId: "s1", text: "区别是什么？", createdAt: 5000, snapshotId: "snap-1" });
    repos.qa.recordAnswer({
      questionId: "q-1",
      sessionId: "s1",
      text: "预测对象不同 [00:00]。",
      citations: [{ transcriptId: "t-1", startTime: 0 }],
      durationMs: 300,
      degraded: false,
      createdAt: 5300,
    });

    const doc = exportSessionDocument(repos, "s1", 9999);
    expect(doc).toBeDefined();
    const parsed = parseSessionDocument(doc);
    expect(parsed.issues).toEqual([]);
    expect(parsed.document?.transcripts.map((entry) => entry.id)).toEqual(["t-1", "t-2"]);
    expect(parsed.document?.nodes.map((entry) => entry.id)).toEqual(["root", "child"]);
    expect(parsed.document?.summaries.map((entry) => entry.id)).toEqual(["b-1"]);
    expect(parsed.document?.exchanges[0]?.answer?.citations).toEqual([{ transcriptId: "t-1", startTime: 0 }]);
    expect(parsed.document?.session.status).toBe("recording");
    expect(parsed.document?.exportedAt).toBe(9999);
    close();
  });

  it("writes only dragged positions, because a derived coordinate is not state", () => {
    const { repos, close } = setup();
    repos.graphs.upsertNode("s1", node("a", "甲"));
    repos.graphs.upsertNode("s1", node("b", "乙"));
    repos.graphs.savePosition("s1", "a", 120, 40, true);
    repos.graphs.savePosition("s1", "b", 300, 90, false);

    const doc = exportSessionDocument(repos, "s1");
    expect(doc?.positions).toEqual({ a: { x: 120, y: 40 } });
    close();
  });

  it("says there is nothing to export for a session id the store has never seen", () => {
    const { repos, close } = setup();
    expect(exportSessionDocument(repos, "nope")).toBeUndefined();
    close();
  });

  it("names the file by session id so two exports of one recording do not overwrite each other", () => {
    expect(sessionFileName("abc")).toBe("session-abc.json");
  });
});
