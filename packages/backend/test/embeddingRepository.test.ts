import { describe, expect, it } from "vitest";
import { openSqlite, type Sqlite } from "../src/store/sqlite.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { SqliteEmbeddingRepository } from "../src/store/embeddingRepository.js";
import { toUnitVector } from "../src/retrieval/vector.js";

/**
 * Vectors share the transcript's file so a segment and its embedding cannot disagree about which
 * session they belong to (ADR §9 constraint 1). These tests pin the two behaviours the ranking
 * depends on: a row is only visible to the provider and dimension that wrote it, and re-embedding
 * replaces rather than accumulates.
 */

function repo(): { store: Sqlite; embeddings: SqliteEmbeddingRepository; close: () => void } {
  const store = openSqlite(":memory:");
  const sessions = new SqliteSessionRepository(store.db);
  sessions.create({ id: "s1", startedAt: 1, status: "recording" });
  sessions.create({ id: "s2", startedAt: 1, status: "recording" });
  return { store, embeddings: new SqliteEmbeddingRepository(store.db), close: () => store.close() };
}

const entry = (sessionId: string, ownerId: string, provider: string, vector: number[]) => ({
  ownerType: "transcript" as const,
  ownerId,
  sessionId,
  provider,
  vector: toUnitVector(vector),
});

describe("embedding repository", () => {
  it("stores a vector and reads it back without drift", () => {
    const r = repo();
    const vector = toUnitVector([1.5, -2.25, 0.125]);
    r.embeddings.put(entry("s1", "t-1", "stub", Array.from(vector)));

    const scanned = r.embeddings.scan("s1", "transcript", "stub", 3);
    expect(scanned).toHaveLength(1);
    expect(Array.from(scanned[0]?.vector ?? [])).toEqual(Array.from(vector));
    expect(r.embeddings.count("s1")).toBe(1);
    r.close();
  });

  it("hides rows from a different provider or dimension", () => {
    const r = repo();
    r.embeddings.put(entry("s1", "t-1", "old-model", [1, 0]));
    r.embeddings.put(entry("s1", "t-2", "new-model", [0, 1]));

    // Cosine across two vector spaces is not noise, it is a confident wrong answer.
    expect(r.embeddings.scan("s1", "transcript", "new-model", 2).map((row) => row.ownerId)).toEqual(["t-2"]);
    expect(r.embeddings.scan("s1", "transcript", "old-model", 2).map((row) => row.ownerId)).toEqual(["t-1"]);
    expect(r.embeddings.scan("s1", "transcript", "old-model", 7)).toEqual([]);
    r.close();
  });

  it("replaces the vector for a segment instead of double-counting it", () => {
    const r = repo();
    // Unlike a summary block, an embedding is a pure derivative of text that is already stored, so
    // the newest write is the only correct state.
    r.embeddings.put(entry("s1", "t-1", "stub", [1, 0]));
    r.embeddings.put(entry("s1", "t-1", "stub", [0, 1]));

    const scanned = r.embeddings.scan("s1", "transcript", "stub", 2);
    expect(scanned).toHaveLength(1);
    expect(Array.from(scanned[0]?.vector ?? [])).toEqual(Array.from(toUnitVector([0, 1])));
    r.close();
  });

  it("lists what is already embedded so a restart resumes the index", () => {
    const r = repo();
    r.embeddings.put(entry("s1", "t-1", "stub", [1, 0]));
    r.embeddings.put(entry("s1", "t-2", "other", [1, 0]));

    expect(r.embeddings.listOwnerIds("s1", "transcript", "stub")).toEqual(new Set(["t-1"]));
    expect(r.embeddings.listOwnerIds("s1", "transcript", "other")).toEqual(new Set(["t-2"]));
    expect(r.embeddings.listOwnerIds("s1", "summary", "stub")).toEqual(new Set());
    r.close();
  });

  it("keeps two sessions that share segment ids apart", () => {
    const r = repo();
    // Segment ids are minted per session, and the mock script mints the same ones twice — so the key
    // has to be the session plus the owner, not the id alone.
    r.embeddings.put(entry("s1", "t-1", "stub", [1, 0]));
    r.embeddings.put(entry("s2", "t-1", "stub", [0, 1]));

    expect(r.embeddings.scan("s1", "transcript", "stub", 2).map((row) => row.ownerId)).toEqual(["t-1"]);
    expect(r.embeddings.count("s1")).toBe(1);
    expect(r.embeddings.count("s2")).toBe(1);
    r.close();
  });

  it("writes a batch atomically and counts only what landed", () => {
    const r = repo();
    r.embeddings.putBatch([
      entry("s1", "t-1", "stub", [1, 0]),
      entry("s1", "t-2", "stub", [0, 1]),
      entry("s1", "t-3", "stub", [1, 1]),
    ]);
    expect(r.embeddings.count("s1")).toBe(3);
    expect(r.embeddings.listOwnerIds("s1", "transcript", "stub").size).toBe(3);
    r.close();
  });
});
