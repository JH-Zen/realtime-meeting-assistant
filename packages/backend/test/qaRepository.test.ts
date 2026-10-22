import { describe, expect, it } from "vitest";
import { openSqlite, type Sqlite } from "../src/store/sqlite.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { SqliteQaRepository } from "../src/store/qaRepository.js";

/**
 * §40 history: two rows per exchange, and the second one carries the citations that made the answer
 * checkable. These pin the two rules QaCore relies on — a re-asked id replaces nothing and adds
 * nothing, and `degraded` survives the round trip as the number the column stores.
 */

function repo(): { store: Sqlite; qa: SqliteQaRepository; close: () => void } {
  const store = openSqlite(":memory:");
  new SqliteSessionRepository(store.db).create({ id: "s1", startedAt: 1, status: "recording" });
  return { store, qa: new SqliteQaRepository(store.db), close: () => store.close() };
}

const question = (id: string) => ({
  id,
  sessionId: "s1",
  text: "世界模型是什么？",
  createdAt: 1000,
  snapshotId: `snap-${id}`,
});
const answer = (id: string, degraded = false) => ({
  questionId: id,
  sessionId: "s1",
  text: "世界模型能预测下一个状态 [00:10]。",
  citations: [{ transcriptId: "t-1", startTime: 10 }],
  durationMs: 250,
  degraded,
  createdAt: 1250,
});

describe("QA history repository", () => {
  it("writes the question and its answer as one joinable exchange", () => {
    const r = repo();
    r.qa.recordQuestion(question("q1"));
    r.qa.recordAnswer(answer("q1"));

    const row = r.store.db
      .prepare(
        `SELECT q.snapshot_id, q.created_at, a.text, a.citations, a.duration_ms, a.degraded
           FROM questions q JOIN answers a ON a.question_id = q.id WHERE q.id = 'q1'`,
      )
      .get() as unknown as {
      snapshot_id: string;
      created_at: number;
      text: string;
      citations: string;
      duration_ms: number;
      degraded: number;
    };
    expect(row.snapshot_id).toBe("snap-q1");
    expect(row.created_at).toBe(1000);
    expect(row.duration_ms).toBe(250);
    expect(row.degraded).toBe(0);
    expect(JSON.parse(row.citations)).toEqual([{ transcriptId: "t-1", startTime: 10 }]);
    r.close();
  });

  it("keeps one row per question when the same id is written again", () => {
    // A client that retries with the id it already used must not split its question across two answers,
    // and the first answer's text is the one the user watched stream in.
    const r = repo();
    r.qa.recordQuestion(question("q1"));
    r.qa.recordAnswer(answer("q1"));
    r.qa.recordQuestion(question("q1"));
    r.qa.recordAnswer(answer("q1", true));

    expect(r.store.db.prepare("SELECT COUNT(*) AS n FROM questions").get()).toEqual({ n: 1 });
    expect(r.store.db.prepare("SELECT COUNT(*) AS n FROM answers").get()).toEqual({ n: 1 });
    expect(r.store.db.prepare("SELECT degraded FROM answers").get()).toEqual({ degraded: 0 });
    r.close();
  });

  it("marks a degraded answer so history can say the answer was partial", () => {
    const r = repo();
    r.qa.recordQuestion(question("q2"));
    r.qa.recordAnswer(answer("q2", true));

    expect(r.store.db.prepare("SELECT degraded FROM answers WHERE question_id = 'q2'").get()).toEqual({
      degraded: 1,
    });
    r.close();
  });

  it("reads a session's exchanges back with citations as objects, oldest first", () => {
    const r = repo();
    r.qa.recordQuestion(question("q1"));
    r.qa.recordAnswer(answer("q1"));
    r.qa.recordQuestion({ ...question("q0"), createdAt: 500 });
    r.qa.recordAnswer({ ...answer("q0"), citations: [] });

    const exchanges = r.qa.listExchanges("s1");
    expect(exchanges.map((entry) => entry.question.id)).toEqual(["q0", "q1"]);
    expect(exchanges[1]).toEqual({
      question: question("q1"),
      answer: answer("q1"),
    });
    expect(exchanges[0]?.answer?.citations).toEqual([]);
    r.close();
  });

  it("keeps an admitted question that never got an answer instead of dropping it", () => {
    // The two rows are written at different moments, so a process that dies mid-answer leaves this
    // shape. An export that silently lost the question would lose what the user actually asked.
    const r = repo();
    r.qa.recordQuestion(question("q9"));

    expect(r.qa.listExchanges("s1")).toEqual([{ question: question("q9"), answer: null }]);
    r.close();
  });

  it("reads only the requested session", () => {
    const r = repo();
    r.qa.recordQuestion(question("q1"));
    new SqliteSessionRepository(r.store.db).create({ id: "s2", startedAt: 2, status: "recording" });
    r.qa.recordQuestion({ ...question("q2"), sessionId: "s2" });

    expect(r.qa.listExchanges("s2").map((entry) => entry.question.id)).toEqual(["q2"]);
    r.close();
  });
});
