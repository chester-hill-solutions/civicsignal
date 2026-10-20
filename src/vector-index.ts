import { readFileSync } from 'node:fs';
import type { CorpusItem } from '@chester-hill-solutions/corpus';

/**
 * The vector index.
 *
 * Two implementations of one interface: Vectorize, which is what production uses,
 * and a file-backed one that reads the store the evaluation builds, so the same
 * retrieval path can be exercised locally.
 *
 * The index holds **no text**. Only the embedding and metadata — the row id, the
 * jurisdiction, the date. The canonical row, the text and the licence policy live in
 * the relational store, and an item is fetched from there and passed through the
 * licence gate before it is returned. A vector index that held the text would be a
 * second copy of the corpus that bypasses the gate.
 */

export interface VectorMatch {
  /** The id of the row this vector belongs to. */
  id: string;
  score: number;
  metadata: Record<string, string | number>;
}

export interface VectorIndex {
  query(vector: number[], topK: number, filter?: Record<string, string>): Promise<VectorMatch[]>;
}

/** The subset of a Vectorize binding this uses. */
export interface VectorizeBinding {
  query(
    vector: number[],
    options: { topK: number; returnMetadata?: string | string[]; filter?: Record<string, string> },
  ): Promise<{
    matches: { id: string; score: number; metadata?: Record<string, string | number> }[];
  }>;
}

export class VectorizeIndex implements VectorIndex {
  constructor(private readonly binding: VectorizeBinding) {}

  async query(
    vector: number[],
    topK: number,
    filter?: Record<string, string>,
  ): Promise<VectorMatch[]> {
    // `indexed` rather than `all`: the metadata that matters for filtering is
    // the metadata that is indexed, and asking for `all` halves the top-k
    // ceiling — Vectorize limits it to twenty when every field is returned and
    // a hundred when only the indexed ones are. The brief asks for twenty-five
    // by default, so `all` would fail on the ordinary case.
    const result = await this.binding.query(vector, {
      topK: Math.min(topK, 100),
      returnMetadata: 'indexed',
      ...(filter ? { filter } : {}),
    });
    return result.matches.map((match) => ({
      id: match.id,
      score: match.score,
      metadata: match.metadata ?? {},
    }));
  }
}

/**
 * A file-backed index, for local development and for the evaluation.
 *
 * The store is a flat float32 file with a small header, written by
 * `scripts/embed-corpus.ts`. Search is an exact cosine scan, which is the right
 * behaviour for a store this size and has the useful property of being identical
 * to what the product computes — no approximation to reason about.
 */
export class FileVectorIndex implements VectorIndex {
  private readonly count: number;
  private readonly dims: number;
  private readonly vectors: Float32Array;
  private readonly norms: Float32Array;

  constructor(path: string) {
    const buffer = readFileSync(path);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    if (view.getUint32(0, true) !== 0x43535356) {
      throw new Error(`${path} is not a vector store`);
    }
    this.count = view.getUint32(4, true);
    this.dims = view.getUint32(8, true);
    this.vectors = new Float32Array(buffer.buffer, buffer.byteOffset + 16, this.count * this.dims);
    this.norms = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      let sum = 0;
      const base = i * this.dims;
      for (let d = 0; d < this.dims; d++) {
        const value = this.vectors[base + d]!;
        sum += value * value;
      }
      this.norms[i] = Math.sqrt(sum) || 1;
    }
  }

  async query(vector: number[], topK: number): Promise<VectorMatch[]> {
    const width = Math.min(this.dims, vector.length);
    let queryNorm = 0;
    for (let d = 0; d < width; d++) queryNorm += vector[d]! * vector[d]!;
    queryNorm = Math.sqrt(queryNorm) || 1;

    const scores = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const base = i * this.dims;
      let dot = 0;
      for (let d = 0; d < width; d++) dot += this.vectors[base + d]! * vector[d]!;
      scores[i] = dot / (this.norms[i]! * queryNorm);
    }

    const order = Array.from({ length: this.count }, (_, i) => i).sort(
      (a, b) => scores[b]! - scores[a]! || a - b,
    );
    return order.slice(0, topK).map((i) => ({ id: String(i), score: scores[i]!, metadata: {} }));
  }
}
