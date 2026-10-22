/**
 * The seam between retrieval (§30) and whatever turns text into numbers.
 *
 * Nothing above this line may assume a dimension, a tokenizer, or a model family — the point is
 * that Mock Mode can exercise the whole retrieval path with no download and no key, and a real
 * provider can replace it without `RetrievalCore` changing.
 */
export interface EmbeddingProvider {
  readonly name: string;
  /** Fixed for a provider instance: it is part of the row identity, so a model swap cannot mix
   *  two vector spaces inside one ranking. */
  readonly dim: number;
  /** One vector per input, in the same order. Vectors need not be normalised; the caller does it. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}
