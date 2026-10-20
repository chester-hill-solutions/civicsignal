import { describe, expect, it } from 'vitest';
import { buildBrief, buildSentimentSeries } from '../src/routes/brief';
import {
  GDELT,
  HANSARD_FEDERAL,
  NEWS_CANADA,
  STATUTES_CANADA,
} from '../src/corpora/policies';
import type { Corpus, CorpusContext } from '../src/corpora/types';
import type { RawCorpusItem } from '../src/licensing';

const ctx: CorpusContext = { fetch: globalThis.fetch, now: () => new Date('2026-10-20T00:00:00Z') };

function fake(
  id: string,
  policy: typeof STATUTES_CANADA,
  items: RawCorpusItem[],
): Corpus {
  return {
    id,
    policy,
    supports: () => true,
    retrieve: async () => items,
  };
}

describe('brief assembly', () => {
  const corpora: Corpus[] = [
    fake('statutes-canada', STATUTES_CANADA, [
      {
        corpusId: 'statutes-canada',
        kind: 'statute',
        id: 's1',
        title: 'Residential Tenancies Act s. 1',
        body: 'Definitions.',
        citationUrl: 'https://example.invalid/s1',
        source: 'Government of Canada',
      },
    ]),
    fake('hansard-federal', HANSARD_FEDERAL, [
      {
        corpusId: 'hansard-federal',
        kind: 'debate',
        id: 'h1',
        title: 'Debate on housing',
        body: 'THE FULL SPEECH, WHICH MUST NOT BE EMITTED',
        excerpt: 'We must build more homes.',
        citationUrl: 'https://example.invalid/h1',
        publishedAt: '2026-05-04',
        source: 'House of Commons',
      },
    ]),
    fake('news-canada', NEWS_CANADA, [
      {
        corpusId: 'news-canada',
        kind: 'news',
        id: 'n1',
        title: 'City announces housing plan',
        excerpt: 'A lede that must not be emitted',
        body: 'Article body that must not be emitted',
        citationUrl: 'https://example.invalid/n1',
        publishedAt: '2026-05-04',
        source: 'Some Outlet',
      },
    ]),
    fake('gdelt', GDELT, [
      {
        corpusId: 'gdelt',
        kind: 'event',
        id: 'g1',
        title: 'Housing coverage',
        citationUrl: 'https://example.invalid/g1',
        publishedAt: '2026-05-04',
        source: 'GDELT Project',
        sentiment: { score: -1.5 },
      },
      {
        corpusId: 'gdelt',
        kind: 'event',
        id: 'g2',
        title: 'More housing coverage',
        citationUrl: 'https://example.invalid/g2',
        publishedAt: '2026-05-05',
        source: 'GDELT Project',
        sentiment: { score: 0.5 },
      },
    ]),
  ];

  it('joins every corpus that can answer the query', async () => {
    const brief = await buildBrief({ topic: 'housing' }, ctx, corpora);
    // 1 from the Canadian news wire + 2 from the global monitor.
    expect(brief.news).toHaveLength(3);
    expect(brief.debate).toHaveLength(1);
    expect(brief.legislation).toHaveLength(1);
    expect(brief.bills).toHaveLength(0);
  });

  it('enforces each corpus licence inside the assembled brief', async () => {
    const brief = await buildBrief({ topic: 'housing' }, ctx, corpora);
    const debate = brief.debate[0]!;
    expect(debate.body).toBeUndefined();
    expect(debate.excerpt).toBe('We must build more homes.');
    expect(debate.redistribution).toBe('cite-only');

    const news = brief.news.find((n) => n.corpusId === 'news-canada')!;
    expect(news.excerpt).toBeUndefined();
    expect(news.body).toBeUndefined();
  });

  it('reports which corpora contributed and under which regime', async () => {
    const brief = await buildBrief({ topic: 'housing' }, ctx, corpora);
    const ids = brief.coverage.map((c) => c.corpusId).sort();
    expect(ids).toEqual(['gdelt', 'hansard-federal', 'news-canada', 'statutes-canada']);
    const hansard = brief.coverage.find((c) => c.corpusId === 'hansard-federal')!;
    expect(hansard.redistribution).toBe('cite-only');
  });

  it('carries the attribution of every corpus that contributed', async () => {
    const brief = await buildBrief({ topic: 'housing' }, ctx, corpora);
    expect(brief.attribution.length).toBe(4);
    expect(brief.attribution.some((a) => a.includes('Open Government Licence'))).toBe(true);
    expect(brief.attribution.some((a) => a.includes('Crown copyright'))).toBe(true);
  });

  it('builds a daily tone series and its mean', async () => {
    const brief = await buildBrief({ topic: 'housing' }, ctx, corpora);
    expect(brief.sentiment.series).toHaveLength(2);
    expect(brief.sentiment.series[0]).toEqual({ date: '2026-05-04', score: -1.5, count: 1 });
    expect(brief.sentiment.mean).toBe(-0.5);
    expect(brief.sentiment.volume).toBe(2);
  });

  it('omits a section on request', async () => {
    const brief = await buildBrief({ topic: 'housing', exclude: ['debate'] }, ctx, corpora);
    expect(brief.debate).toHaveLength(0);
    expect(brief.legislation).toHaveLength(1);
  });

  it('places a cited provision first, ahead of the search ranking', async () => {
    const statute: Corpus = {
      id: 'statutes-canada',
      policy: STATUTES_CANADA,
      supports: () => true,
      retrieve: async (query) => {
        const rows: RawCorpusItem[] = [
          {
            corpusId: 'statutes-canada',
            kind: 'statute',
            id: 's210',
            title: 'Canada Labour Code s.210',
            body: 'The cited provision.',
            citationUrl: 'https://example.invalid/s210',
            source: 'Government of Canada',
            extra: { act: 'Canada Labour Code', section: '210' },
          },
          {
            corpusId: 'statutes-canada',
            kind: 'statute',
            id: 's246',
            title: 'Canada Labour Code s.246',
            body: 'Some other provision.',
            citationUrl: 'https://example.invalid/s246',
            source: 'Government of Canada',
            extra: { act: 'Canada Labour Code', section: '246' },
          },
        ];
        return query.act ? rows.filter((r) => r.extra?.['act'] === query.act) : rows;
      },
    };
    const brief = await buildBrief(
      { topic: 'Canada Labour Code', citation: { act: 'Canada Labour Code', section: '210' } },
      ctx,
      [statute],
    );
    expect(brief.citation?.resolved).toBe(true);
    expect(brief.citation?.item?.id).toBe('s210');
    expect(brief.legislation[0]?.id).toBe('s210');
  });

  it('reports a citation that names a section the instrument does not have', async () => {
    const brief = await buildBrief(
      { topic: 'Canada Labour Code', citation: { act: 'Canada Labour Code', section: '999' } },
      ctx,
      [],
    );
    expect(brief.citation?.resolved).toBe(false);
    expect(brief.citation?.item).toBeNull();
  });

  it('returns an explicit empty brief rather than an error for an unknown corpus', async () => {
    const brief = await buildBrief({ topic: 'housing' }, ctx, []);
    expect(brief.news).toHaveLength(0);
    expect(brief.coverage).toHaveLength(0);
    expect(brief.sentiment.mean).toBeNull();
  });
});

describe('sentiment series', () => {
  it('averages tone within a day and sorts by date', () => {
    const items: RawCorpusItem[] = [
      { corpusId: 'gdelt', kind: 'event', id: 'a', title: 'a', citationUrl: 'x', source: 's', publishedAt: '2026-02-02', sentiment: { score: 2 } },
      { corpusId: 'gdelt', kind: 'event', id: 'b', title: 'b', citationUrl: 'x', source: 's', publishedAt: '2026-01-01', sentiment: { score: 1 } },
      { corpusId: 'gdelt', kind: 'event', id: 'c', title: 'c', citationUrl: 'x', source: 's', publishedAt: '2026-01-01', sentiment: { score: 3 } },
    ];
    const series = buildSentimentSeries(items);
    expect(series).toEqual([
      { date: '2026-01-01', score: 2, count: 2 },
      { date: '2026-02-02', score: 2, count: 1 },
    ]);
  });

  it('ignores items with no tone or no date', () => {
    const items: RawCorpusItem[] = [
      { corpusId: 'gdelt', kind: 'event', id: 'a', title: 'a', citationUrl: 'x', source: 's' },
      { corpusId: 'gdelt', kind: 'event', id: 'b', title: 'b', citationUrl: 'x', source: 's', sentiment: { score: 1 } },
    ];
    expect(buildSentimentSeries(items)).toEqual([]);
  });
});
