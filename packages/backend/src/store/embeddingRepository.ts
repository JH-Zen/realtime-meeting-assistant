import type { DatabaseSync } from "node:sqlite";
import { decodeVector, encodeVector } from "../retrieval/vector.js";

export type EmbeddingOwner = "transcript" | "summary";

export interface EmbeddingWrite {
  ownerType: EmbeddingOwner;
  ownerId: string;
  sessionId: string;
  provider: string;
  vector: Float32Array;
}

export interface EmbeddingCandidate {
  ownerId: string;
  vector: Float32Array;
}

/**
 * Embeddings live in the same SQLite file as the rows they describe (ADR §9 constraint 1), so a
 * segment and its vector can never disagree about which session they belong to.
 *
 * Unlike `SqliteSummaryRepository`, this one does overwrite. A summary is a historical record of
 * what the model claimed, so rewriting it would silently change what an old answer was based on.
 * A vector is a pure derivative of text that is already stored: keeping two rows for one segment
 * would double-count it in every ranking, so the newest embedding is the only correct state.
 */
export class SqliteEmbeddingRepository {
  constructor(private readonly db: DatabaseSync) {}

  put(entry: EmbeddingWrite): void {
    this.db
      .prepare(
        `INSERT INTO embeddings (owner_type, owner_id, session_id, provider, dim, vec, created_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(session_id, owner_type, owner_id)
         DO UPDATE SET provider = excluded.provider, dim = excluded.dim, vec = excluded.vec, created_at = excluded.created_at`,
      )
      .run(
        entry.ownerType,
        entry.ownerId,
        entry.sessionId,
        entry.provider,
        entry.vector.length,
        encodeVector(entry.vector),
        Date.now(),
      );
  }

  putBatch(entries: readonly EmbeddingWrite[]): void {
    this.db.exec("BEGIN");
    try {
      for (const entry of entries) this.put(entry);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Ids already embedded by this provider, so a restart resumes instead of re-embedding a session. */
  listOwnerIds(sessionId: string, ownerType: EmbeddingOwner, provider: string): Set<string> {
    const rows = this.db
      .prepare(`SELECT owner_id FROM embeddings WHERE session_id = ? AND owner_type = ? AND provider = ?`)
      .all(sessionId, ownerType, provider) as unknown as { owner_id: string }[];
    return new Set(rows.map((row) => row.owner_id));
  }

  /**
   * The whole scan for one session. Filtered by provider and dimension because cosine between two
   * different models is not noise, it is a confident wrong answer — a provider switch must not
   * rank old rows at all.
   */
  scan(sessionId: string, ownerType: EmbeddingOwner, provider: string, dim: number): EmbeddingCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT owner_id, dim, vec FROM embeddings
         WHERE session_id = ? AND owner_type = ? AND provider = ? AND dim = ?
         ORDER BY rowid`,
      )
      .all(sessionId, ownerType, provider, dim) as unknown as { owner_id: string; dim: number; vec: Uint8Array }[];
    const candidates: EmbeddingCandidate[] = [];
    for (const row of rows) {
      const vector = decodeVector(row.vec, Number(row.dim));
      if (vector) candidates.push({ ownerId: row.owner_id, vector });
    }
    return candidates;
  }

  count(sessionId: string, provider?: string): number {
    const statement = provider
      ? this.db.prepare(`SELECT COUNT(*) AS n FROM embeddings WHERE session_id = ? AND provider = ?`)
      : this.db.prepare(`SELECT COUNT(*) AS n FROM embeddings WHERE session_id = ?`);
    const row = (provider ? statement.get(sessionId, provider) : statement.get(sessionId)) as { n: number };
    return Number(row.n);
  }
}
