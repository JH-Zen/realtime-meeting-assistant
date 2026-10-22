import type { DatabaseSync } from "node:sqlite";
import type { Session } from "@rcc/shared";

export class SqliteSessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(session: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, started_at, ended_at, status) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(session.id, session.title ?? null, session.startedAt, session.endedAt ?? null, session.status);
  }

  setStatus(id: string, status: Session["status"], endedAt?: number): void {
    this.db
      .prepare(`UPDATE sessions SET status = ?, ended_at = COALESCE(?, ended_at) WHERE id = ?`)
      .run(status, endedAt ?? null, id);
  }

  get(id: string): Session | undefined {
    const row = this.db
      .prepare(`SELECT id, title, started_at, ended_at, status FROM sessions WHERE id = ?`)
      .get(id) as unknown as SessionRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      ...(row.title !== null ? { title: row.title } : {}),
      startedAt: Number(row.started_at),
      ...(row.ended_at !== null ? { endedAt: Number(row.ended_at) } : {}),
      status: row.status as Session["status"],
    };
  }
}

interface SessionRow {
  id: string;
  title: string | null;
  started_at: number;
  ended_at: number | null;
  status: string;
}
