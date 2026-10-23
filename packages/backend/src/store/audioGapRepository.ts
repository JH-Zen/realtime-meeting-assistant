import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AudioGapSchema, type AudioGap, type AudioGapInput } from "@rcc/shared";

export class SqliteAudioGapRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(sessionId: string): AudioGap[] {
    const rows = this.db.prepare(`SELECT id,session_id AS sessionId,stage,reason,certainty,
      start_time AS startTime,end_time AS endTime,created_at AS createdAt FROM audio_gaps
      WHERE session_id=? ORDER BY start_time,created_at`).all(sessionId);
    return rows.map((row) => AudioGapSchema.parse(row));
  }

  record(sessionId: string, input: AudioGapInput): AudioGap {
    const gap = AudioGapSchema.parse({ ...input, id: randomUUID(), sessionId, createdAt: Date.now() });
    // One 100ms drop per frame is one outage, not thousands of rows. Never sum across stages.
    const last = this.db.prepare(`SELECT id,start_time,end_time,created_at FROM audio_gaps
      WHERE session_id=? AND stage=? AND reason=? AND certainty=? ORDER BY end_time DESC LIMIT 1`)
      .get(sessionId, gap.stage, gap.reason, gap.certainty) as { id: string; start_time: number; end_time: number; created_at: number } | undefined;
    if (last && gap.startTime <= last.end_time + 0.0001 && gap.endTime >= last.start_time - 0.0001) {
      gap.id = last.id; gap.createdAt = last.created_at;
      gap.startTime = Math.min(gap.startTime, last.start_time); gap.endTime = Math.max(gap.endTime, last.end_time);
    }
    this.save(gap);
    return gap;
  }

  save(gap: AudioGap): void {
    const value = AudioGapSchema.parse(gap);
    this.db.prepare(`INSERT INTO audio_gaps(id,session_id,stage,reason,certainty,start_time,end_time,created_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id,id) DO UPDATE SET start_time=excluded.start_time,end_time=excluded.end_time`)
      .run(value.id,value.sessionId,value.stage,value.reason,value.certainty,value.startTime,value.endTime,value.createdAt);
  }
}
