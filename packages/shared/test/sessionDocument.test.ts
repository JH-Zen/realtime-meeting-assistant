import { describe, expect, it } from "vitest";
import {
  SESSION_DOCUMENT_SCHEMA_VERSION,
  parseSessionDocument,
  type SessionDocument,
} from "../src/index.js";

/** A document small enough to read and complete enough to be the baseline every test mutates. */
function document(overrides: Partial<SessionDocument> = {}): Record<string, unknown> {
  return {
    schemaVersion: SESSION_DOCUMENT_SCHEMA_VERSION,
    exportedAt: 2000,
    session: { id: "s1", startedAt: 1000, endedAt: 2000, status: "completed" },
    transcripts: [
      { id: "t-1", sessionId: "s1", text: "世界模型预测下一个状态", startTime: 0, endTime: 3, type: "final", createdAt: 1000 },
      { id: "t-2", sessionId: "s1", text: "语言模型预测下一个词", startTime: 4, endTime: 7, type: "final", createdAt: 1004 },
    ],
    nodes: [
      { id: "root", title: "世界模型", summary: "对三维世界的内部表征", sourceTranscriptIds: ["t-1"], createdAt: 1, updatedAt: 1 },
      { id: "child", title: "预测下一状态", parentId: "root", sourceTranscriptIds: ["t-1"], createdAt: 2, updatedAt: 2 },
    ],
    edges: [{ id: "e-1", source: "root", target: "child", relation: "包含" }],
    positions: { root: { x: 10, y: 20 } },
    summaries: [
      {
        id: "b-1",
        sessionId: "s1",
        startTime: 0,
        endTime: 7,
        summary: "两种模型的预测对象不同",
        keyPoints: ["下一状态", "下一词"],
        entities: ["世界模型"],
        level: 0,
        sourceBlockIds: [],
      },
    ],
    exchanges: [
      {
        question: { id: "q-1", text: "它们区别在哪？", createdAt: 1500, snapshotId: "snap-1" },
        answer: {
          questionId: "q-1",
          text: "世界模型预测下一状态 [00:00]。",
          citations: [{ transcriptId: "t-1", startTime: 0 }],
          durationMs: 300,
          degraded: false,
          createdAt: 1800,
        },
      },
    ],
    ...overrides,
  };
}

const ok = (raw: unknown): SessionDocument => {
  const result = parseSessionDocument(raw);
  if (!result.document || result.issues.length > 0) throw new Error(result.issues.join("; "));
  return result.document;
};

describe("parseSessionDocument", () => {
  it("accepts a complete document and fills the collections a session may genuinely not have", () => {
    const bare = document();
    delete (bare as { edges?: unknown }).edges;
    delete (bare as { positions?: unknown }).positions;
    delete (bare as { summaries?: unknown }).summaries;
    delete (bare as { exchanges?: unknown }).exchanges;

    const parsed = ok(bare);
    expect(parsed.edges).toEqual([]);
    expect(parsed.positions).toEqual({});
    expect(parsed.summaries).toEqual([]);
    expect(parsed.exchanges).toEqual([]);
  });

  it("refuses a document from a schema it cannot map, rather than importing half of it", () => {
    // `schemaVersion` is the only thing standing between a future format change and a silent partial
    // read of a file whose fields now mean something else.
    const result = parseSessionDocument(document({ schemaVersion: 999 as unknown as 1 }));
    expect(result.document).toBeUndefined();
    expect(result.issues.join(" ")).toContain("schemaVersion");
  });

  it("names a node whose parent the document does not contain", () => {
    // Not an error at write time — the row lands and the branch simply never appears.
    const result = parseSessionDocument(
      document({
        nodes: [
          { id: "a", title: "甲", sourceTranscriptIds: [], createdAt: 1, updatedAt: 1 },
          { id: "b", title: "乙", parentId: "missing", sourceTranscriptIds: [], createdAt: 2, updatedAt: 2 },
        ],
        edges: [],
      }),
    );
    expect(result.issues.join(" ")).toContain('parentId "missing"');
  });

  it("catches a parent cycle instead of importing a subtree nothing can reach", () => {
    const cyclic = document({
      nodes: [
        { id: "a", title: "甲", parentId: "b", sourceTranscriptIds: [], createdAt: 1, updatedAt: 1 },
        { id: "b", title: "乙", parentId: "a", sourceTranscriptIds: [], createdAt: 2, updatedAt: 2 },
      ],
      edges: [],
    });
    const issues = parseSessionDocument(cyclic).issues;
    expect(issues.some((issue) => issue.includes("loops back"))).toBe(true);
  });

  it("rejects an edge that points outside the document and a duplicated id", () => {
    const bad = document({ edges: [{ id: "e-1", source: "root", target: "ghost" }] });
    expect(parseSessionDocument(bad).issues.join(" ")).toContain("edge \"e-1\"");

    const duplicated = document({
      nodes: [
        { id: "root", title: "世界模型", sourceTranscriptIds: [], createdAt: 1, updatedAt: 1 },
        { id: "root", title: "重名", sourceTranscriptIds: [], createdAt: 2, updatedAt: 2 },
      ],
      edges: [],
    });
    expect(parseSessionDocument(duplicated).issues.join(" ")).toContain('nodes: duplicate id "root"');
  });

  it("keeps the answers.id == questions.id invariant the store writes under", () => {
    const mismatched = document({
      exchanges: [
        {
          question: { id: "q-1", text: "问", createdAt: 1500, snapshotId: "" },
          answer: {
            questionId: "q-other",
            text: "答",
            citations: [],
            durationMs: 10,
            degraded: false,
            createdAt: 1600,
          },
        },
      ],
    });
    expect(parseSessionDocument(mismatched).issues.join(" ")).toContain("answers.id == questions.id");
  });

  it("refuses rows that belong to a different session than the one being exported", () => {
    const foreign = document({
      transcripts: [
        { id: "t-9", sessionId: "other", text: "别场的话", startTime: 0, type: "final", createdAt: 1 },
      ],
      nodes: [{ id: "root", title: "世界模型", sourceTranscriptIds: ["t-9"], createdAt: 1, updatedAt: 1 }],
      edges: [],
    });
    expect(parseSessionDocument(foreign).issues.join(" ")).toContain("other than \"s1\"");
  });

  it("lets a question stand without an answer, because that is a real state of the store", () => {
    const unanswered = document({ exchanges: [{ question: { id: "q-1", text: "问", createdAt: 1, snapshotId: "" }, answer: null }] });
    expect(ok(unanswered).exchanges[0]?.answer).toBeNull();
  });
});
