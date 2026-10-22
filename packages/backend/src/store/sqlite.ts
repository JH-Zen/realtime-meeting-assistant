import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * SQLite via the Node built-in — no native addon to segfault (ADR §2).
 * Embedding vectors are BLOBs in this same file (ADR §9 constraint 1): one database, one
 * write-ahead log, no cross-store consistency problem between a segment and its own vector.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  status      TEXT NOT NULL CHECK (status IN ('recording','paused','completed'))
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id          TEXT NOT NULL,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  start_time  REAL NOT NULL,
  end_time    REAL,
  confidence  REAL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS idx_transcript_session_time
  ON transcript_segments (session_id, start_time);

CREATE TABLE IF NOT EXISTS summary_blocks (
  id             TEXT NOT NULL,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  start_time     REAL NOT NULL,
  end_time       REAL NOT NULL,
  summary        TEXT NOT NULL,
  key_points     TEXT NOT NULL DEFAULT '[]',
  entities       TEXT NOT NULL DEFAULT '[]',
  level          INTEGER NOT NULL DEFAULT 0,
  parent_block_id TEXT,
  source_block_ids TEXT NOT NULL DEFAULT '[]',
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS idx_summary_session ON summary_blocks (session_id, start_time);

CREATE TABLE IF NOT EXISTS embeddings (
  owner_type TEXT NOT NULL CHECK (owner_type IN ('transcript','summary')),
  owner_id   TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, owner_type, owner_id)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_session ON embeddings (session_id, owner_type);

CREATE TABLE IF NOT EXISTS mindmap_nodes (
  id                    TEXT NOT NULL,
  session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  summary               TEXT,
  parent_id             TEXT,
  source_transcript_ids TEXT NOT NULL DEFAULT '[]',
  confidence            REAL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS idx_nodes_session ON mindmap_nodes (session_id);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON mindmap_nodes (parent_id);

CREATE TABLE IF NOT EXISTS mindmap_edges (
  id         TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,
  target     TEXT NOT NULL,
  relation   TEXT,
  PRIMARY KEY (session_id, id)
);

CREATE TABLE IF NOT EXISTS graph_positions (
  node_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, node_id)
);

CREATE TABLE IF NOT EXISTS graph_operations (
  op_id      TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  response_id TEXT,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_session ON graph_operations (session_id, created_at);

CREATE TABLE IF NOT EXISTS questions (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  snapshot_id TEXT
);

CREATE TABLE IF NOT EXISTS answers (
  id          TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  citations   TEXT NOT NULL DEFAULT '[]',
  duration_ms INTEGER NOT NULL,
  degraded    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
`;

export interface Sqlite {
  db: DatabaseSync;
  close(): void;
}

/** `CREATE TABLE IF NOT EXISTS` cannot evolve a table that already has rows, so columns added
 *  after the fact are checked here. Idempotent: an existing column is left alone. */
function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(ddl);
}

/**
 * The mirror of `ensureColumn`, and needed for the same reason: `DROP COLUMN` in the DDL above only
 * helps a database created from now on. Databases opened before it still carry the column, and a
 * column nothing writes is exactly what a later audit misreads as a capability (ADR §13 OPEN-9).
 */
function dropColumn(db: DatabaseSync, table: string, column: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (!columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

export function openSqlite(dbPath: string): Sqlite {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  ensureColumn(db, "summary_blocks", "source_block_ids", "ALTER TABLE summary_blocks ADD COLUMN source_block_ids TEXT NOT NULL DEFAULT '[]'");
  dropColumn(db, "transcript_segments", "speaker_id");
  return {
    db,
    close() {
      db.close();
    },
  };
}
