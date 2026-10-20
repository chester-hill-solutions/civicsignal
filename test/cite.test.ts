import { describe, expect, it } from 'vitest';
import { citeProvision } from '../src/mcp/cite';
import type { CorpusContext } from '../src/corpora/types';

/**
 * A citation, resolved.
 *
 * This is the path an agent takes when someone asks about a provision by name.
 * It has to be an exact lookup, and it has to say whether the provision is in
 * force — including when it is not, because "it was repealed in 2010" is a
 * better answer than silence.
 *
 * The language matters here more than anywhere else. The two official versions
 * of a provision are separate rows with separate identifiers, so a lookup that
 * does not settle the language returns the wrong one of the two, or both.
 */

/** A fake database that records the SQL it was asked for. */
function fakeDb(rows: Record<string, unknown>[]): { db: CorpusContext['db']; sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    db: {
      prepare(statement: string) {
        sql.push(statement);
        return {
          bind() {
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

const ENGLISH_PROVISION = {
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
  language: 'en',
};

const FRENCH_PROVISION = {
  ...ENGLISH_PROVISION,
  id: 'acts-fr-c-34-36',
  act: 'Loi sur la concurrence',
  heading: 'Recouvrement des dommages-intérêts',
  text: "(1) Toute personne qui a subi un préjudice par suite d'un comportement contraire…",
  source_url: 'https://laws-lois.justice.gc.ca/fr/lois/C-34/section-36.html',
  language: 'fr',
};

describe('a citation, resolved', () => {
  it('finds the provision', async () => {
    const { db } = fakeDb([ENGLISH_PROVISION]);
    const result = await citeProvision({ act: 'Competition Act', section: '36' }, ctx(db));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe('acts-en-c-34-36');
    expect(result.items[0]!.citation).toBe('C-34');
    expect(result.items[0]!.citationUrl).toContain('/en/acts/C-34/');
  });

  it('says whether it is in force', async () => {
    const { db } = fakeDb([ENGLISH_PROVISION]);
    const result = await citeProvision({ act: 'Competition Act', section: '36' }, ctx(db));
    expect(result.items[0]!.inForce).toBe(true);
    expect(result.items[0]!.status).toBe('in-force');
    expect(result.summary).toContain('C-34');
  });

  /**
   * The useful answer to "what does section 9 say" is sometimes "it was
   * repealed in 2010". A corpus that cannot say so has thrown the answer away.
   */
  it('says when it was repealed rather than saying nothing', async () => {
    const { db } = fakeDb([
      {
        ...ENGLISH_PROVISION,
        id: 'acts-en-a-1-9',
        act: 'Privacy Act',
        section: '9',
        status: 'repealed',
        in_force: 0,
        text: '[Repealed, SOR/2010-20]',
      },
    ]);
    const result = await citeProvision({ act: 'Privacy Act', section: '9' }, ctx(db));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.inForce).toBe(false);
    expect(result.items[0]!.status).toBe('repealed');
    expect(result.summary).toContain('not in force');
  });

  it('says plainly when nothing matches', async () => {
    const { db } = fakeDb([]);
    const result = await citeProvision({ act: 'No Such Act', section: '1' }, ctx(db));
    expect(result.items).toHaveLength(0);
    expect(result.summary).toContain('no provision matches');
  });

  /**
   * A French instrument title names a French Act, so the lookup has to be made
   * in French — otherwise it asks the corpus for a French Act's title in the
   * English rows and finds nothing.
   */
  it('reads the language from the instrument title', async () => {
    const { db, sql } = fakeDb([FRENCH_PROVISION]);
    const result = await citeProvision({ act: 'Loi sur la concurrence', section: '36' }, ctx(db));
    expect(result.language).toBe('fr');
    expect(sql[0]).toContain('language = ?');
  });

  it('lets an explicit language win over the title', async () => {
    const { db, sql } = fakeDb([ENGLISH_PROVISION]);
    const result = await citeProvision(
      { act: 'Loi sur la concurrence', section: '36', language: 'en' },
      ctx(db),
    );
    expect(result.language).toBe('en');
    expect(sql[0]).toContain('language = ?');
  });

  it('does not filter when the title says nothing about the language', async () => {
    const { db, sql } = fakeDb([ENGLISH_PROVISION]);
    await citeProvision({ act: 'Competition Act', section: '36' }, ctx(db));
    expect(sql[0]).toContain('language = ?');
  });
});
