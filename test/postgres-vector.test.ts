import { describe, expect, it } from 'vitest';
import { postgresVectorIndex, toVectorLiteral } from '../src/corpora/postgres-vector';

/**
 * The vector index, on Postgres.
 *
 * Two things have to be right and both are quiet when they are wrong: the
 * **score** has to be a similarity (so the ranking prefers the better match),
 * and the **filter** has to be a predicate on the row (so the language lens
 * reaches the index rather than being applied afterwards).
 */
function indexWith(rows: { id: string; score: number }[]): {
  index: ReturnType<typeof postgresVectorIndex>;
  calls: { query: string; values: unknown[] }[];
} {
  const calls: { query: string; values: unknown[] }[] = [];
  const index = postgresVectorIndex({
    unsafe(query: string, values?: unknown[]) {
      calls.push({ query, values: values ?? [] });
      return async () => rows;
    },
  });
  return { index, calls };
}

describe('the vector literal', () => {
  it('is the bracketed list pgvector takes', () => {
    expect(toVectorLiteral([0.5, -0.25, 1])).toBe('[0.5,-0.25,1]');
  });
});

describe('the vector index on Postgres', () => {
  it('asks for the cosine similarity, not the distance', async () => {
    const { index, calls } = indexWith([]);
    await index.query([0.1, 0.2], 5);
    // `1 - (<=>)` and not the raw distance: a distance of 0.17 means "0.83
    // similar", and passing the distance through would make the ranking prefer
    // the *worst* matches.
    expect(calls[0]?.query).toContain('1 - (embedding <=> $1) AS score');
    expect(calls[0]?.query).toContain('ORDER BY embedding <=> $1');
  });

  it('passes the vector and the limit as parameters', async () => {
    const { index, calls } = indexWith([]);
    await index.query([0.1, 0.2], 7);
    expect(calls[0]?.values?.[0]).toBe('[0.1,0.2]');
    expect(calls[0]?.values?.[1]).toBe(7);
  });

  it('filters on the language, as a predicate on the row', async () => {
    const { index, calls } = indexWith([]);
    await index.query([0.1], 5, { language: 'fr' });
    expect(calls[0]?.query).toContain('WHERE language = $2');
    expect(calls[0]?.values?.[1]).toBe('fr');
  });

  it('filters on more than one thing at once', async () => {
    const { index, calls } = indexWith([]);
    await index.query([0.1], 5, { language: 'fr', jurisdiction: 'CA' });
    expect(calls[0]?.query).toContain('language = $2');
    expect(calls[0]?.query).toContain('jurisdiction = $3');
  });

  /**
   * The metadata is caller-controlled in principle, and a key that is not a
   * column would make the query fail — so an unknown key is ignored rather
   * than interpolated into the SQL.
   */
  it('ignores a filter key that is not a column', async () => {
    const { index, calls } = indexWith([]);
    await index.query([0.1], 5, { language: 'fr', 'x; DROP TABLE statute_provisions': '1' });
    expect(calls[0]?.query).not.toContain('DROP');
    expect(calls[0]?.query).toContain('language = $2');
  });

  it('returns the matches with their scores', async () => {
    const { index } = indexWith([
      { id: 'acts-en-1', score: 0.83 },
      { id: 'acts-en-2', score: 0.71 },
    ]);
    const matches = await index.query([0.1], 5);
    expect(matches.map((m) => m.id)).toEqual(['acts-en-1', 'acts-en-2']);
    expect(matches[0]?.score).toBe(0.83);
  });
});
