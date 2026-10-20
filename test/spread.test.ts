import { describe, expect, it } from 'vitest';
import { buildBrief } from '../src/routes/brief';
import { GDELT, NEWS_CANADA } from '../src/corpora/policies';
import type { Corpus, CorpusContext } from '../src/corpora/types';
import type { RawCorpusItem } from '@chester-hill-solutions/corpus';

const ctx: CorpusContext = { fetch: globalThis.fetch, now: () => new Date('2026-10-20T00:00:00Z') };

/**
 * A fake geography-bearing corpus that honours the jurisdiction filter, so the
 * difference between a scoped brief and the spread can actually be observed.
 */
function geoCorpus(items: RawCorpusItem[]): Corpus {
  return {
    id: NEWS_CANADA.id,
    policy: NEWS_CANADA,
    supports: () => true,
    retrieve: async (query) => {
      if (!query.jurisdiction) return items;
      return items.filter((i) => i.jurisdiction === query.jurisdiction);
    },
  };
}

function newsItem(
  id: string,
  jurisdiction: string | undefined,
  riding: string | undefined,
): RawCorpusItem {
  return {
    corpusId: NEWS_CANADA.id,
    kind: 'news',
    id,
    title: `${id} headline`,
    citationUrl: `https://example.invalid/${id}`,
    publishedAt: '2026-05-04',
    source: 'Some Outlet',
    jurisdiction,
    extra: riding ? { riding } : undefined,
  };
}

const ITEMS: RawCorpusItem[] = [
  newsItem('a', 'ON', '35047'),
  newsItem('b', 'ON', '35048'),
  newsItem('c', 'ON', '35049'),
  newsItem('d', 'BC', '24001'),
  newsItem('e', 'QC', undefined),
];

describe('geography as framing', () => {
  const corpora: Corpus[] = [geoCorpus(ITEMS), { ...geoCorpus(ITEMS), id: GDELT.id, policy: GDELT }];

  it('narrows the brief to the scope the caller asked for', async () => {
    const brief = await buildBrief(
      { topic: 'housing', scope: { type: 'jurisdiction', code: 'ON' } },
      ctx,
      corpora,
    );
    // Three Ontario items per corpus, twice.
    expect(brief.news).toHaveLength(6);
    expect(brief.news.every((n) => n.jurisdiction === 'ON')).toBe(true);
    expect(brief.scope).toEqual({ type: 'jurisdiction', code: 'ON' });
  });

  it('reports the spread across the whole country whatever scope was asked for', async () => {
    const scoped = await buildBrief(
      { topic: 'housing', scope: { type: 'jurisdiction', code: 'ON' } },
      ctx,
      corpora,
    );
    const unscoped = await buildBrief({ topic: 'housing' }, ctx, corpora);

    // The scoped brief is about Ontario; the spread is about everywhere.
    const scopedJurisdictions = scoped.spread.byJurisdiction.map((b) => b.code).sort();
    expect(scopedJurisdictions).toEqual(['BC', 'ON', 'QC']);
    expect(scoped.spread.byJurisdiction.find((b) => b.code === 'ON')?.count).toBe(6);
    expect(unscoped.spread.byJurisdiction.find((b) => b.code === 'ON')?.count).toBe(6);
  });

  it('buckets the spread by riding where the corpus can attribute one', async () => {
    const brief = await buildBrief({ topic: 'housing' }, ctx, corpora);
    const byRiding = brief.spread.byRiding;
    // Equal counts, so the tiebreak is the code.
    expect(byRiding.map((b) => b.code)).toEqual(['24001', '35047', '35048', '35049']);
    expect(byRiding.find((b) => b.code === '35047')?.count).toBe(2);
    expect(byRiding.find((b) => b.code === '24001')?.count).toBe(2);
  });

  it('reports how much of the underlying set could be attributed', async () => {
    const brief = await buildBrief({ topic: 'housing' }, ctx, corpora);
    // Ten items across the two corpora; every one carries a jurisdiction.
    expect(brief.spread.coverage.total).toBe(10);
    expect(brief.spread.coverage.attributed).toBe(10);
  });

  it('leaves a topic-only brief unscoped', async () => {
    const brief = await buildBrief({ topic: 'housing' }, ctx, corpora);
    expect(brief.scope).toEqual({ type: 'topic' });
    expect(brief.news).toHaveLength(10);
  });

  it('lets an explicit jurisdiction on the request win over the scope', async () => {
    const brief = await buildBrief(
      { topic: 'housing', jurisdiction: 'BC', scope: { type: 'jurisdiction', code: 'ON' } },
      ctx,
      corpora,
    );
    expect(brief.news.every((n) => n.jurisdiction === 'BC')).toBe(true);
  });
});
