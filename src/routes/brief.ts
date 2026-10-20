import type { CorpusItem, CorpusPolicy, RawCorpusItem } from '../licensing';
import { POLICIES_BY_ID } from '../corpora/policies';

import { gdeltCorpus } from '../corpora/adapters';
import { BRIEF_SECTIONS, CORPUSES } from '../corpora/registry';
import type { Corpus, CorpusContext, CorpusQuery } from '../corpora/types';

export function policyMap(): Map<string, CorpusPolicy> {
  return POLICIES_BY_ID;
}

export interface BriefRequest extends CorpusQuery {
  /** Restrict the brief to specific corpora. */
  include?: string[];
  /** Sections to omit. */
  exclude?: string[];
}

export interface SentimentPoint {
  date: string;
  score: number;
  count: number;
}

export interface BriefResponse {
  topic: string;
  generatedAt: string;
  jurisdiction: string | null;
  riding: string | null;
  window: { since: string | null; until: string | null };
  news: CorpusItem[];
  debate: CorpusItem[];
  legislation: CorpusItem[];
  bills: CorpusItem[];
  sentiment: {
    series: SentimentPoint[];
    mean: number | null;
    volume: number;
    note: string;
  };
  coverage: {
    corpusId: string;
    title: string;
    count: number;
    redistribution: CorpusPolicy['redistribution'];
    licence: string;
  }[];
  attribution: string[];
}

const SENTIMENT_NOTE =
  'Tone is GDELT\'s document-tone metric for the matching window, averaged by day. It is a measure of tone in coverage, not of public opinion.';

/**
 * Assemble a brief across every corpus that can answer the query.
 *
 * Raw items are collected per corpus, then sanitised against that corpus's policy.
 * A corpus that cannot answer the query is reported as absent rather than silently
 * returning nothing, so a caller can tell "no results" from "not covered".
 */
export async function buildBrief(
  request: BriefRequest,
  ctx: CorpusContext,
  /** Corpus set override. Production passes nothing; tests pass fakes. */
  corpora: Corpus[] = CORPUSES,
): Promise<BriefResponse> {
  const query: CorpusQuery = {
    topic: request.topic,
    keywords: request.keywords,
    jurisdiction: request.jurisdiction,
    riding: request.riding,
    since: request.since,
    until: request.until,
    limit: request.limit,
  };

  const wanted = new Set(request.include ?? []);
  const excluded = new Set(request.exclude ?? []);
  const policies = policyMap();
  const byId = new Map(corpora.map((c) => [c.id, c]));

  const sectionItems: Record<string, CorpusItem[]> = {};
  const rawByCorpus = new Map<string, RawCorpusItem[]>();

  for (const section of BRIEF_SECTIONS) {
    if (excluded.has(section.key)) {
      sectionItems[section.key] = [];
      continue;
    }
    const items: CorpusItem[] = [];
    for (const corpusId of section.corpusIds) {
      if (wanted.size > 0 && !wanted.has(corpusId)) continue;
      const corpus = byId.get(corpusId);
      if (!corpus) continue;
      if (!corpus.supports(query)) continue;
      const raw = await corpus.retrieve(query, ctx);
      rawByCorpus.set(corpusId, raw);
      const policy = policies.get(corpusId);
      if (!policy) continue;
      for (const item of raw) {
        items.push(sanitize(policy, item));
      }
    }
    sectionItems[section.key] = items;
  }

  const sentimentRaw = rawByCorpus.get(gdeltCorpus.id) ?? [];
  const series = buildSentimentSeries(sentimentRaw);
  const scores = series.map((p) => p.score);
  const mean = scores.length
    ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 1000) / 1000
    : null;

  const coverage = [...rawByCorpus.entries()]
    .map(([corpusId, raw]) => {
      const policy = policies.get(corpusId);
      return {
        corpusId,
        title: policy?.title ?? corpusId,
        count: raw.length,
        redistribution: policy?.redistribution ?? 'metadata-only',
        licence: policy?.licence ?? 'unknown',
      };
    })
    .filter((c) => c.count > 0);

  const attribution = [...new Set(coverage.map((c) => {
    const policy = policies.get(c.corpusId);
    return policy?.attribution ?? c.corpusId;
  }))];

  return {
    topic: request.topic ?? '',
    generatedAt: ctx.now().toISOString(),
    jurisdiction: request.jurisdiction ?? null,
    riding: request.riding ?? null,
    window: { since: request.since ?? null, until: request.until ?? null },
    news: sectionItems['news'] ?? [],
    debate: sectionItems['debate'] ?? [],
    legislation: sectionItems['legislation'] ?? [],
    bills: sectionItems['bills'] ?? [],
    sentiment: { series, mean, volume: sentimentRaw.length, note: SENTIMENT_NOTE },
    coverage,
    attribution,
  };
}

/**
 * Local sanitiser mirroring `emitCorpusItem`, kept here so the brief never holds a
 * policy-less item even for a moment. Kept deliberately small and mirrored by
 * `src/licensing.ts`; the tests assert both stay in step.
 */
function sanitize(policy: CorpusPolicy, raw: RawCorpusItem): CorpusItem {
  const item: CorpusItem = {
    corpusId: raw.corpusId,
    kind: raw.kind,
    id: raw.id,
    title: raw.title,
    citationUrl: raw.citationUrl,
    publishedAt: raw.publishedAt,
    source: raw.source,
    language: raw.language,
    jurisdiction: raw.jurisdiction,
    topics: raw.topics,
    entities: raw.entities,
    sentiment: raw.sentiment,
    extra: raw.extra,
    redistribution: policy.redistribution,
    attribution: policy.attribution,
  };
  if (policy.allowFullText && raw.body !== undefined) item.body = raw.body;
  if (raw.excerpt !== undefined && policy.excerptMaxChars > 0) {
    item.excerpt =
      raw.excerpt.length <= policy.excerptMaxChars
        ? raw.excerpt
        : `${raw.excerpt.slice(0, policy.excerptMaxChars - 1).trimEnd()}…`;
  }
  return item;
}

export function buildSentimentSeries(items: RawCorpusItem[]): SentimentPoint[] {
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const item of items) {
    const score = item.sentiment?.score;
    if (score === undefined || !item.publishedAt) continue;
    const day = item.publishedAt.slice(0, 10);
    const bucket = byDay.get(day) ?? { sum: 0, count: 0 };
    bucket.sum += score;
    bucket.count += 1;
    byDay.set(day, bucket);
  }
  return [...byDay.entries()]
    .map(([date, b]) => ({
      date,
      score: Math.round((b.sum / b.count) * 1000) / 1000,
      count: b.count,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}
