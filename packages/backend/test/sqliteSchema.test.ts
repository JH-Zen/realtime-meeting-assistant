import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite } from "../src/store/sqlite.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { SqliteTranscriptRepository } from "../src/store/transcriptRepository.js";
import type { DatabaseSync } from "node:sqlite";

/**
 * `openSqlite` is where the DDL and the small column migrations meet, and nothing else in the suite
 * opens a database that was created by an *older* DDL. These tests cover that seam only.
 */

const columnNames = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name);

it("drops the dead speaker_id column when an older database is reopened", () => {
  const dir = mkdtempSync(join(tmpdir(), "rcc-schema-"));
  const path = join(dir, "t.sqlite");
  try {
    // An "old" database is today's schema plus the column OPEN-9 removed: that is exactly the shape
    // left behind by every file written before the column was dropped from the DDL.
    const first = openSqlite(path);
    first.db.exec("ALTER TABLE transcript_segments ADD COLUMN speaker_id TEXT");
    expect(columnNames(first.db, "transcript_segments")).toContain("speaker_id");
    first.close();

    const second = openSqlite(path);
    expect(columnNames(second.db, "transcript_segments")).not.toContain("speaker_id");

    // The point of removing it is that a write path must not miss it. Reading back proves the
    // migrated database is usable, not merely narrower.
    new SqliteSessionRepository(second.db).create({ id: "s1", startedAt: 1, status: "recording" });
    const repo = new SqliteTranscriptRepository(second.db);
    repo.appendFinal({ id: "f1", sessionId: "s1", text: "世界模型", startTime: 0, endTime: 2, type: "final", createdAt: 1 });
    expect(repo.listFinal("s1")).toEqual([
      { id: "f1", sessionId: "s1", text: "世界模型", startTime: 0, endTime: 2, type: "final", createdAt: 1 },
    ]);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("leaves a freshly created database without the column at all", () => {
  const store = openSqlite(":memory:");
  expect(columnNames(store.db, "transcript_segments")).not.toContain("speaker_id");
  store.close();
});

it("adds review metadata to an older database while preserving its saved meeting rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "rcc-m2-schema-"));
  const path = join(dir, "old.sqlite");
  try {
    const first = openSqlite(path);
    const sessions = new SqliteSessionRepository(first.db);
    sessions.create({ id: "preserved", title: "原会议", startedAt: 1, endedAt: 4000, status: "completed" });
    new SqliteTranscriptRepository(first.db).appendFinal({ id: "saved", sessionId: "preserved", text: "必须保留的原文", type: "final", startTime: 0, createdAt: 1 });
    first.db.exec("DROP TABLE workspace_state");
    first.db.exec("ALTER TABLE sessions DROP COLUMN duration_sec");
    const before = first.db.prepare("SELECT * FROM sessions").all();
    const transcript = first.db.prepare("SELECT * FROM transcript_segments").all();
    first.close();
    for (let pass = 0; pass < 2; pass++) {
      const reopened = openSqlite(path);
      expect(reopened.db.prepare("SELECT id, title, started_at, ended_at, status FROM sessions").all()).toEqual(before);
      expect(reopened.db.prepare("SELECT * FROM transcript_segments").all()).toEqual(transcript);
      expect(new SqliteSessionRepository(reopened.db).get("preserved")?.durationSec).toBeUndefined();
      const repo = new SqliteSessionRepository(reopened.db);
      repo.select("preserved");
      expect(repo.selected()?.title).toBe("原会议");
      reopened.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
