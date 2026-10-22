/**
 * Vector maths for retrieval (§30). Two rules make this small:
 * - stored vectors are unit length, so cosine is a dot product;
 * - ranking is an exact scan, because ~3000 x 1024 float32 is 12 MB and a few million
 *   multiply-adds (ADR §9 constraint 2). No ANN, no index structure, no vector database.
 */

/** Normalising here is what makes "dot = cosine" true for every provider, including one that
 *  forgot to. A zero-norm input becomes a zero vector, which scores 0 and so never surfaces. */
export function toUnitVector(raw: ArrayLike<number>): Float32Array {
  const vector = raw instanceof Float32Array ? raw : Float32Array.from(raw);
  const unit = new Float32Array(vector.length);
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) {
    const value = vector[i] ?? 0;
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return unit;
  for (let i = 0; i < vector.length; i += 1) unit[i] = (vector[i] ?? 0) / norm;
  return unit;
}

export function encodeVector(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** The read-back blob may sit at an arbitrary offset in a larger allocation, and `Float32Array`
 *  needs a 4-byte-aligned buffer, so the copy is not waste. A length mismatch means the row was
 *  written by a different model: `null` lets the caller skip it instead of scoring garbage. */
export function decodeVector(bytes: Uint8Array, dim: number): Float32Array | null {
  if (bytes.byteLength !== dim * 4) return null;
  return new Float32Array(new Uint8Array(bytes).buffer, 0, dim);
}

export function dot(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

export interface Scored<T> {
  item: T;
  score: number;
}

/**
 * Exact cosine ranking. Ties keep the caller's order, so passing candidates in `start_time` order
 * makes the earliest mention of a repeated idea win — which is what a `[mm:ss]` citation should
 * point at.
 */
export function rankByCosine<T>(
  query: Float32Array,
  candidates: readonly { item: T; vector: Float32Array }[],
  k: number,
  minScore = 0,
): Scored<T>[] {
  if (k <= 0) return [];
  const scored: Scored<T>[] = [];
  for (const candidate of candidates) {
    const score = dot(query, candidate.vector);
    if (score > minScore) scored.push({ item: candidate.item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
