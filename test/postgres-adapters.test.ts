import { describe, expect, it } from 'vitest';
import { postgresStatutesCorpus } from '../src/corpora/postgres-adapters';
import { postgresCorpusDatabase } from '../src/corpora/postgres-driver';
import type { CorpusContext } from '../src/corpora/types';

/**
 * The statutes corpus, on Postgres.
 *
 * The two schemas differ in more than names, so the test says what the
 * Postgres adapter must actually produce: the other table, the other column
 * for the instrument, a boolean for in force, and the language lens as a
 * filter.
 */
function contextWith(rows: Record<string, unknown>[]): {
  ctx: CorpusContext;
  calls: { query: string; values: unknown[] }[];
} {
  const calls: { query: string; values: unknown[] }[] = [];
  const db = postgresCorpusDatabase({
    unsafe(query: string, values?: unknown[]) {
      calls.push({ query, values: values ?? [] });
      return Promise.resolve(rows);
    },
  });
  return { ctx: { db, fetch, now: () => new Date() }, calls };
}

describe('the statutes corpus on Postgres', () => {
  it('reads the Postgres table, and the instrument column is named instrument', async () => {
    const { ctx, calls } = contextWith([]);
    await postgresStatutesCorpus.retrieve({ act: 'Labour Act', section: '1' }, ctx);
    expect(calls[0]?.query).toContain('FROM statute_provisions');
    expect(calls[0]?.query).toContain('instrument');
    expect(calls[0]?.query).not.toContain('statute_sections');
  });

  it('filters on the language, as a lens', async () => {
    const { ctx, calls } = contextWith([]);
    await postgresStatutesCorpus.retrieve({ act: 'Labour Act', section: '1', language: 'fr' }, ctx);
    // The driver has already translated the placeholders, so the query that
    // reaches Postgres says `$n`.
    expect(calls[0]?.query).toContain('AND language = $');
    expect(calls[0]?.values).toContain('fr');
  });

  it('keeps exact citations usable without semantic backends and does not manufacture a lexical fallback', async () => {
    const { ctx, calls } = contextWith([]);
    await postgresStatutesCorpus.retrieve({ topic: 'labour' }, ctx);
    expect(calls).toHaveLength(0);

    const citation = contextWith([]);
    await postgresStatutesCorpus.retrieve(
      { act: 'Code canadien du travail', section: '210' },
      citation.ctx,
    );
    expect(citation.calls[0]?.query).not.toContain('AND in_force');
    // A citation is resolved exactly, and exactly means one row.
    expect(citation.calls[0]?.query).toContain('WHERE instrument = $1 AND section = $2');
  });

  it('maps a row to an item, and reads the boolean', async () => {
    const { ctx } = contextWith([
      {
        id: 'acts-fr-334424',
        corpus_id: 'statutes-canada',
        instrument: 'Code canadien du travail',
        citation: 'L.C. 1992, c. 22',
        section: '210',
        status: 'in-force',
        heading: 'Droit',
        text: 'Un employeur fournit…',
        source_url: 'https://example.test/210',
        jurisdiction: 'CA',
        in_force: true,
        language: 'fr',
      },
    ]);
    const items = await postgresStatutesCorpus.retrieve(
      { act: 'Code canadien du travail', section: '210' },
      ctx,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('acts-fr-334424');
    expect(items[0]?.title).toBe('Code canadien du travail s. 210 — Droit');
    expect(items[0]?.language).toBe('fr');
    expect(items[0]?.extra?.inForce).toBe(true);
  });
});
