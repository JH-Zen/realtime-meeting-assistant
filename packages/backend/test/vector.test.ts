import { describe, expect, it } from "vitest";
import { decodeVector, dot, encodeVector, rankByCosine, toUnitVector } from "../src/retrieval/vector.js";

/**
 * Retrieval ranking is a dozen lines of maths, and the whole of Test D depends on it being right:
 * these tests pin the parts that a wrong-but-plausible implementation would get wrong — norms that
 * drift with sentence length, a blob decoded at the wrong alignment, ties that pick the later
 * mention, and a threshold that silently keeps every candidate.
 */

describe("vector maths", () => {
  it("scores parallel vectors 1 and orthogonal vectors 0 after normalising", () => {
    const a = toUnitVector([2, 0]);
    expect(a).toBeInstanceOf(Float32Array);
    expect(dot(a, toUnitVector([10, 0]))).toBeCloseTo(1, 5);
    expect(dot(a, toUnitVector([0, 5]))).toBeCloseTo(0, 5);
  });

  it("makes a long sentence and its short restatement agree, which raw dot products would not", () => {
    const short = toUnitVector([3, 4]);
    const long = toUnitVector([30, 40]);
    expect(dot(short, long)).toBeCloseTo(1, 5);
  });

  it("turns a zero-norm input into a vector that can never match anything", () => {
    const empty = toUnitVector([0, 0, 0]);
    expect(Array.from(empty)).toEqual([0, 0, 0]);
    expect(dot(empty, toUnitVector([1, 2, 3]))).toBe(0);
  });

  it("round-trips a unit vector through a SQLite blob", () => {
    const original = toUnitVector([1.5, -2.25, 0.125, 4]);
    const bytes = encodeVector(original);
    const restored = decodeVector(new Uint8Array(bytes), original.length);
    expect(restored).not.toBeNull();
    expect(Array.from(restored ?? [])).toEqual(Array.from(original));
  });

  it("refuses a blob that does not match its declared dimension", () => {
    // Rows written by another model are not noise to rank, they are wrong: skipping keeps the old
    // index from competing with a new one.
    expect(decodeVector(new Uint8Array(8), 3)).toBeNull();
  });

  it("ranks by similarity, caps at k, and drops what falls under the threshold", () => {
    const query = toUnitVector([1, 0]);
    const ranked = rankByCosine(
      query,
      [
        { item: "weak", vector: toUnitVector([0.1, 1]) },
        { item: "near", vector: toUnitVector([0.7, 1]) },
        { item: "exact", vector: toUnitVector([5, 0]) },
        { item: "away", vector: toUnitVector([-1, 0]) },
      ],
      2,
      0.1,
    );
    expect(ranked.map((entry) => entry.item)).toEqual(["exact", "near"]);
    expect(ranked[0]?.score).toBeCloseTo(1, 5);
  });

  it("breaks ties by candidate order so the earliest mention is the one cited", () => {
    const ranked = rankByCosine(
      toUnitVector([1, 0]),
      [
        { item: "first", vector: toUnitVector([1, 0]) },
        { item: "second", vector: toUnitVector([1, 0]) },
      ],
      5,
    );
    expect(ranked.map((entry) => entry.item)).toEqual(["first", "second"]);
  });

  it("returns nothing for a non-positive k instead of scanning the whole index", () => {
    expect(rankByCosine(toUnitVector([1, 0]), [{ item: "a", vector: toUnitVector([1, 0]) }], 0)).toEqual([]);
  });
});
