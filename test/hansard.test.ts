import { emitCorpusItem } from '@chester-hill-solutions/corpus';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importHansardSitting } from '../scripts/hansard-local';
import { getHansardSpeech, hansardCorpus } from '../src/corpora/adapters';
import { HANSARD_FEDERAL } from '../src/corpora/policies';
import { normalizeForSearch } from '../src/text';
import { testD1 } from './helpers/d1';
import sitting from './fixtures/hansard/sitting.json';

describe('local Hansard speech retrieval', () => {
  let store: ReturnType<typeof testD1>;
  const transcript = 'https://www.ourcommons.ca/DocumentViewer/en/45-1/house/sitting-123/hansard';
  const outbound = vi.fn<typeof fetch>(() => Promise.reject(new Error('Unexpected network request')));

  beforeEach(() => {
    store = testD1();
    outbound.mockClear();
  });
  afterEach(() => {
    store.close();
    expect(outbound).not.toHaveBeenCalled();
  });

  function insert(id: string, excerpt: string, {
    date = '2026-10-20',
    indexed = excerpt,
    url = `${transcript}#${id}`,
    corpusId = HANSARD_FEDERAL.id,
  } = {}) {
    store.sqlite.prepare(`INSERT INTO hansard_speeches
      (id, corpus_id, speaker, sitting_date, excerpt, source_url, search_text)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, corpusId, 'Synthetic Speaker', date, excerpt, url, normalizeForSearch(indexed));
  }

  function context() {
    return { db: store.db, fetch: outbound, now: () => new Date('2026-10-21') };
  }

  function retrieve(query: Parameters<typeof hansardCorpus.retrieve>[0]) {
    return hansardCorpus.retrieve(query, context());
  }

  it('returns the original excerpt and official intervention link for the requested sitting date', async () => {
    insert('fixture-turn-1', 'Le règlement sur le logement est à l’étude.');
    insert('fixture-turn-2', 'Le règlement est à l’étude.', { date: '2026-10-21' });

    const rows = await retrieve({ topic: 'REGLEMENT', since: '2026-10-20', until: '2026-10-20' });
    expect(rows).toHaveLength(1);
    const speech = emitCorpusItem(hansardCorpus.policy, rows[0]!);
    expect(speech).toMatchObject({
      id: 'fixture-turn-1',
      kind: 'debate',
      publishedAt: '2026-10-20',
      extra: { speaker: 'Synthetic Speaker', sittingDate: '2026-10-20' },
      excerpt: 'Le règlement sur le logement est à l’étude.',
      citationUrl: `${transcript}#fixture-turn-1`,
      redistribution: 'cite-only',
    });
    expect(speech.body).toBeUndefined();
    expect(speech.attribution).toContain('House of Commons of Canada');
  });

  it('fills the requested limit with citable matches after skipping unusable index hits', async () => {
    const cap = HANSARD_FEDERAL.excerptMaxChars;
    insert('fixture-turn-1', 'The topic is housing. ' + 'x'.repeat(cap));
    insert('fixture-turn-2', 'The topic is housing.', { corpusId: 'hansard-provincial' });
    insert('fixture-turn-3', 'The topic is housing.', { url: 'https://www.ourcommons.ca.example/hansard' });
    insert('fixture-turn-4', 'x'.repeat(cap) + 'housing');
    insert('fixture-turn-5', 'Very different remarks.', { indexed: 'housing' });

    const rows = await retrieve({ keywords: ['housing'], limit: 1 });
    expect(rows.map(({ id }) => id)).toEqual(['fixture-turn-1']);
    const speech = emitCorpusItem(hansardCorpus.policy, rows[0]!);
    expect(speech.excerpt).toContain('The topic is housing.');
    expect(speech.excerpt!.length).toBeLessThanOrEqual(cap);
    expect(speech.body).toBeUndefined();
  });

  it('matches wildcard characters literally in both the index and the passage', async () => {
    insert('fixture-turn-1', 'The target is 5% of the budget.');
    insert('fixture-turn-2', 'The target is 50 units.');

    expect((await retrieve({ topic: '5%' })).map(({ id }) => id)).toEqual(['fixture-turn-1']);
    expect(await retrieve({ topic: 'missing phrase' })).toEqual([]);
  });

  it('imports both editions, preserves their IDs on replay, and opens the exact search result', async () => {
    const ids = ['hansard:en:fixture-123:fixture-turn-1', 'hansard:fr:fixture-123:fixture-turn-1'];
    expect(importHansardSitting(store.sqlite, sitting)).toEqual(ids);
    expect(importHansardSitting(store.sqlite, sitting)).toEqual(ids);

    expect((await retrieve({ topic: 'reg' })).map(({ id }) => id).sort()).toEqual(ids);
    expect((await retrieve({ topic: 'reg', language: 'en' })).map(({ id }) => id)).toEqual([ids[0]]);
    const [matched] = await retrieve({ topic: 'reg', language: 'fr' });
    expect(matched).toMatchObject({
      id: ids[1],
      language: 'fr',
      extra: { sittingId: 'fixture-123', interventionId: 'fixture-turn-1' },
    });
    expect(await getHansardSpeech(ids[1]!, context())).toEqual(matched);
    expect(await getHansardSpeech('fixture-turn-1', context())).toBeUndefined();

    const excerpt = 'Cette correction remplace le passage précédent.';
    const corrected = { ...sitting, speeches: sitting.speeches.map((entry) =>
      entry.language === 'fr' ? { ...entry, excerpt } : entry) };
    expect(importHansardSitting(store.sqlite, corrected)).toEqual(ids);
    expect(await retrieve({ topic: 'reg', language: 'fr' })).toEqual([]);
    expect(await getHansardSpeech(ids[1]!, context())).toMatchObject({ id: ids[1], excerpt });
  });

  it('refuses a sitting with an overlong or unanchored excerpt record before writing rows', async () => {
    const [valid, other] = sitting.speeches;
    for (const malformed of [
      { ...other, excerpt: 'x'.repeat(HANSARD_FEDERAL.excerptMaxChars + 1) },
      { ...other, citationUrl: transcript },
      { ...other, body: 'Full source text is outside the excerpt record.' },
      valid,
    ]) {
      expect(() => importHansardSitting(store.sqlite, { ...sitting, speeches: [valid, malformed] })).toThrow();
      expect(await retrieve({ topic: 'reg' })).toEqual([]);
    }
  });

  it('rolls back the sitting if a later speech ID belongs to another corpus', async () => {
    const conflicting = 'hansard:fr:fixture-123:fixture-turn-1';
    insert(conflicting, 'Other corpus fixture', { corpusId: 'hansard-provincial' });

    expect(() => importHansardSitting(store.sqlite, sitting)).toThrow('another corpus');
    expect(await getHansardSpeech('hansard:en:fixture-123:fixture-turn-1', context())).toBeUndefined();
    expect(store.sqlite.prepare('SELECT excerpt FROM hansard_speeches WHERE id = ?').get(conflicting))
      .toMatchObject({ excerpt: 'Other corpus fixture' });
  });
});
