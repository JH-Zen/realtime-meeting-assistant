import type { DatabaseSync } from "node:sqlite";
import type { TranscriptSegment, TranscriptStore } from "@rcc/shared";

/**
 * Persistence gate for the Single Source of Truth. Only `final` segments may ever be written;
 * a partial reaching this layer is a bug in the caller, so it throws rather than silently
 * storing noise the MindMap would then learn from.
 */
export class SqliteTranscriptRepository implements TranscriptStore {
  constructor(private readonly db: DatabaseSync) {}

  appendFinal(segment: TranscriptSegment): void {
    if (segment.type !== "final") {
      throw new Error(`refused to persist a ${segment.type} segment: ${segment.id}`);
    }
    this.db
      .prepare(
        `INSERT INTO transcript_segments
         (id, session_id, text, start_time, end_time, confidence, created_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(session_id, id) DO NOTHING`,
      )
      .run(
        segment.id,
        segment.sessionId,
        segment.text,
        segment.startTime,
        segment.endTime ?? null,
        segment.confidence ?? null,
        segment.createdAt,
      );
  }

  listFinal(sessionId: string): TranscriptSegment[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, text, start_time, end_time, confidence, created_at
         FROM transcript_segments WHERE session_id = ? ORDER BY start_time ASC`,
      )
      .all(sessionId) as unknown as TranscriptRow[];
    return rows.map(toSegment);
  }

  getFinal(sessionId: string, id: string): TranscriptSegment | undefined {
    const row = this.db
      .prepare(
        `SELECT id, session_id, text, start_time, end_time, confidence, created_at
         FROM transcript_segments WHERE session_id = ? AND id = ?`,
      )
      .get(sessionId, id) as unknown as TranscriptRow | undefined;
    return row ? toSegment(row) : undefined;
  }

  /** Last `limit` finals by time, used to rebuild the MindMap window after a restart. */
  latestFinal(sessionId: string, limit: number): TranscriptSegment[] {
    return this.listFinal(sessionId).slice(-limit);
  }

  countFinal(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM transcript_segments WHERE session_id = ?`)
      .get(sessionId) as { n: number };
    return Number(row.n);
  }
}

interface TranscriptRow {
  id: string;
  session_id: string;
  text: string;
  start_time: number;
  end_time: number | null;
  confidence: number | null;
  created_at: number;
}

function toSegment(row: TranscriptRow): TranscriptSegment {
  return {
    id: row.id,
    sessionId: row.session_id,
    text: row.text,
    startTime: Number(row.start_time),
    ...(row.end_time !== null ? { endTime: Number(row.end_time) } : {}),
    ...(row.confidence !== null ? { confidence: Number(row.confidence) } : {}),
    type: "final",
    createdAt: Number(row.created_at),
  };
}
