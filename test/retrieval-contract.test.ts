import { afterEach, describe, expect, it, vi } from 'vitest';
import { statutesCorpus, VECTOR_FLOOR } from '../src/corpora/adapters';
import { postgresStatutesCorpus, POSTGRES_VECTOR_FLOOR } from '../src/corpora/postgres-adapters';
import type { CorpusContext } from '../src/corpora/types';

afterEach(() => vi.unstubAllGlobals());

function context(score: number, extras: Partial<CorpusContext> = {}) {
  const queries: string[] = [];
  const embedded: string[] = [];
  const nearest: { count: number; filter?: Record<string, string> }[] = [];
  const row = { id: 'provision-1', act: 'Test Act', instrument: 'Test Act', section: '1', text: 'Le règlement sur les dommages.',
    corpus_id: 'statutes-canada', source_url: 'https://laws-lois.justice.gc.ca/test', jurisdiction: 'CA', in_force: true, language: 'fr' };
  const ctx: CorpusContext = {
    fetch, now: () => new Date(), corpusRevision: 'r1',
    db: { prepare(sql) { queries.push(sql); return { bind() { return { async all<T>() { return { results: [row] as T[] }; } }; } }; } },
    embedQuery: async (question) => { embedded.push(question); return [0.1]; },
    vector: { async query(_vector, count, filter) { nearest.push({ count, filter }); return [{ id: row.id, score, metadata: {} }]; } },
    ...extras,
  };
  return { ctx, queries, embedded, nearest };
}

function authority(needsProvincial: number) {
  const send = vi.fn(async () => new Response(JSON.stringify({ answers: {
    c0: { type: 'noul', noul: 1 }, any_relevant: { type: 'noul', noul: 1 },
    needs_federal_statute: { type: 'noul', noul: 1 }, needs_provincial: { type: 'noul', noul: needsProvincial },
    needs_court_decision: { type: 'noul', noul: 0 }, needs_foreign_law: { type: 'noul', noul: 0 },
    is_not_law: { type: 'noul', noul: 0 }, asks_published_figure: { type: 'noul', noul: 0 },
  } })));
  vi.stubGlobal('fetch', send);
  return send;
}

describe.each([
  { name: 'Worker', corpus: statutesCorpus, floor: VECTOR_FLOOR },
  { name: 'Postgres', corpus: postgresStatutesCorpus, floor: POSTGRES_VECTOR_FLOOR },
])('$name statute retrieval contract', ({ corpus, floor }) => {
  it('refuses weak neighbours before reading rows and never falls back to lexical results', async () => {
    const fixture = context(floor - 0.01);
    expect(await corpus.retrieve({ topic: 'unrelated' }, fixture.ctx)).toEqual([]);
    expect(fixture.queries).toEqual([]);
    expect(fixture.nearest).toHaveLength(1);
  });

  it('keeps provincial-law authority refusals even when vector relevance is high', async () => {
    const send = authority(1);
    const fixture = context(0.99, { jev: { key: 'test' } });
    expect(await corpus.retrieve({ topic: 'provincial tenancy rights' }, fixture.ctx)).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(fixture.nearest[0]?.count).toBe(250);
    expect(fixture.queries.every((sql) => !sql.includes('LIKE'))).toBe(true);
  });

  it('embeds the topic alone and applies accent-folded keyword constraints after retrieval', async () => {
    const fixture = context(0.99);
    const items = await corpus.retrieve({ topic: 'dommages', keywords: ['reglement'], language: 'fr', limit: 2 }, fixture.ctx);
    expect(items.map((item) => item.id)).toEqual(['provision-1']);
    expect(fixture.embedded).toEqual(['dommages']);
    expect(fixture.nearest).toEqual([{ count: 8, filter: { language: 'fr' } }]);
    expect(await corpus.retrieve({ topic: 'dommages', keywords: ['absent'], language: 'fr' }, fixture.ctx)).toEqual([]);
  });

  it('preserves successful cached decisions without a second model, embedding or vector call', async () => {
    const send = authority(0);
    const entries = new Map<string, unknown>();
    const fixture = context(0.2, { jev: { key: 'test' }, cache: {
      get: async (key) => entries.get(key) ?? null,
      put: async (key, value) => { entries.set(key, value); },
    } });
    const first = await corpus.retrieve({ topic: 'dommages', language: 'fr' }, fixture.ctx);
    expect(first).toHaveLength(1);
    expect(await corpus.retrieve({ topic: 'dommages', language: 'fr' }, fixture.ctx)).toEqual(first);
    expect(send).toHaveBeenCalledTimes(1);
    expect(fixture.embedded).toHaveLength(1);
    expect(fixture.nearest).toHaveLength(1);
  });
});

it('calibrates fallback acceptance in each backend\'s score scale', async () => {
  expect(await statutesCorpus.retrieve({ topic: 'dommages' }, context(0.7).ctx)).toHaveLength(1);
  expect(await postgresStatutesCorpus.retrieve({ topic: 'dommages' }, context(0.7).ctx)).toEqual([]);
});
