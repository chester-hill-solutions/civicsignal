import { readFileSync } from 'node:fs';

/**
 * The vector arm of the retrieval evaluation, and the fusion of the two arms.
 *
 * The vector store is a flat float32 file rather than a database, because the
 * question being asked is "does a vector arm beat the keyword baseline", and the
 * answer should not be confounded by the performance characteristics of the store.
 * A separate investigation covers PGlite with pgvector as a deployment option.
 */

export interface VectorStore {
  count: number;
  dims: number;
  vectors: Float32Array;
  /** Precomputed document norms, for cosine. */
  norms: Float32Array;
}

const MAGIC = 0x43535356; // "CVSV"

export function loadVectorStore(path: string): VectorStore {
  const buffer = readFileSync(path);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, true) !== MAGIC) {
    throw new Error(`${path} is not a vector store`);
  }
  const count = view.getUint32(4, true);
  const dims = view.getUint32(8, true);
  const expected = 16 + count * dims * 4;
  if (buffer.byteLength < expected) {
    throw new Error(`${path} is truncated: ${buffer.byteLength} bytes, expected ${expected}`);
  }
  const vectors = new Float32Array(buffer.buffer, buffer.byteOffset + 16, count * dims);
  const norms = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    const base = i * dims;
    for (let d = 0; d < dims; d++) {
      const value = vectors[base + d]!;
      sum += value * value;
    }
    norms[i] = Math.sqrt(sum) || 1;
  }
  return { count, dims, vectors, norms };
}

export interface ScoredDoc {
  docId: number;
  score: number;
}

/**
 * Exact cosine search over the whole store.
 *
 * `dims` truncates the comparison to the first N dimensions. That is *not* the same
 * thing as Matryoshka truncation — Matryoshka models are trained so the leading
 * dimensions carry the signal, and a plain model like BGE is not. Measuring naive
 * truncation on a non-Matryoshka model shows the cost of not having Matryoshka
 * training; it is not a preview of what EmbeddingGemma 2 would do.
 */
export function searchVectors(
  store: VectorStore,
  query: Float32Array,
  topK: number,
  dims?: number,
): ScoredDoc[] {
  const width = Math.min(dims ?? store.dims, store.dims, query.length);
  let queryNorm = 0;
  for (let d = 0; d < width; d++) queryNorm += query[d]! * query[d]!;
  queryNorm = Math.sqrt(queryNorm) || 1;

  const scores = new Float32Array(store.count);
  for (let i = 0; i < store.count; i++) {
    const base = i * store.dims;
    let dot = 0;
    for (let d = 0; d < width; d++) dot += store.vectors[base + d]! * query[d]!;
    scores[i] = dot / (store.norms[i]! * queryNorm);
  }

  // Partial selection: a full sort of 191k scores per query is wasteful.
  const index = new Int32Array(store.count);
  for (let i = 0; i < store.count; i++) index[i] = i;
  const arr = Array.from(index);
  arr.sort((a, b) => scores[b]! - scores[a]! || a - b);
  return arr.slice(0, topK).map((docId) => ({ docId, score: scores[docId]! }));
}

/**
 * Reciprocal rank fusion.
 *
 * RRF combines rankings without needing the scores to be on the same scale, which
 * is exactly the situation when one arm produces unbounded BM25 scores and the
 * other produces cosine similarities. `k` is the standard 60.
 */
export function reciprocalRankFusion(
  rankings: ScoredDoc[][],
  k = 60,
  topK = 50,
  weights?: number[],
): ScoredDoc[] {
  const scores = new Map<number, number>();
  const best = new Map<number, number>();
  rankings.forEach((ranking, listIndex) => {
    const weight = weights?.[listIndex] ?? 1;
    ranking.forEach((entry, index) => {
      const rank = index + 1;
      scores.set(entry.docId, (scores.get(entry.docId) ?? 0) + weight / (k + rank));
      if (!best.has(entry.docId) || entry.score > best.get(entry.docId)!) {
        best.set(entry.docId, entry.score);
      }
    });
  });
  return [...scores.entries()]
    .map(([docId, score]) => ({ docId, score }))
    .sort((a, b) => b.score - a.score || a.docId - b.docId)
    .slice(0, topK);
}
