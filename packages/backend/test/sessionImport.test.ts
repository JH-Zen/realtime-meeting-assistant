import { describe, expect, it } from "vitest";
import type { MindMapNode, SessionDocument, SummaryBlock, TranscriptSegment } from "@rcc/shared";
import { openSqlite, type Sqlite } from "../src/store/sqlite.js";
import { SqliteEmbeddingRepository } from "../src/store/embeddingRepository.js";
import { SqliteGraphRepository } from "../src/store/graphRepository.js";
import { SqliteQaRepository } from "../src/store/qaRepository.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { SqliteSummaryRepository } from "../src/store/summaryRepository.js";
import { SqliteTranscriptRepository } from "../src/store/transcriptRepository.js";
import { MockEmbeddingProvider } from "../src/retrieval/MockEmbeddingProvider.js";
import type { EmbeddingProvider } from "../src/retrieval/EmbeddingProvider.js";
import { exportSessionDocument } from "../src/session/sessionExport.js";
import { importQuestionId, importSessionDocument, type ImportRepositories } from "../src/session/sessionImport.js";

/**
 * The import half of the property the export test states: a file this backend writes must come back
 * as the same session under a new id, and be askable when it does. Written through the real
 * repositories, because the thing under test is how the schema's primary keys behave on a copy.
 */
function setup(): { repos: ImportRepositories; close: () => void } {
  const store: Sqlite = openSqlite(":memory:");
  const db = store.db;
  const repos: ImportRepositories = {
    sessions: new SqliteSessionRepository(db),
    transcripts: new SqliteTranscriptRepository(db),
    graphs: new SqliteGraphRepository(db),
    summaries: new SqliteSummaryRepository(db),
    qa: new SqliteQaRepository(db),
    embeddings: new SqliteEmbeddingRepository(db),
  };
  repos.sessions.create({ id: "s1", startedAt: 1000, status: "recording" });
  return { repos, close: () => store.close() };
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

/** One session with every table populated, exported as the file a user would hand over. */
function seedAndExport(repos: ImportRepositories): SessionDocument {
  repos.transcripts.appendFinal(segment("t-1", "世界模型预测下一个状态", 0));
  repos.transcripts.appendFinal(segment("t-2", "语言模型预测下一个词", 4));
  repos.graphs.upsertNode("s1", node("root", "世界模型"));
  repos.graphs.upsertNode("s1", node("child", "预测下一状态", "root"));
  repos.graphs.saveEdges("s1", [{ id: "e-1", source: "root", target: "child", relation: "包含" }]);
  repos.graphs.savePosition("s1", "child", 220, 60, true);
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
  const document = exportSessionDocument(repos, "s1", 9999);
  if (!document) throw new Error("the seed wrote no session the exporter could read");
  return document;
}

const provider = new MockEmbeddingProvider();
const failing: EmbeddingProvider = {
  name: "down",
  dim: 512,
  embed: async () => {
    throw new Error("provider unavailable");
  },
};

describe("importSessionDocument", () => {
  it("copies a session to a new id with its structure intact and only global ids rewritten", async () => {
    const { repos, close } = setup();
    const document = seedAndExport(repos);

    const outcome = await importSessionDocument(repos, document, provider, { sessionId: "s2", now: 7777 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.counts).toMatchObject({
      transcripts: 2,
      transcriptsSkipped: 0,
      nodes: 2,
      edges: 1,
      positions: 1,
      summaries: 1,
      questions: 1,
      answers: 1,
      embedded: 2,
    });

    // An imported session is over the moment it exists: never `recording`, and closed at import time
    // because the file's session had no end. `startedAt` must survive — every `startTime` is relative
    // to it, so a reset clock would slide the whole transcript to 00:00.
    const session = repos.sessions.get("s2");
    expect(session).toMatchObject({ id: "s2", startedAt: 1000, endedAt: 7777, status: "completed" });

    expect(repos.transcripts.listFinal("s2").map((entry) => [entry.id, entry.sessionId, entry.startTime])).toEqual([
      ["t-1", "s2", 0],
      ["t-2", "s2", 4],
    ]);
    // Parent links and evidence ids are copied verbatim, which is only safe because they are keyed by
    // `(session_id, id)` — no translation table, so nothing to get wrong.
    expect(repos.graphs.loadNodes("s2")).toEqual(document.nodes);
    expect(repos.graphs.loadEdges("s2")).toEqual(document.edges);
    expect(repos.graphs.loadPositions("s2")).toEqual({ child: { x: 220, y: 60, pinned: true } });
    expect(repos.summaries.list("s2")).toEqual(document.summaries.map((entry) => ({ ...entry, sessionId: "s2" })));

    const exchanges = repos.qa.listExchanges("s2");
    expect(exchanges).toHaveLength(1);
    const entry = exchanges[0];
    expect(entry?.question.id).toBe(importQuestionId("s2", "q-1"));
    expect(entry?.question.snapshotId).toBe("snap-1");
    // `answers.id == questions.id`, and the FK both rows satisfy is on the rewritten id.
    expect(entry?.answer?.questionId).toBe(entry?.question.id);
    expect(entry?.answer?.citations).toEqual([{ transcriptId: "t-1", startTime: 0 }]);

    // The index is rebuilt, or the copy is a session that cannot answer "what did he say ten minutes
    // ago" — the one thing Test D checks and the reason vectors are recomputed instead of skipped.
    expect(repos.embeddings.count("s2", "mock")).toBe(2);
    expect(repos.embeddings.listOwnerIds("s2", "transcript", "mock")).toEqual(new Set(["t-1", "t-2"]));

    // And the original is untouched: an import is a copy, never a move.
    expect(repos.transcripts.countFinal("s1")).toBe(2);
    expect(repos.sessions.get("s1")?.status).toBe("recording");
    expect(repos.qa.listExchanges("s1")[0]?.question.id).toBe("q-1");
    close();
  });

  it("refuses an incoherent document without writing any of it", async () => {
    const { repos, close } = setup();
    const document = seedAndExport(repos);
    // Point the root at a parent the file never mentions: shape-level zod accepts it, and the
    // coherence gate is what stops it from importing as a branch nobody can reach.
    const broken = {
      ...document,
      nodes: document.nodes.map((entry, index) => (index === 0 ? { ...entry, parentId: "ghost" } : entry)),
    };

    const outcome = await importSessionDocument(repos, broken, provider, { sessionId: "s2" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.join("\n")).toContain("ghost");
    expect(repos.sessions.get("s2")).toBeUndefined();
    expect(repos.transcripts.countFinal("s2")).toBe(0);
    close();
  });

  it("refuses a target id the store already has, instead of overwriting a live session", async () => {
    const { repos, close } = setup();
    const document = seedAndExport(repos);
    await importSessionDocument(repos, document, provider, { sessionId: "s2" });
    repos.transcripts.appendFinal({ ...segment("t-9", "另一段话", 60), sessionId: "s2" });

    const outcome = await importSessionDocument(repos, document, provider, { sessionId: "s2" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.join("\n")).toContain("已存在");
    // The rows written by the first import are still exactly what the first import left.
    expect(repos.transcripts.listFinal("s2").map((entry) => entry.id)).toEqual(["t-1", "t-2", "t-9"]);
    close();
  });

  it("drops a partial row instead of letting it roll the whole file back", async () => {
    const { repos, close } = setup();
    const document = seedAndExport(repos);
    const withPartial = {
      ...document,
      transcripts: [...document.transcripts, { ...segment("t-3", "未定稿", 8), type: "partial" }],
    };

    const outcome = await importSessionDocument(repos, withPartial, provider, { sessionId: "s2" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.counts).toMatchObject({ transcripts: 2, transcriptsSkipped: 1, embedded: 2 });
    expect(repos.transcripts.listFinal("s2").map((entry) => entry.id)).toEqual(["t-1", "t-2"]);
    close();
  });

  it("still delivers a readable session when the embedding provider is down", async () => {
    const { repos, close } = setup();
    const document = seedAndExport(repos);

    const outcome = await importSessionDocument(repos, document, failing, { sessionId: "s2" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.counts.embedded).toBe(0);
    expect(outcome.counts.embeddingError ?? "").toContain("provider unavailable");
    // The rows are committed, so the session opens and answers out of hot context and summaries.
    expect(repos.transcripts.countFinal("s2")).toBe(2);
    expect(repos.graphs.loadNodes("s2")).toHaveLength(2);
    expect(repos.embeddings.count("s2")).toBe(0);
    close();
  });
});
