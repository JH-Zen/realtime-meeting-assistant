import type { DatabaseSync } from "node:sqlite";
import type { SummaryBlock } from "@rcc/shared";

/**
 * Stage summaries (§31) are history, not state: the contract is `append` and nothing else. There is
 * deliberately no update or delete here — a rewritten summary would silently change what earlier
 * answers were based on, and a 60-minute recording must be able to show which block said what.
 */
export class SqliteSummaryRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** A repeated id is ignored rather than merged: the first write is the record. */
  append(block: SummaryBlock): void {
    this.db
      .prepare(
        `INSERT INTO summary_blocks
         (id, session_id, start_time, end_time, summary, key_points, entities, level, parent_block_id, source_block_ids, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id, id) DO NOTHING`,
      )
      .run(
        block.id,
        block.sessionId,
        block.startTime,
        block.endTime,
        block.summary,
        JSON.stringify(block.keyPoints),
        JSON.stringify(block.entities),
        block.level,
        block.parentBlockId ?? null,
        JSON.stringify(block.sourceBlockIds),
        Date.now(),
      );
  }

  list(sessionId: string): SummaryBlock[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, start_time, end_time, summary, key_points, entities, level, parent_block_id, source_block_ids
         FROM summary_blocks WHERE session_id = ? ORDER BY level ASC, start_time ASC`,
      )
      .all(sessionId) as unknown as SummaryRow[];
    return rows.map(toBlock);
  }

  listLevel(sessionId: string, level: number): SummaryBlock[] {
    return this.list(sessionId).filter((block) => block.level === level);
  }

  count(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM summary_blocks WHERE session_id = ?`)
      .get(sessionId) as { n: number };
    return Number(row.n);
  }
}

interface SummaryRow {
  id: string;
  session_id: string;
  start_time: number;
  end_time: number;
  summary: string;
  key_points: string;
  entities: string;
  level: number;
  parent_block_id: string | null;
  source_block_ids: string;
}

function toBlock(row: SummaryRow): SummaryBlock {
  return {
    id: row.id,
    sessionId: row.session_id,
    startTime: Number(row.start_time),
    endTime: Number(row.end_time),
    summary: row.summary,
    keyPoints: readList(row.key_points),
    entities: readList(row.entities),
    level: Number(row.level),
    ...(row.parent_block_id !== null ? { parentBlockId: row.parent_block_id } : {}),
    sourceBlockIds: readList(row.source_block_ids),
  };
}

function readList(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
