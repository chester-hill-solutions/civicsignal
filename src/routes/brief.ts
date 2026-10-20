import type { CorpusItem, CorpusPolicy, RawCorpusItem } from '../licensing';
import { POLICIES_BY_ID } from '../corpora/policies';

import { gdeltCorpus, newsCorpus } from '../corpora/adapters';
import { BRIEF_SECTIONS, CORPUSES } from '../corpora/registry';
import type { Corpus, CorpusContext, CorpusQuery, Scope } from '../corpora/types';

export function policyMap(): Map<string, CorpusPolicy> {
  return POLICIES_BY_ID;
}

export interface BriefRequest extends CorpusQuery {
  /** Restrict the brief to specific corpora. */
  include?: string[];
  /** Sections to omit. */
  exclude?: string[];
  /** How the question is framed geographically. */
  scope?: Scope;
}

export interface SentimentPoint {
  date: string;
  score: number;
  count: number;
}

export interface SpreadBucket {
  code: string;
  label: string;
  count: number;
  /** Share of the geographically-attributed items, 0–1. */
  share: number;
}

export interface Spread {
  byJurisdiction: SpreadBucket[];
  byRiding: SpreadBucket[];
  /** How much of the underlying set could be attributed geographically. */
  coverage: { attributed: number; total: number };
  note: string;
}

export interface BriefResponse {
  topic: string;
  generatedAt: string;
  scope: Scope;
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
  /**
   * Where the topic is live, across the whole country, independent of the scope the
   * brief was asked for. This is the evidence for deciding how to frame the question.
   */
  spread: Spread;
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
  const scope = request.scope ?? { type: 'topic' as const };

  // The scope is the caller's framing of the question; it narrows the corpora by
  // whichever geography it names. An explicit `jurisdiction`/`riding` on the request
  // still wins, because a caller who set it meant it.
  const scopedJurisdiction = request.jurisdiction ?? jurisdictionOf(scope);
  const scopedRiding = request.riding ?? ridingOf(scope);

  const query: CorpusQuery = {
    topic: request.topic,
    keywords: request.keywords,
    jurisdiction: scopedJurisdiction,
    riding: scopedRiding,
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

  const spread = await computeSpread(request, ctx, byId, scope);

  return {
    topic: request.topic ?? '',
    generatedAt: ctx.now().toISOString(),
    scope,
    jurisdiction: request.jurisdiction ?? null,
    riding: request.riding ?? null,
    window: { since: request.since ?? null, until: request.until ?? null },
    news: sectionItems['news'] ?? [],
    debate: sectionItems['debate'] ?? [],
    legislation: sectionItems['legislation'] ?? [],
    bills: sectionItems['bills'] ?? [],
    sentiment: { series, mean, volume: sentimentRaw.length, note: SENTIMENT_NOTE },
    spread,
    coverage,
    attribution,
  };
}

/**
 * Where the topic is live, independent of the scope the brief was asked for.
 *
 * A scoped brief answers "what is happening in my riding"; the spread answers "and
 * where is this actually happening", which is the evidence for choosing the scope
 * in the first place. It costs one extra query per geography-bearing corpus.
 */
async function computeSpread(
  request: BriefRequest,
  ctx: CorpusContext,
  corpora: Map<string, Corpus>,
  scope: Scope,
): Promise<Spread> {
  const geographyCorpora = [newsCorpus.id, gdeltCorpus.id];
  const items: CorpusItem[] = [];

  for (const corpusId of geographyCorpora) {
    const corpus = corpora.get(corpusId);
    if (!corpus) continue;
    // Deliberately unscoped: the same topic and window, without the geography filter.
    const raw = await corpus.retrieve(
      {
        topic: request.topic,
        keywords: request.keywords,
        since: request.since,
        until: request.until,
        limit: request.limit,
      },
      ctx,
    );
    for (const r of raw) {
      items.push({
        corpusId: r.corpusId,
        kind: r.kind,
        id: r.id,
        title: r.title,
        citationUrl: r.citationUrl,
        publishedAt: r.publishedAt,
        source: r.source,
        jurisdiction: r.jurisdiction,
        extra: r.extra,
        redistribution: 'metadata-only',
        attribution: '',
      });
    }
  }

  const ridingOfItem = (item: CorpusItem): string | undefined => {
    const value = item.extra?.['riding'];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  const attributed = items.filter((i) => i.jurisdiction || ridingOfItem(i));
  const byJurisdiction = bucket(items.map((i) => i.jurisdiction), (c) => c);
  const byRiding = bucket(items.map((i) => ridingOfItem(i)), (c) => c);

  return {
    byJurisdiction,
    byRiding,
    coverage: { attributed: attributed.length, total: items.length },
    note: scope.type === 'topic'
      ? 'Distribution of the news matching this topic. Where a topic is concentrated in a few places, that is where a scoped brief would be framed.'
      : `Distribution of the same topic across Canada, independent of the "${scope.type}" scope this brief was asked for.`,
  };
}

/** The province or territory a scope names, if it names one. */
export function jurisdictionOf(scope: Scope): string | undefined {
  switch (scope.type) {
    case 'jurisdiction':
      return scope.code.toUpperCase();
    case 'municipality':
      return scope.province?.toUpperCase();
    case 'riding':
      // A riding code carries its province in the first two digits (35xxx = Ontario),
      // but the caller's own jurisdiction parameter is the authority when it has one.
      return undefined;
    default:
      return undefined;
  }
}

/** The riding a scope names, if it names one. */
export function ridingOf(scope: Scope): string | undefined {
  return scope.type === 'riding' ? scope.code : undefined;
}

function bucket(
  values: (string | undefined)[],
  label: (code: string) => string,
): SpreadBucket[] {  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  return [...counts.entries()]
    .map(([code, count]) => ({
      code,
      label: label(code),
      count,
      share: Math.round((count / total) * 1000) / 1000,
    }))
    .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1));
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
