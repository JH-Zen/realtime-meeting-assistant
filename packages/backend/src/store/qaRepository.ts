import type { DatabaseSync } from "node:sqlite";
import type { Citation } from "../qa/citations.js";

/**
 * The QA history tables (§40) are the record of what was asked and what was answered from which
 * context. `questions` is written when the answer is admitted (a refused question never gets here, so
 * admission control keeps costing nothing), and `snapshot_id` on that row is what makes an old answer
 * auditable later: it says which frozen context produced it.
 */

export interface QuestionRecord {
  id: string;
  sessionId: string;
  text: string;
  createdAt: number;
  snapshotId: string;
}

export interface AnswerRecord {
  /** Doubles as `answers.id`: one question gets one recorded answer. */
  questionId: string;
  sessionId: string;
  text: string;
  citations: Citation[];
  durationMs: number;
  degraded: boolean;
  createdAt: number;
}

export interface QaRecorder {
  recordQuestion(question: QuestionRecord): void;
  recordAnswer(answer: AnswerRecord): void;
}

/** One question with whatever answer it produced. */
export interface QaExchange {
  question: QuestionRecord;
  /**
   * `null` when the question was admitted but no answer was recorded — the two rows are written at
   * different moments (admission vs completion), so a process that dies mid-answer leaves exactly
   * this shape behind.
   */
  answer: AnswerRecord | null;
}

interface ExchangeRow {
  id: string;
  session_id: string;
  text: string;
  created_at: number;
  snapshot_id: string | null;
  answer_text: string | null;
  citations: string | null;
  duration_ms: number | null;
  degraded: number | null;
  answer_created_at: number | null;
}

export class SqliteQaRepository implements QaRecorder {
  constructor(private readonly db: DatabaseSync) {}

  recordQuestion(question: QuestionRecord): void {
    this.db
      .prepare(
        `INSERT INTO questions (id, session_id, text, created_at, snapshot_id)
         VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(question.id, question.sessionId, question.text, question.createdAt, question.snapshotId);
  }

  /** One answer per question: a client that re-asks with the same id is answered again, recorded once. */
  recordAnswer(answer: AnswerRecord): void {
    this.db
      .prepare(
        `INSERT INTO answers (id, question_id, session_id, text, citations, duration_ms, degraded, created_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        answer.questionId,
        answer.questionId,
        answer.sessionId,
        answer.text,
        JSON.stringify(answer.citations),
        answer.durationMs,
        answer.degraded ? 1 : 0,
        answer.createdAt,
      );
  }

  /**
   * Read side for export (§13 OPEN-10). Questions drive the join so an admitted question that never
   * got an answer still appears — a session export that silently drops the things the user asked is
   * worse than one that shows an unanswered question.
   */
  listExchanges(sessionId: string): QaExchange[] {
    const rows = this.db
      .prepare(
        `SELECT q.id, q.session_id, q.text, q.created_at, q.snapshot_id,
                a.text AS answer_text, a.citations, a.duration_ms, a.degraded,
                a.created_at AS answer_created_at
         FROM questions q
         LEFT JOIN answers a ON a.question_id = q.id
         WHERE q.session_id = ?
         ORDER BY q.created_at ASC`,
      )
      .all(sessionId) as unknown as ExchangeRow[];

    return rows.map((row) => ({
      question: {
        id: row.id,
        sessionId: row.session_id,
        text: row.text,
        createdAt: row.created_at,
        snapshotId: row.snapshot_id ?? "",
      },
      ...(row.answer_text === null
        ? { answer: null }
        : {
            answer: {
              questionId: row.id,
              sessionId: row.session_id,
              text: row.answer_text,
              citations: parseCitations(row.citations ?? "[]"),
              durationMs: row.duration_ms ?? 0,
              degraded: row.degraded === 1,
              createdAt: row.answer_created_at ?? row.created_at,
            },
          }),
    }));
  }
}

function parseCitations(raw: string): Citation[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is Citation =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Citation).transcriptId === "string" &&
        typeof (entry as Citation).startTime === "number",
    );
  } catch {
    return [];
  }
}
