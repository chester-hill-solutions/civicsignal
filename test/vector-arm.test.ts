import { describe, expect, it } from 'vitest';
import { statutesCorpus } from '../src/corpora/adapters';
import type { CorpusContext } from '../src/corpora/types';
import type { VectorMatch } from '@chester-hill-solutions/corpus';

/**
 * The vector arm.
 *
 * This is the arm the product was measured on: over 36 questions, vector
 * search found 14 of 18 ordinary-language questions against the keyword
 * baseline's 3, and its MRR was 0.617 against 0.310. So it is the arm the
 * product should use, and the lexical path is the fallback.
 *
 * The test is here because the arm is easy to write in a way that looks right
 * and is not: the language has to reach the *index* as a filter rather than
 * being applied afterwards, and the rows have to come back in the order the
 * index ranked them.
 */

interface Recorded {
  sql: string;
  binds: unknown[];
}

function fakeDb(rows: Record<string, unknown>[]): { db: CorpusContext['db']; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    db: {
      prepare(sql: string) {
        const call: Recorded = { sql, binds: [] };
        calls.push(call);
        return {
          bind(...values: unknown[]) {
            call.binds = values;
            return {
              async all<T = unknown>() {
                return { results: rows as T[] };
              },
            };
          },
        };
      },
    },
  };
}

function row(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    corpus_id: 'statutes-canada',
    act: 'Competition Act',
    citation: 'C-34',
    section: '36',
    status: 'in-force',
    heading: 'Recovery of damages',
    text: '(1) Any person who has suffered loss or damage…',
    source_url: `https://laws-lois.justice.gc.ca/en/acts/C-34/section-36.html#${id}`,
    jurisdiction: 'CA',
    in_force: 1,
    topics: null,
    language: 'en',
    ...overrides,
  };
}

/** An index that answers with the matches it was given, and records the filter. */
function fakeIndex(matches: VectorMatch[]): {
  index: NonNullable<CorpusContext['vector']>;
  filters: (Record<string, string> | undefined)[];
  vectors: number[][];
} {
  const filters: (Record<string, string> | undefined)[] = [];
  const vectors: number[][] = [];
  return {
    filters,
    vectors,
    index: {
      async query(vector: number[], _topK: number, filter?: Record<string, string>) {
        vectors.push(vector);
        filters.push(filter);
        return matches;
      },
    },
  };
}

function ctx(
  db: CorpusContext['db'],
  extra: Partial<CorpusContext> = {},
): CorpusContext {
  return { db, fetch: globalThis.fetch, now: () => new Date('2026-10-20T00:00:00Z'), ...extra };
}

describe('the vector arm', () => {
  it('is used when the deployment has an index and an embedder', async () => {
    const { db, calls } = fakeDb([row('acts-en-c-34-36')]);
    const index = fakeIndex([{ id: 'acts-en-c-34-36', score: 0.9, metadata: {} }]);
    const items = await statutesCorpus.retrieve(
      { topic: 'recovery of damages' },
      ctx(db, { vector: index.index, embedQuery: async () => [0.1, 0.2] }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('acts-en-c-34-36');
    // The lexical path was not taken: there is no LIKE in the SQL.
    expect(calls[0]!.sql).not.toContain('LIKE');
  });

  it('embeds the question and asks the index', async () => {
    const { db } = fakeDb([row('acts-en-c-34-36')]);
    const index = fakeIndex([{ id: 'acts-en-c-34-36', score: 0.9, metadata: {} }]);
    const asked: string[] = [];
    await statutesCorpus.retrieve(
      { topic: 'recovery of damages', keywords: ['compensation'] },
      ctx(db, {
        vector: index.index,
        embedQuery: async (text: string) => {
          asked.push(text);
          return [0.1, 0.2];
        },
      }),
    );
    expect(asked[0]).toContain('recovery of damages');
    expect(asked[0]).toContain('compensation');
    expect(index.vectors).toHaveLength(1);
  });

  /**
   * The language is a filter on the index, not a filter afterwards. The two
   * official versions of a provision are separate rows, so a French question
   * that competes with the English rows for a place in the top k gets half the
   * top k back in the wrong language.
   */
  it('filters the index on the language', async () => {
    const { db } = fakeDb([row('acts-fr-c-34-36', { language: 'fr' })]);
    const index = fakeIndex([{ id: 'acts-fr-c-34-36', score: 0.9, metadata: {} }]);
    await statutesCorpus.retrieve(
      { topic: 'recouvrement des dommages', language: 'fr' },
      ctx(db, { vector: index.index, embedQuery: async () => [0.1] }),
    );
    expect(index.filters[0]).toEqual({ language: 'fr' });
  });

  it('does not filter the index when no language was asked for', async () => {
    const { db } = fakeDb([row('acts-en-c-34-36')]);
    const index = fakeIndex([{ id: 'acts-en-c-34-36', score: 0.9, metadata: {} }]);
    await statutesCorpus.retrieve(
      { topic: 'damages' },
      ctx(db, { vector: index.index, embedQuery: async () => [0.1] }),
    );
    expect(index.filters[0]).toBeUndefined();
  });

  it('returns the rows in the order the index ranked them', async () => {
    const { db } = fakeDb([row('b'), row('a'), row('c')]);
    const index = fakeIndex([
      { id: 'c', score: 0.9, metadata: {} },
      { id: 'a', score: 0.8, metadata: {} },
      { id: 'b', score: 0.7, metadata: {} },
    ]);
    const items = await statutesCorpus.retrieve(
      { topic: 'damages' },
      ctx(db, { vector: index.index, embedQuery: async () => [0.1] }),
    );
    expect(items.map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  /**
   * A row the index names but the database does not have is a row that has
   * been removed since the index was written. It is skipped, not returned
   * empty.
   */
  it('skips a row the database no longer has', async () => {
    const { db } = fakeDb([row('a')]);
    const index = fakeIndex([
      { id: 'gone', score: 0.9, metadata: {} },
      { id: 'a', score: 0.8, metadata: {} },
    ]);
    const items = await statutesCorpus.retrieve(
      { topic: 'damages' },
      ctx(db, { vector: index.index, embedQuery: async () => [0.1] }),
    );
    expect(items.map((i) => i.id)).toEqual(['a']);
  });

  /**
   * "The index has nothing" and "this deployment cannot search" are different
   * answers, and only one of them is a fallback.
   */
  it('falls back to the lexical path when there is no index', async () => {
    const { db, calls } = fakeDb([row('acts-en-c-34-36')]);
    const items = await statutesCorpus.retrieve(
      { topic: 'damages' },
      ctx(db),
    );
    expect(calls[0]!.sql).toContain('LIKE');
    expect(items.length).toBeGreaterThan(0);
  });

  it('falls back to the lexical path when there is no embedder', async () => {
    const { db, calls } = fakeDb([row('acts-en-c-34-36')]);
    const index = fakeIndex([]);
    await statutesCorpus.retrieve(
      { topic: 'damages' },
      ctx(db, { vector: index.index }),
    );
    expect(calls[0]!.sql).toContain('LIKE');
  });

  /**
   * A citation is a key, not a similarity. Resolving it structurally is exact
   * where a ranking can only be close, so the vector arm never sees one.
   */
  it('never sends a citation to the vector arm', async () => {
    const { db } = fakeDb([row('acts-en-c-34-36')]);
    const index = fakeIndex([{ id: 'acts-en-c-34-36', score: 0.9, metadata: {} }]);
    await statutesCorpus.retrieve(
      { act: 'Competition Act', section: '36' },
      ctx(db, { vector: index.index, embedQuery: async () => [0.1] }),
    );
    expect(index.vectors).toHaveLength(0);
  });
});
