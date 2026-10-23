import type { DatabaseSync } from "node:sqlite";
import type { Session, SessionListEntry } from "@rcc/shared";

export class SqliteSessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(session: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, started_at, ended_at, duration_sec, status) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(session.id, session.title ?? null, session.startedAt, session.endedAt ?? null, session.durationSec ?? null, session.status);
  }

  setStatus(id: string, status: Session["status"], endedAt?: number, durationSec?: number): void {
    this.db
      .prepare(`UPDATE sessions SET status = ?, ended_at = COALESCE(?, ended_at), duration_sec = COALESCE(?, duration_sec) WHERE id = ?`)
      .run(status, endedAt ?? null, durationSec ?? null, id);
  }

  get(id: string): Session | undefined {
    const row = this.db
      .prepare(`SELECT id, title, started_at, ended_at, duration_sec, status FROM sessions WHERE id = ?`)
      .get(id) as unknown as SessionRow | undefined;
    if (!row) return undefined;
    return toSession(row);
  }

  list(limit = 50, offset = 0): SessionListEntry[] {
    const rows = this.db.prepare(`
      SELECT s.*,
        (SELECT count(*) FROM transcript_segments t WHERE t.session_id = s.id) AS transcript_count,
        (SELECT count(*) FROM mindmap_nodes n WHERE n.session_id = s.id) AS node_count
      FROM sessions s ORDER BY s.started_at DESC, s.id DESC LIMIT ? OFFSET ?
    `).all(limit, offset) as unknown as (SessionRow & { transcript_count: number; node_count: number })[];
    return rows.map((row) => ({ ...toSession(row), transcriptCount: Number(row.transcript_count), nodeCount: Number(row.node_count) }));
  }

  select(id: string | null): void {
    this.db.prepare("INSERT INTO workspace_state (id, session_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id").run(id);
  }

  selected(): Session | undefined {
    const row = this.db.prepare("SELECT session_id FROM workspace_state WHERE id = 1").get() as { session_id: string | null } | undefined;
    return row?.session_id ? this.get(row.session_id) : undefined;
  }
}

function toSession(row: SessionRow): Session {
  return {
      id: row.id,
      ...(row.title !== null ? { title: row.title } : {}),
      startedAt: Number(row.started_at),
      ...(row.ended_at !== null ? { endedAt: Number(row.ended_at) } : {}),
      ...(row.duration_sec !== null ? { durationSec: Number(row.duration_sec) } : {}),
      status: row.status as Session["status"],
  };
}

interface SessionRow {
  id: string;
  title: string | null;
  started_at: number;
  ended_at: number | null;
  duration_sec: number | null;
  status: string;
}
