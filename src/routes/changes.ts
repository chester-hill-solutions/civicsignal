import { STATUTES_CANADA } from '../corpora/policies';
import { UnsupportedCoverageError } from '../corpora/registry';
import type { CorpusContext } from '../corpora/types';
import { RequestInputError } from '../http';

export interface ChangesRequest {
  after?: number;
  limit?: number;
  since?: string;
  until?: string;
  change?: 'added' | 'changed' | 'removed';
}

export interface StatuteChange {
  id: number;
  corpusId: string;
  change: 'added' | 'changed' | 'removed';
  rowId: string;
  instrument: string;
  citation: string;
  section: string;
  heading: string | null;
  status: string | null;
  sourceUrl: string | null;
  occurredAt: string;
  recordedAt: string;
}

export interface ChangesResponse {
  corpusId: string;
  items: StatuteChange[];
  count: number;
  after: number;
  nextAfter: number;
  hasMore: boolean;
  window: { since: string | null; until: string | null };
  provenance: { source: string; licence: string; licenceUrl: string; attribution: string; note: string };
}

function integer(value: unknown, name: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RequestInputError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

/** Accept real calendar dates or explicit UTC timestamps; reject Date.parse rollovers. */
function date(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value)) {
    throw new RequestInputError(`${name} must be YYYY-MM-DD or a UTC ISO timestamp.`);
  }
  const instant = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== value.slice(0, 10) ||
      (value.length > 10 && instant.toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z'))) {
    throw new RequestInputError(`${name} must be a valid calendar date or UTC timestamp.`);
  }
  return value;
}

export function validateChangesRequest(request: ChangesRequest): Required<Pick<ChangesRequest, 'after' | 'limit'>> & ChangesRequest {
  const after = integer(request.after, 'after', 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = integer(request.limit, 'limit', 1, 100, 50);
  const since = date(request.since, 'since');
  const until = date(request.until, 'until');
  if (since && until && Date.parse(since) > Date.parse(until)) {
    throw new RequestInputError('since must not be later than until.');
  }
  if (request.change !== undefined && !['added', 'changed', 'removed'].includes(request.change)) {
    throw new RequestInputError('change must be added, changed or removed.');
  }
  return { after, limit, since, until, change: request.change };
}

export function parseChangesQuery(url: URL): ChangesRequest {
  const known = new Set(['after', 'limit', 'since', 'until', 'change', 'corpus']);
  for (const [name] of url.searchParams) {
    if (!known.has(name)) throw new RequestInputError(`Unsupported change-feed parameter: ${name}.`);
    if (url.searchParams.getAll(name).length > 1) throw new RequestInputError(`Supply ${name} once.`);
  }
  if (url.searchParams.has('corpus') && url.searchParams.get('corpus') !== STATUTES_CANADA.id) {
    throw new UnsupportedCoverageError('The v1 change feed covers only statutes-canada.');
  }
  const number = (name: string): number | undefined => {
    const value = url.searchParams.get(name);
    if (value === null) return undefined;
    if (!/^\d+$/.test(value)) throw new RequestInputError(`${name} must be an integer.`);
    return Number(value);
  };
  return validateChangesRequest({ after: number('after'), limit: number('limit'),
    since: url.searchParams.get('since') ?? undefined, until: url.searchParams.get('until') ?? undefined,
    change: (url.searchParams.get('change') ?? undefined) as ChangesRequest['change'] });
}

function sourceUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A keyset feed of observed ingestion events. Text and free-form summaries are never selected. */
export async function readStatuteChanges(request: ChangesRequest, ctx: CorpusContext): Promise<ChangesResponse> {
  const query = validateChangesRequest(request);
  if (!ctx.db) throw new UnsupportedCoverageError('The statute change-feed database is not configured.');
  const clauses = ['corpus_id = ?', 'id > ?'];
  const binds: unknown[] = [STATUTES_CANADA.id, query.after];
  if (query.since) {
    clauses.push('julianday(occurred_at) >= julianday(?)');
    binds.push(query.since);
  }
  if (query.until) {
    if (query.until.length === 10) {
      clauses.push("julianday(occurred_at) < julianday(?, '+1 day')");
    } else {
      clauses.push('julianday(occurred_at) <= julianday(?)');
    }
    binds.push(query.until);
  }
  if (query.change) { clauses.push('change = ?'); binds.push(query.change); }
  const result = await ctx.db.prepare(`SELECT id, corpus_id, change, row_id, instrument, citation, section,
    heading, status, source_url, occurred_at, recorded_at FROM corpus_changes
    WHERE ${clauses.join(' AND ')} ORDER BY id ASC LIMIT ?`).bind(...binds, query.limit + 1).all<Record<string, unknown>>();
  const rows = result.results ?? [];
  const items = rows.slice(0, query.limit).map((row): StatuteChange => {
    const id = Number(row['id']);
    if (!Number.isSafeInteger(id) || id <= query.after ||
        !['added', 'changed', 'removed'].includes(String(row['change']))) {
      throw new Error('The stored change-feed row is invalid.');
    }
    return {
      id, corpusId: STATUTES_CANADA.id, change: row['change'] as StatuteChange['change'], rowId: String(row['row_id']),
      instrument: String(row['instrument']), citation: String(row['citation']), section: String(row['section']),
      heading: row['heading'] == null ? null : String(row['heading']), status: row['status'] == null ? null : String(row['status']),
      sourceUrl: sourceUrl(row['source_url']), occurredAt: String(row['occurred_at']), recordedAt: String(row['recorded_at']),
    };
  });
  return {
    corpusId: STATUTES_CANADA.id, items, count: items.length, after: query.after,
    nextAfter: items.at(-1)?.id ?? query.after, hasMore: rows.length > query.limit,
    window: { since: query.since ?? null, until: query.until ?? null },
    provenance: { source: STATUTES_CANADA.publisher, licence: STATUTES_CANADA.licence,
      licenceUrl: STATUTES_CANADA.licenceUrl, attribution: STATUTES_CANADA.attribution,
      note: 'Observed corpus additions, modifications and removals. occurredAt is the source revision date; recordedAt is ingestion time. Events do not establish when a legal change took effect. No full provision text is included.' },
  };
}
