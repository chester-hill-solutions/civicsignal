import { attributionFor } from '@chester-hill-solutions/corpus';
import { AccessError } from '../access';
import { CANADA_GAZETTE, HANSARD_FEDERAL, HANSARD_SENATE } from '../corpora/policies';
import type { FeedSource } from '../corpora/source-feed';
import { RequestInputError } from '../http';
import { foldAccents } from '../text';
import {
  SourceFeedQuerySchema, SourceFeedResponseSchema, type SourceFeedRequest, type SourceFeedResponse,
} from './source-feed-contract';

const policy = {
  gazette: CANADA_GAZETTE,
  house: HANSARD_FEDERAL,
  senate: HANSARD_SENATE,
} as const;
interface Cursor {
  version: 1;
  journalId: string;
  source: FeedSource;
  language: 'en' | 'fr';
  part?: 'I' | 'II';
  topic?: string;
  seq: number;
}

interface EditionRow {
  edition_id: string;
  part: string | null;
  publication_date: string;
  observed_at: string;
}

interface EventRow {
  seq: number;
  source: string;
  language: string;
  edition_id: string;
  part: string | null;
  kind: 'added' | 'corrected' | 'removed';
  record_id: string;
  publication_date: string;
  observed_at: string;
  citation_url: string;
  label: string;
  before_match: number;
  after_match: number;
}

interface CursorFilters {
  source: FeedSource;
  language: 'en' | 'fr';
  part?: 'I' | 'II';
  topic?: string;
}

function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeCursor(value: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('invalid base64url');
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!raw || typeof raw !== 'object') throw new Error('invalid cursor');
    const cursor = raw as Partial<Cursor>;
    if (cursor.version !== 1 || typeof cursor.journalId !== 'string' || !/^[0-9a-f]{32}$/u.test(cursor.journalId)
      || !Number.isSafeInteger(cursor.seq) || (cursor.seq ?? -1) < 0
      || !['gazette', 'house', 'senate'].includes(cursor.source ?? '')) throw new Error('invalid cursor');
    if (cursor.language !== 'en' && cursor.language !== 'fr') throw new Error('invalid cursor');
    if (cursor.part !== undefined && cursor.part !== 'I' && cursor.part !== 'II') throw new Error('invalid cursor');
    if (cursor.topic !== undefined && typeof cursor.topic !== 'string') throw new Error('invalid cursor');
    return cursor as Cursor;
  } catch {
    throw new RequestInputError('The source feed cursor is invalid.');
  }
}

function feedFilters(source: FeedSource, query: SourceFeedRequest): CursorFilters {
  return { source, language: query.language,
    ...(query.part === undefined ? {} : { part: query.part }),
    ...(query.topic === undefined ? {} : { topic: foldAccents(query.topic) }) };
}

function assertCursorFilters(cursor: Cursor, filters: CursorFilters): void {
  if (cursor.source !== filters.source || cursor.language !== filters.language || cursor.part !== filters.part
    || cursor.topic !== filters.topic) throw new RequestInputError('The source feed cursor does not match these filters.');
}

export function matchSourceFeed(pathname: string): FeedSource | undefined {
  if (pathname === '/api/gazette/changes') return 'gazette';
  if (pathname === '/api/debates/house/changes') return 'house';
  if (pathname === '/api/debates/senate/changes') return 'senate';
  return undefined;
}

export function parseSourceFeedRequest(source: FeedSource, url: URL): SourceFeedRequest {
  if (url.search.length > 8192) throw new RequestInputError('The source feed query is too long.');
  const input: Record<string, unknown> = {};
  for (const name of url.searchParams.keys()) {
    if (!Object.hasOwn(SourceFeedQuerySchema.shape, name)) throw new RequestInputError('Unsupported source feed query parameter.');
    const values = url.searchParams.getAll(name);
    if (values.length !== 1) throw new RequestInputError(`Supply ${name} once.`);
    const value = values[0] ?? '';
    input[name] = name === 'limit' && /^[0-9]+$/u.test(value) ? Number(value) : value;
  }
  const parsed = SourceFeedQuerySchema.safeParse(input);
  if (!parsed.success) throw new RequestInputError(`${parsed.error.issues[0]?.path.join('.') || 'query'} is invalid.`);
  if (source !== 'gazette' && parsed.data.part !== undefined) throw new RequestInputError('part is only supported for Gazette changes.');
  if (parsed.data.topic !== undefined && !foldAccents(parsed.data.topic)) throw new RequestInputError('topic is invalid.');
  if (parsed.data.cursor !== undefined) assertCursorFilters(decodeCursor(parsed.data.cursor), feedFilters(source, parsed.data));
  return parsed.data;
}

function feedStatements(db: D1Database, source: FeedSource, query: SourceFeedRequest, start: number, topic?: string): D1PreparedStatement[] {
  const partClause = query.part === undefined ? '' : ' AND part = ?';
  const scope = `source = ? AND language = ?${partClause}`;
  const bindings = query.part === undefined ? [source, query.language] : [source, query.language, query.part];
  const scopeSql = `SELECT edition_id, part, publication_date, observed_at FROM source_feed_editions WHERE ${scope} ORDER BY publication_date, edition_id`;
  const highWaterSql = `SELECT COALESCE(MAX(seq), 0) AS high_water FROM source_feed_events WHERE ${scope}`;
  const eventSql = `SELECT seq, edition_id, part, kind, record_id, publication_date, observed_at, citation_url, label,
    ${topic === undefined ? '0' : 'CASE WHEN instr(before_search, ?) > 0 THEN 1 ELSE 0 END'} AS before_match,
    ${topic === undefined ? '0' : 'CASE WHEN instr(after_search, ?) > 0 THEN 1 ELSE 0 END'} AS after_match
    FROM source_feed_events WHERE ${scope} AND seq > ?
    AND seq <= (SELECT COALESCE(MAX(seq), 0) FROM source_feed_events WHERE ${scope})
    ${topic === undefined ? '' : 'AND (instr(before_search, ?) > 0 OR instr(after_search, ?) > 0)'}
    ORDER BY seq ASC LIMIT ?`;
  const eventBindings = topic === undefined ? [...bindings, start, ...bindings, query.limit + 1]
    : [topic, topic, ...bindings, start, ...bindings, topic, topic, query.limit + 1];
  return [
    db.prepare('SELECT journal_id FROM source_feed_identity WHERE singleton = 1'),
    db.prepare(scopeSql).bind(...bindings),
    db.prepare(highWaterSql).bind(...bindings),
    db.prepare(eventSql).bind(...eventBindings),
  ];
}

async function readFeedSnapshot(db: D1Database, source: FeedSource, query: SourceFeedRequest, start: number, topic?: string) {
  let batch: D1Result[];
  try {
    batch = await db.batch(feedStatements(db, source, query, start, topic));
  } catch {
    throw new AccessError('RETRIEVAL_UNAVAILABLE', 'The source feed is unavailable.', 503);
  }
  const [identityResult, editionsResult, highWaterResult, eventRowsResult] = batch;
  const identityRows = identityResult?.results as unknown as Array<{ journal_id?: unknown }> | undefined;
  const journalId = identityRows?.[0]?.journal_id;
  if (typeof journalId !== 'string' || !/^[0-9a-f]{32}$/u.test(journalId)) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'The source feed is unavailable.', 503);
  const editions = (editionsResult?.results ?? []) as unknown as EditionRow[];
  const highWater = Number((highWaterResult?.results?.[0] as { high_water?: number } | undefined)?.high_water ?? 0);
  if (!Number.isSafeInteger(highWater) || highWater < 0) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'The source feed is unavailable.', 503);
  return { journalId, editions, highWater, rows: (eventRowsResult?.results ?? []) as unknown as EventRow[] };
}

function assertFeedCoverage(source: FeedSource, query: SourceFeedRequest, editions: EditionRow[]): void {
  const parts = source === 'gazette' ? query.part === undefined ? ['I', 'II'] : [query.part] : [];
  if (!editions.length || parts.some((part) => !editions.some((edition) => edition.part === part))) {
    throw new AccessError('RETRIEVAL_UNAVAILABLE', 'The requested source feed edition is unavailable.', 503);
  }
}

function emitEvent(row: EventRow, query: SourceFeedRequest): SourceFeedResponse['events'][number] {
  return { id: row.seq, kind: row.kind, recordId: row.record_id, publicationDate: row.publication_date,
    observedAt: row.observed_at, citationUrl: row.citation_url, label: row.label, editionId: row.edition_id,
    ...(row.part === null ? {} : { part: row.part as 'I' | 'II' }),
    ...(query.topic === undefined ? {} : { matches: { before: row.before_match === 1, after: row.after_match === 1 } }),
  };
}

export async function readSourceFeed(db: D1Database, request: { source: FeedSource; query: SourceFeedRequest }): Promise<SourceFeedResponse> {
  const { source, query } = request;
  const filters = feedFilters(source, query);
  const previous = query.cursor ? decodeCursor(query.cursor) : undefined;
  if (previous) assertCursorFilters(previous, filters);
  const start = previous?.seq ?? 0;
  const { journalId, editions, highWater, rows } = await readFeedSnapshot(db, source, query, start, filters.topic);
  assertFeedCoverage(source, query, editions);
  if (previous && (previous.journalId !== journalId || start > highWater)) throw new RequestInputError('The source feed cursor is no longer valid for this database.');
  const hasMore = rows.length > query.limit;
  const pageRows = rows.slice(0, query.limit);
  const nextSequence = hasMore ? (pageRows.at(-1)?.seq ?? start) : highWater;
  const feedPolicy = policy[source];
  return SourceFeedResponseSchema.parse({
    events: pageRows.map((row) => emitEvent(row, query)),
    nextCursor: encodeCursor({ version: 1, journalId, ...filters, seq: nextSequence }),
    scope: {
      source,
      language: query.language,
      editions: editions.map((edition) => ({ editionId: edition.edition_id,
        ...(edition.part === null ? {} : { part: edition.part }), publicationDate: edition.publication_date, observedAt: edition.observed_at })),
      publisher: feedPolicy.publisher,
      redistribution: feedPolicy.redistribution,
      attribution: attributionFor(feedPolicy),
    },
    hasMore,
  });
}
