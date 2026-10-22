import type { EmbeddingProvider } from "./EmbeddingProvider.js";

/**
 * Offline stand-in for a sentence-embedding model, so `MOCK_*` Mode (design doc §50) exercises the
 * whole retrieval path — queueing, storage, ranking, prompt slots, citations — without a download.
 *
 * It is a hashed bag of subwords: CJK runs contribute every character and every adjacent pair
 * (Chinese has no spaces, and a bigram like `世界` + `模型` is what makes `世界模型` findable), Latin
 * runs contribute lowercase words. Each token is signed-hashed into a bucket, so colliding tokens
 * cancel out on average instead of inventing similarity, and unrelated text ends up near 0 cosine.
 *
 * It is deliberately *not* a semantic model: it cannot know that `世界模型` and `world model` are
 * the same idea. Ranking quality is therefore a lower bound, and the real provider (Phase 7d) is
 * what the §9 thresholds are tuned against.
 */

const DIM = 512;
const TOKEN_PATTERN = /[a-z0-9]+|[㐀-䶿一-鿿]+/g;
const CJK_START = 0x3400;

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly dim = DIM;

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((text) => hashedEmbedding(text, DIM));
  }
}

function hashedEmbedding(text: string, dim: number): Float32Array {
  const vector = new Float32Array(dim);
  for (const token of tokenize(text)) {
    const hash = fnv1a(token);
    // Multi-character tokens are the specific ones; a single CJK ideograph matches a lot of text.
    const weight = token.length > 1 ? 1.5 : 1;
    vector[hash % dim] = (vector[hash % dim] ?? 0) + (((hash >>> 16) & 1) === 0 ? weight : -weight);
  }
  return vector;
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.toLowerCase().matchAll(TOKEN_PATTERN)) {
    const run = match[0] ?? "";
    if (isCjk(run)) {
      for (let i = 0; i < run.length; i += 1) {
        tokens.push(run[i] as string);
        if (i + 1 < run.length) tokens.push(run.slice(i, i + 2));
      }
    } else {
      tokens.push(run);
    }
  }
  return tokens;
}

function isCjk(run: string): boolean {
  const code = run.charCodeAt(0);
  return (code >= CJK_START && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff);
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
