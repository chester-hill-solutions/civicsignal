import { describe, expect, it } from 'vitest';
import { statutesCorpus, VECTOR_FLOOR } from '../src/corpora/adapters';
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

  /**
   * The keywords are a **constraint**, not part of the question.
   *
   * A topic and keywords are two different things a caller can say, and they
   * used to be glued together into the text that gets embedded — which makes
   * the model rank by both at once, with the caller's own words dominating the
   * statute's. Now the topic is embedded and the keywords filter the result.
   */
  it('embeds the topic, and the keywords filter the result', async () => {
    const { db } = fakeDb([
      row('acts-en-c-34-36', { text: 'the recovery of damages as compensation' }),
      row('acts-en-c-34-37', { text: '(1) Any person who has suffered loss or damage…' }),
    ]);
    const index = fakeIndex([
      { id: 'acts-en-c-34-36', score: 0.9, metadata: {} },
      { id: 'acts-en-c-34-37', score: 0.8, metadata: {} },
    ]);
    const asked: string[] = [];
    const items = await statutesCorpus.retrieve(
      { topic: 'recovery of damages', keywords: ['compensation'] },
      ctx(db, {
        vector: index.index,
        embedQuery: async (text: string) => {
          asked.push(text);
          return [0.1, 0.2];
        },
      }),
    );

    expect(asked[0]).toBe('recovery of damages');
    // Only the provision that actually contains the word.
    expect(items.map((item) => item.id)).toEqual(['acts-en-c-34-36']);
  });

  /**
   * The keywords are folded the way the corpus's own text is folded.
   *
   * Half the corpus is French, and the person typing the query has no accent
   * key: `reglement` has to find `règlement`, or the constraint drops the
   * provision the caller was looking for.
   */
  it('folds the keywords, so an unaccented one still matches', async () => {
    const { db } = fakeDb([row('acts-fr-x-1', { text: 'Le présent règlement s’applique' })]);
    const index = fakeIndex([{ id: 'acts-fr-x-1', score: 0.9, metadata: {} }]);
    const items = await statutesCorpus.retrieve(
      { topic: 'application du reglement', keywords: ['reglement'], language: 'fr' },
      ctx(db, { vector: index.index, embedQuery: async () => [0.1] }),
    );

    expect(items.map((item) => item.id)).toEqual(['acts-fr-x-1']);
  });

  /**
   * A filter applied to exactly `limit` rows can empty a result the corpus can
   * answer, so the index is asked for more than it needs.
   */
  it('asks the index for more than it needs when it will filter', async () => {
    const { db } = fakeDb([row('acts-en-c-34-36', { text: 'compensation' })]);
    const index = fakeIndex([{ id: 'acts-en-c-34-36', score: 0.9, metadata: {} }]);
    const asked: number[] = [];
    const askedIndex = {
      async query(_vector: number[], topK: number) {
        asked.push(topK);
        return [{ id: 'acts-en-c-34-36', score: 0.9, metadata: {} }];
      },
    };
    await statutesCorpus.retrieve(
      { topic: 'recovery of damages', keywords: ['compensation'], limit: 5 },
      ctx(db, { vector: askedIndex, embedQuery: async () => [0.1] }),
    );
    expect(asked[0]).toBe(20);
  });

  /**
   * With no topic, the keywords **are** the question — there is nothing else to
   * embed — and they are not also a filter, because filtering a search by the
   * words it searched for is a no-op that costs a scan.
   */
  it('embeds the keywords when there is no topic', async () => {
    const { db } = fakeDb([row('acts-en-c-34-36')]);
    const index = fakeIndex([{ id: 'acts-en-c-34-36', score: 0.9, metadata: {} }]);
    const asked: string[] = [];
    const items = await statutesCorpus.retrieve(
      { keywords: ['compensation'] },
      ctx(db, {
        vector: index.index,
        embedQuery: async (text: string) => {
          asked.push(text);
          return [0.1];
        },
      }),
    );

    expect(asked[0]).toBe('compensation');
    expect(items).toHaveLength(1);
  });

  it('embeds the question and asks the index', async () => {
    const { db } = fakeDb([row('acts-en-c-34-36')]);
    const index = fakeIndex([{ id: 'acts-en-c-34-36', score: 0.9, metadata: {} }]);
    const asked: string[] = [];
    await statutesCorpus.retrieve(
      { topic: 'recovery of damages' },
      ctx(db, {
        vector: index.index,
        embedQuery: async (text: string) => {
          asked.push(text);
          return [0.1, 0.2];
        },
      }),
    );
    expect(asked[0]).toContain('recovery of damages');
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
  /**
   * **The lexical path is gone, and these are the three cases that used to
   * reach it.**
   *
   * It ran when the vector arm returned nothing — a condition a vector search
   * cannot produce, because it returns the k it was asked for however little
   * those k have to do with the question. Measured, it was not worth
   * resurrecting: of the fourteen questions the vector arm misses at rank 5,
   * the keyword arm finds one in its top 5, and on the concept half — the half
   * the vector arm exists for — it finds none.
   *
   * So a deployment with no index and no embedder cannot answer a text search
   * at all, and says so by returning nothing rather than by scanning a quarter
   * of a million provisions one `LIKE` at a time.
   */
  it('answers nothing at all when there is no index and no embedder', async () => {
    const { db, calls } = fakeDb([row('acts-en-c-34-36')]);
    const items = await statutesCorpus.retrieve({ topic: 'damages' }, ctx(db));

    expect(items).toEqual([]);
    // Not one statement: there is no query to run.
    expect(calls).toHaveLength(0);
  });

  it('answers nothing at all when there is no embedder', async () => {
    const { db, calls } = fakeDb([row('acts-en-c-34-36')]);
    const index = fakeIndex([{ id: 'acts-en-c-34-36', score: 0.9, metadata: {} }]);
    const items = await statutesCorpus.retrieve(
      { topic: 'damages' },
      ctx(db, { vector: index.index }),
    );

    expect(items).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  /**
   * **The floor.** A vector search always returns the k it was asked for, so
   * "nothing found" is something it cannot say — and the product's answer to a
   * question the corpus cannot answer used to be fifty provisions about
   * something else. What it can say is that the best match is not close enough
   * to answer with, and that is the refusal the caller turns into "I don't
   * have information on that".
   */
  it('answers nothing when the best match is below the floor', async () => {
    const { db, calls } = fakeDb([row('acts-en-c-34-36')]);
    const index = fakeIndex([{ id: 'acts-en-c-34-36', score: VECTOR_FLOOR - 0.01, metadata: {} }]);
    const items = await statutesCorpus.retrieve(
      { topic: 'the weather in Ottawa' },
      ctx(db, { vector: index.index, embedQuery: async () => [0.1] }),
    );

    expect(items).toEqual([]);
    // Before the rows are fetched: a question the corpus cannot answer costs
    // one index query and no database reads.
    expect(calls).toHaveLength(0);
  });

  it('answers when the best match is at the floor', async () => {
    const { db } = fakeDb([row('acts-en-c-34-36')]);
    const index = fakeIndex([{ id: 'acts-en-c-34-36', score: VECTOR_FLOOR, metadata: {} }]);
    const items = await statutesCorpus.retrieve(
      { topic: 'recovery of damages' },
      ctx(db, { vector: index.index, embedQuery: async () => [0.1] }),
    );

    expect(items).toHaveLength(1);
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
