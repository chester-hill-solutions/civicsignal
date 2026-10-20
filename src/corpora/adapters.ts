import type { RawCorpusItem } from '../licensing';
import {
  BILLS_CANADA,
  GDELT,
  HANSARD_FEDERAL,
  NEWS_CANADA,
  STATUTES_CANADA,
  STATUTES_ONTARIO,
} from './policies';
import { escapeLike, likePatterns, resolveLimit, type Corpus, type CorpusContext, type CorpusQuery } from './types';

/**
 * Corpus adapters.
 *
 * Each adapter reads from a D1 table populated by an ingest job. They deliberately
 * return raw items — the licence policy is applied afterwards, by `emitCorpusItem`,
 * so no adapter can widen its own permissions.
 */

/** Runs a LIKE match against a normalised token column. */
const TOKEN_MATCH = "search_text LIKE ? ESCAPE '\\'";

function tokenClause(patterns: string[]): { sql: string; binds: string[] } {
  if (patterns.length === 0) return { sql: '', binds: [] };
  return {
    sql: ` AND (${patterns.map(() => TOKEN_MATCH).join(' OR ')})`,
    binds: patterns,
  };
}

function dateClause(query: CorpusQuery): { sql: string; binds: string[] } {
  const binds: string[] = [];
  const parts: string[] = [];
  if (query.since) {
    parts.push('published_at >= ?');
    binds.push(query.since);
  }
  if (query.until) {
    parts.push('published_at <= ?');
    binds.push(query.until);
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', binds };
}

async function queryRows(
  ctx: CorpusContext,
  sql: string,
  binds: string[],
): Promise<Record<string, unknown>[]> {
  if (!ctx.db) return [];
  const stmt = ctx.db.prepare(sql);
  const result = await stmt.bind(...binds).all<Record<string, unknown>>();
  return result.results ?? [];
}

/* -------------------------------------------------------------------------- */
/* Statutes — Open Government Licence Canada. Full text may be emitted.        */
/* -------------------------------------------------------------------------- */

export const statutesCorpus: Corpus = {
  id: STATUTES_CANADA.id,
  policy: STATUTES_CANADA,
  supports(query) {
    return Boolean(query.topic || (query.keywords && query.keywords.length > 0));
  },
  async retrieve(query: CorpusQuery, ctx: CorpusContext): Promise<RawCorpusItem[]> {
    const patterns = likePatterns(query);
    if (patterns.length === 0) return [];
    const { sql: tok, binds: tokBinds } = tokenClause(patterns);
    const jur = query.jurisdiction
      ? { sql: ' AND jurisdiction = ?', binds: [query.jurisdiction.toUpperCase()] }
      : { sql: '', binds: [] as string[] };
    // An exact instrument filter, used when a citation names the Act.
    const act = query.act ? { sql: ' AND act = ?', binds: [query.act] } : { sql: '', binds: [] as string[] };

    const rows = await queryRows(
      ctx,
      `SELECT id, corpus_id, act, section, heading, text, source_url, jurisdiction, in_force, topics
         FROM statute_sections
        WHERE in_force = 1${tok}${jur.sql}${act.sql}
        ORDER BY act, section
        LIMIT ?`,
      [...tokBinds, ...jur.binds, ...act.binds, String(resolveLimit(query.limit))],
    );

    return rows.map((row) => ({
      corpusId: String(row['corpus_id'] ?? STATUTES_CANADA.id),
      kind: 'statute' as const,
      id: String(row['id']),
      title: `${String(row['act'])} s. ${String(row['section'])}${row['heading'] ? ` — ${String(row['heading'])}` : ''}`,
      body: row['text'] === null || row['text'] === undefined ? undefined : String(row['text']),
      citationUrl: String(row['source_url']),
      source: STATUTES_CANADA.publisher,
      jurisdiction: row['jurisdiction'] === null ? undefined : String(row['jurisdiction']),
      topics: splitTopics(row['topics']),
      extra: { act: String(row['act']), section: String(row['section']), inForce: true },
    }));
  },
};

/* -------------------------------------------------------------------------- */
/* Hansard — Crown copyright. Cite-only: excerpt + citation, never the corpus.  */
/* -------------------------------------------------------------------------- */

export const hansardCorpus: Corpus = {
  id: HANSARD_FEDERAL.id,
  policy: HANSARD_FEDERAL,
  supports(query) {
    return Boolean(query.topic || (query.keywords && query.keywords.length > 0));
  },
  async retrieve(query: CorpusQuery, ctx: CorpusContext): Promise<RawCorpusItem[]> {
    const patterns = likePatterns(query);
    if (patterns.length === 0) return [];
    const { sql: tok, binds: tokBinds } = tokenClause(patterns);
    const { sql: dates, binds: dateBinds } = dateClause(query);

    const rows = await queryRows(
      ctx,
      `SELECT id, corpus_id, speaker, party, sitting_date, excerpt, source_url, topics
         FROM hansard_speeches
        WHERE 1 = 1${tok}${dates}
        ORDER BY sitting_date DESC
        LIMIT ?`,
      [...tokBinds, ...dateBinds, String(resolveLimit(query.limit))],
    );

    return rows.map((row) => ({
      corpusId: String(row['corpus_id'] ?? HANSARD_FEDERAL.id),
      kind: 'debate' as const,
      id: String(row['id']),
      title: `${String(row['speaker'])} in the House of Commons`,
      // The full speech never reaches this adapter; the ingest job stores only a
      // short excerpt, and the policy caps what may be emitted.
      excerpt: row['excerpt'] === null ? undefined : String(row['excerpt']),
      citationUrl: String(row['source_url']),
      publishedAt: row['sitting_date'] === null ? undefined : String(row['sitting_date']),
      source: HANSARD_FEDERAL.publisher,
      topics: splitTopics(row['topics']),
      extra: { speaker: String(row['speaker']), party: row['party'] ? String(row['party']) : undefined },
    }));
  },
};

/* -------------------------------------------------------------------------- */
/* News — per-publisher terms. Metadata only: headline, outlet, timestamp, link. */
/* -------------------------------------------------------------------------- */

export const newsCorpus: Corpus = {
  id: NEWS_CANADA.id,
  policy: NEWS_CANADA,
  supports(query) {
    return Boolean(query.topic || (query.keywords && query.keywords.length > 0));
  },
  async retrieve(query: CorpusQuery, ctx: CorpusContext): Promise<RawCorpusItem[]> {
    const patterns = likePatterns(query);
    if (patterns.length === 0) return [];
    const { sql: tok, binds: tokBinds } = tokenClause(patterns);
    const { sql: dates, binds: dateBinds } = dateClause(query);
    const jur = query.jurisdiction
      ? { sql: ' AND jurisdiction = ?', binds: [query.jurisdiction.toUpperCase()] }
      : { sql: '', binds: [] as string[] };

    const rows = await queryRows(
      ctx,
      `SELECT id, corpus_id, title, outlet, published_at, url, jurisdiction, riding, topics
         FROM news_items
        WHERE 1 = 1${tok}${dates}${jur.sql}
        ORDER BY published_at DESC
        LIMIT ?`,
      [...tokBinds, ...dateBinds, ...jur.binds, String(resolveLimit(query.limit))],
    );

    return rows.map((row) => ({
      corpusId: String(row['corpus_id'] ?? NEWS_CANADA.id),
      kind: 'news' as const,
      id: String(row['id']),
      title: String(row['title']),
      citationUrl: String(row['url']),
      publishedAt: row['published_at'] === null ? undefined : String(row['published_at']),
      source: String(row['outlet']),
      jurisdiction: row['jurisdiction'] === null ? undefined : String(row['jurisdiction']),
      topics: splitTopics(row['topics']),
      extra: row['riding'] === null ? undefined : { riding: String(row['riding']) },
    }));
  },
};

/* -------------------------------------------------------------------------- */
/* GDELT — global press monitor. Metadata only; carries tone for sentiment.     */
/* -------------------------------------------------------------------------- */

export const gdeltCorpus: Corpus = {
  id: GDELT.id,
  policy: GDELT,
  supports(query) {
    return Boolean(query.topic || (query.keywords && query.keywords.length > 0));
  },
  async retrieve(query: CorpusQuery, ctx: CorpusContext): Promise<RawCorpusItem[]> {
    const patterns = likePatterns(query);
    if (patterns.length === 0) return [];
    const { sql: tok, binds: tokBinds } = tokenClause(patterns);
    const { sql: dates, binds: dateBinds } = dateClause(query);

    const rows = await queryRows(
      ctx,
      `SELECT id, corpus_id, title, url, published_at, tone, country, topics
         FROM gdelt_events
        WHERE 1 = 1${tok}${dates}
        ORDER BY published_at DESC
        LIMIT ?`,
      [...tokBinds, ...dateBinds, String(resolveLimit(query.limit))],
    );

    return rows.map((row) => ({
      corpusId: String(row['corpus_id'] ?? GDELT.id),
      kind: 'event' as const,
      id: String(row['id']),
      title: String(row['title']),
      citationUrl: String(row['url']),
      publishedAt: row['published_at'] === null ? undefined : String(row['published_at']),
      source: 'GDELT Project',
      jurisdiction: row['country'] === null ? undefined : String(row['country']),
      topics: splitTopics(row['topics']),
      sentiment:
        row['tone'] === null || row['tone'] === undefined
          ? undefined
          : { score: Number(row['tone']) },
    }));
  },
};

/* -------------------------------------------------------------------------- */
/* Bills — status and identifiers are facts; bill text is not republished.      */
/* -------------------------------------------------------------------------- */

export const billsCorpus: Corpus = {
  id: BILLS_CANADA.id,
  policy: BILLS_CANADA,
  supports(query) {
    return Boolean(query.topic || (query.keywords && query.keywords.length > 0));
  },
  async retrieve(query: CorpusQuery, ctx: CorpusContext): Promise<RawCorpusItem[]> {
    const patterns = likePatterns(query);
    if (patterns.length === 0) return [];
    const { sql: tok, binds: tokBinds } = tokenClause(patterns);

    const rows = await queryRows(
      ctx,
      `SELECT id, corpus_id, number, title, sponsor, stage, introduced_at, source_url, jurisdiction, topics
         FROM bills
        WHERE 1 = 1${tok}
        ORDER BY introduced_at DESC
        LIMIT ?`,
      [...tokBinds, String(resolveLimit(query.limit))],
    );

    return rows.map((row) => ({
      corpusId: String(row['corpus_id'] ?? BILLS_CANADA.id),
      kind: 'bill' as const,
      id: String(row['id']),
      title: `${String(row['number'])} — ${String(row['title'])}`,
      citationUrl: String(row['source_url']),
      publishedAt: row['introduced_at'] === null ? undefined : String(row['introduced_at']),
      source: BILLS_CANADA.publisher,
      jurisdiction: row['jurisdiction'] === null ? undefined : String(row['jurisdiction']),
      topics: splitTopics(row['topics']),
      extra: {
        number: String(row['number']),
        sponsor: row['sponsor'] ? String(row['sponsor']) : undefined,
        stage: row['stage'] ? String(row['stage']) : undefined,
      },
    }));
  },
};

/* -------------------------------------------------------------------------- */

export function splitTopics(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parts = value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return parts.length ? parts : undefined;
}

export { escapeLike };
