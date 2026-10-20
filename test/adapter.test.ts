import { describe, expect, it } from 'vitest';
import { statutesCorpus } from '../src/corpora/adapters';
import type { CorpusContext } from '../src/corpora/types';

/**
 * The citation path, through the real adapter.
 *
 * This test exists because the citation path was broken and nothing noticed.
 *
 * The adapter's text-search path needs a topic or keywords and returns nothing
 * without them — which is right for a search. The citation path was calling it
 * with an act and a section and no keywords, so it returned an empty array, so
 * the citation never resolved, so the response said the citation had not
 * resolved.
 *
 * The brief's own test did not catch it because it fakes the corpus. It proved
 * the orchestration works, not that the adapter answers. A test that replaces the
 * thing most likely to break is a test of the plumbing, not of the product.
 *
 * So this one goes through the real adapter, with a fake database that records
 * the SQL it was asked for.
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

function ctx(db: CorpusContext['db']): CorpusContext {
  return { db, fetch: globalThis.fetch, now: () => new Date('2026-10-20T00:00:00Z') };
}

const PROVISION = {
  id: 'acts-en-c-34-36',
  corpus_id: 'statutes-canada',
  act: 'Competition Act',
  citation: 'C-34',
  section: '36',
  status: 'in-force',
  heading: 'Recovery of damages',
  text: '(1) Any person who has suffered loss or damage as a result of conduct contrary to Part VI…',
  source_url: 'https://laws-lois.justice.gc.ca/en/acts/C-34/section-36.html',
  jurisdiction: 'CA',
  in_force: 1,
  topics: null,
};

describe('the citation path', () => {
  it('resolves a provision by its instrument and its label', async () => {
    const { db, calls } = fakeDb([PROVISION]);
    const items = await statutesCorpus.retrieve(
      { act: 'Competition Act', section: '36', limit: 10 },
      ctx(db),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('acts-en-c-34-36');
    expect(items[0]!.title).toContain('Competition Act s. 36');
    expect(items[0]!.body).toContain('loss or damage');
    expect(calls[0]!.sql).toContain('act = ? AND section = ?');
    expect(calls[0]!.binds).toEqual(['Competition Act', '36', '10']);
  });

  /**
   * A citation carries no topic and no keywords. If the adapter's text path is
   * used for it, the search finds nothing and the citation silently fails — which
   * is what happened.
   */
  it('does not require a topic or keywords', async () => {
    const { db } = fakeDb([PROVISION]);
    const items = await statutesCorpus.retrieve({ act: 'Competition Act', section: '36' }, ctx(db));
    expect(items).toHaveLength(1);
  });

  it('is answerable, so the corpus claims it can answer one', () => {
    expect(statutesCorpus.supports({ act: 'Competition Act', section: '36' })).toBe(true);
  });

  /**
   * The useful answer to "what does section 9 say" is sometimes "it was repealed
   * in 2010". A corpus that cannot say so has thrown the answer away.
   */
  it('returns a repealed provision rather than nothing', async () => {
    const { db, calls } = fakeDb([
      {
        ...PROVISION,
        id: 'acts-en-a-1-9',
        act: 'Privacy Act',
        section: '9',
        status: 'repealed',
        in_force: 0,
        text: '[Repealed, SOR/2010-20]',
      },
    ]);
    const items = await statutesCorpus.retrieve(
      { act: 'Privacy Act', section: '9' },
      ctx(db),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.extra?.['status']).toBe('repealed');
    expect(items[0]!.extra?.['inForce']).toBe(false);
    // It must not be filtered out by the in-force condition.
    expect(calls[0]!.sql).not.toContain('in_force = 1');
  });

  it('does not fall into the text path for a citation', async () => {
    const { db, calls } = fakeDb([PROVISION]);
    await statutesCorpus.retrieve({ act: 'Competition Act', section: '36' }, ctx(db));
    expect(calls[0]!.sql).not.toContain('search_text LIKE');
  });

  it('still searches on the text path when there is a topic', async () => {
    const { db, calls } = fakeDb([PROVISION]);
    await statutesCorpus.retrieve({ topic: 'housing' }, ctx(db));
    expect(calls[0]!.sql).toContain('search_text LIKE');
    expect(calls[0]!.sql).toContain('in_force = 1');
  });

  it('returns nothing when there is neither a topic nor a citation', async () => {
    const { db, calls } = fakeDb([PROVISION]);
    const items = await statutesCorpus.retrieve({}, ctx(db));
    expect(items).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('ignores a section with no instrument, because it means nothing alone', async () => {
    const { db, calls } = fakeDb([PROVISION]);
    const items = await statutesCorpus.retrieve({ section: '36' }, ctx(db));
    expect(items).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

/**
 * The language lens.
 *
 * The corpus holds Canada's statutes in both official languages, and the two
 * versions of a provision are **different rows with different identifiers**.
 * So the language is not a presentation detail — it decides which rows are the
 * answer.
 *
 * Without the filter, one provision is two answers and the caller cannot say
 * which one they meant. And an English question would have its top k filled
 * with French rows, because the French version of a provision is about as
 * similar to an English question as the English version is — and there are two
 * of them competing.
 */
describe('the language lens', () => {
  const FRENCH_PROVISION = {
    ...PROVISION,
    id: 'acts-fr-c-34-36',
    act: 'Loi sur la concurrence',
    citation: 'C-34',
    section: '36',
    heading: 'Recouvrement des dommages-intérêts',
    text: "(1) Toute personne qui a subi un préjudice par suite d'un comportement contraire…",
    source_url: 'https://laws-lois.justice.gc.ca/fr/lois/C-34/section-36.html',
    language: 'fr',
  };

  it('filters the citation path on the language', async () => {
    const { db, calls } = fakeDb([PROVISION]);
    await statutesCorpus.retrieve(
      { act: 'Competition Act', section: '36', language: 'fr' },
      ctx(db),
    );
    expect(calls[0]!.sql).toContain('language = ?');
    expect(calls[0]!.binds).toContain('fr');
  });

  it('filters the text path on the language', async () => {
    const { db, calls } = fakeDb([PROVISION]);
    await statutesCorpus.retrieve({ topic: 'housing', language: 'fr' }, ctx(db));
    expect(calls[0]!.sql).toContain('language = ?');
    expect(calls[0]!.binds).toContain('fr');
  });

  it('does not filter when no language was asked for', async () => {
    const { db, calls } = fakeDb([PROVISION]);
    await statutesCorpus.retrieve({ act: 'Competition Act', section: '36' }, ctx(db));
    expect(calls[0]!.sql).not.toContain('language = ?');
    // The citation and the limit, and nothing else.
    expect(calls[0]!.binds.slice(0, 2)).toEqual(['Competition Act', '36']);
    expect(calls[0]!.binds).not.toContain('fr');
    expect(calls[0]!.binds).not.toContain('en');
  });

  it('says which language each result is in', async () => {
    const { db } = fakeDb([FRENCH_PROVISION]);
    const items = await statutesCorpus.retrieve(
      { act: 'Loi sur la concurrence', section: '36', language: 'fr' },
      ctx(db),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.language).toBe('fr');
    expect(items[0]!.id).toBe('acts-fr-c-34-36');
  });

  /**
   * The caller may ask for the language in a form the corpus does not use.
   * `fr-CA` is the same language, and a filter that did not recognise it would
   * silently return nothing — which reads as "the corpus has no such
   * provision" rather than "the filter did not match".
   */
  it('accepts a full language tag', async () => {
    const { db, calls } = fakeDb([PROVISION]);
    await statutesCorpus.retrieve(
      { act: 'Competition Act', section: '36', language: 'fr-CA' },
      ctx(db),
    );
    expect(calls[0]!.binds).toContain('fr-ca');
  });
});
