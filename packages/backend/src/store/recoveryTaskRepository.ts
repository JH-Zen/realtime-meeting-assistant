import type { DatabaseSync } from "node:sqlite";
import { RecoveryTaskSchema, type RecoveryTask } from "@rcc/shared";

/** Persists only the operational fields accepted by the shared recovery schema. */
export class SqliteRecoveryTaskRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(task: RecoveryTask): void {
    const value = RecoveryTaskSchema.parse(task);
    if (value.status !== "running") throw new Error("Recovery task must start running");
    this.db.prepare(`INSERT INTO recovery_tasks(id,session_id,kind,status,started_at,task_json)
      VALUES(?,?,?,?,?,?)`).run(
      value.id, value.sessionId, value.kind, value.status, value.startedAt, JSON.stringify(value),
    );
  }

  save(task: RecoveryTask): void {
    const value = RecoveryTaskSchema.parse(task);
    // The identity and running-state guard belongs to the write itself: a late callback
    // cannot replace another session's task or revive a task already made terminal.
    const result = this.db.prepare(`UPDATE recovery_tasks SET status=?,started_at=?,task_json=?
      WHERE id=? AND session_id=? AND kind=? AND status='running'`).run(
      value.status, value.startedAt, JSON.stringify(value), value.id, value.sessionId, value.kind,
    );
    if (result.changes !== 1) throw new Error("Recovery task identity or running state mismatch");
  }

  list(sessionId: string, limit = 10, scope: "manual" | "live" | "all" = "all"): RecoveryTask[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new RangeError("Recovery task limit must be an integer from 1 to 50");
    }
    if (!["manual", "live", "all"].includes(scope)) throw new RangeError("Invalid recovery task scope");
    const rows = this.db.prepare(`SELECT task_json FROM recovery_tasks
      WHERE session_id=? AND (?='all' OR COALESCE(json_extract(task_json,'$.trigger'),'manual')=?)
      ORDER BY started_at DESC,id DESC LIMIT ?`).all(sessionId, scope, scope, limit) as { task_json: string }[];
    return rows.map((row) => RecoveryTaskSchema.parse(JSON.parse(row.task_json)));
  }

  interruptRunning(): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare("SELECT task_json FROM recovery_tasks WHERE status='running'").all() as { task_json: string }[];
      for (const row of rows) {
        const task = RecoveryTaskSchema.parse(JSON.parse(row.task_json));
        const finishedAt = Math.max(Date.now(), task.startedAt,
          ...task.attempts.map((attempt) => attempt.finishedAt ?? attempt.startedAt));
        this.save({
          ...task,
          status: "interrupted",
          finishedAt,
          failureCode: "process_interrupted",
          attempts: task.attempts.map((attempt) => attempt.outcome === "running"
            ? { ...attempt, outcome: "interrupted", finishedAt }
            : attempt),
        });
      }
      this.db.exec("COMMIT");
      return rows.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
