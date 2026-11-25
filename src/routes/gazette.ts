import { attributionFor } from '@chester-hill-solutions/corpus';
import { AccessError } from '../access';
import { CANADA_GAZETTE } from '../corpora/policies';
import { GAZETTE_PREVIEW_ISSUES, isGazetteCitationForIssue, isGazetteIssueSupported, isGazetteRecordIdForIssue, parseGazetteRecordId, type GazetteIssueKey, type GazetteRecord } from '../corpora/gazette';
import { RequestInputError } from '../http';
import type { Env } from '../types';
import { normalizeForSearch } from '../text';
import {
  GAZETTE_PATHS, GazetteSearchSchema, GazetteRecordSchema, GazetteSearchResponseSchema,
  GazetteLookupResponseSchema, type GazetteCoverage, type GazetteSearchRequest,
} from './gazette-contract';

interface GazetteRoute { pathId?: string }
type GazetteRequest =
  | { operation: 'search'; query: GazetteSearchRequest }
  | { operation: 'lookup'; id: string };

type GazetteDbRow = Omit<GazetteRecord, 'issueDate' | 'issueNumber' | 'citationUrl' | 'registrationNumber' | 'registrationDate' | 'consultationDeadline' | 'effectiveDate'> & {
  issue_date: string; issue_number: number; citation_url: string; registration_number: string | null;
  registration_date: string | null; consultation_deadline: string | null; effective_date: string | null;
};
type EditionRow = { part: 'I' | 'II'; language: 'en' | 'fr'; issue_date: string; volume: number; issue_number: number; record_count: number };

export function matchGazetteRoute(pathname: string): GazetteRoute | undefined {
  if (pathname === GAZETTE_PATHS.search) return {};
  const prefix = `${GAZETTE_PATHS.search}/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const pathId = pathname.slice(prefix.length);
  return pathId && !pathId.includes('/') ? { pathId } : undefined;
}

function parseSearch(url: URL): GazetteSearchRequest {
  if (url.search.length > 8192) throw new RequestInputError('The Gazette query is too long.');
  const input: Record<string, unknown> = {};
  for (const name of url.searchParams.keys()) {
    if (!Object.hasOwn(GazetteSearchSchema.shape, name)) throw new RequestInputError('Unsupported Gazette query parameter.');
    const values = url.searchParams.getAll(name);
    if (values.length !== 1) throw new RequestInputError(`Supply ${name} once.`);
    const value = values[0] ?? '';
    input[name] = name === 'limit' && /^[0-9]+$/u.test(value) ? Number(value) : value;
  }
  const result = GazetteSearchSchema.safeParse(input);
  if (!result.success) throw new RequestInputError(`${result.error.issues[0]?.path.join('.') || 'query'} is invalid.`);
  return result.data;
}

function decodeId(pathId: string): string {
  try { return decodeURIComponent(pathId); }
  catch { throw new RequestInputError('The Gazette record ID is not valid URL encoding.'); }
}

export function parseGazetteRequest({ pathId }: GazetteRoute, url: URL): GazetteRequest {
  if (pathId === undefined) return { operation: 'search', query: parseSearch(url) };
  if (url.search) throw new RequestInputError('A Gazette exact lookup takes no query parameters.');
  const id = decodeId(pathId);
  if (!id || id.length > 512 || !parseGazetteRecordId(id)) throw new RequestInputError('Supply a Gazette record ID returned by search.');
  return { operation: 'lookup', id };
}

export function gazetteDatabase(env: Env): D1Database {
  if (env.GAZETTE_PREVIEW !== 'on') {
    throw new AccessError('UNSUPPORTED_COVERAGE', 'Gazette preview is disabled on this deployment.', 501);
  }
  if (!env.GAZETTE_DB) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'The Gazette database is unavailable.', 503);
  return env.GAZETTE_DB;
}

function recordFromRow(row: GazetteDbRow) {
  const key = { part: row.part, language: row.language, issueDate: row.issue_date, volume: row.volume, issueNumber: row.issue_number } as const;
  if (!isGazetteRecordIdForIssue(row.id, key) || !isGazetteCitationForIssue(row.citation_url, key)) {
    throw new AccessError('RETRIEVAL_UNAVAILABLE', 'The Gazette record failed source validation.', 503);
  }
  return GazetteRecordSchema.parse({
    id: row.id, part: row.part, language: row.language, issueDate: row.issue_date,
    volume: row.volume, issueNumber: row.issue_number, kind: row.kind, title: row.title,
    citationUrl: row.citation_url, registrationNumber: row.registration_number ?? undefined,
    registrationDate: row.registration_date ?? undefined,
    consultationDeadline: row.consultation_deadline ?? undefined,
    effectiveDate: row.effective_date ?? undefined,
    source: CANADA_GAZETTE.publisher, redistribution: CANADA_GAZETTE.redistribution,
    attribution: attributionFor(CANADA_GAZETTE),
  });
}

function availableCoverage(parts: readonly GazetteIssueKey['part'][], keys: readonly GazetteIssueKey[], rows: readonly EditionRow[]): GazetteCoverage[] {
  if (rows.length !== keys.length) {
    throw new AccessError('RETRIEVAL_UNAVAILABLE', 'A requested Gazette edition is unavailable.', 503);
  }
  return parts.map((part) => ({
    part, language: keys[0].language, available: true,
    issues: rows.filter((row) => row.part === part).map((row) => ({
      issueDate: row.issue_date, volume: row.volume, issueNumber: row.issue_number, recordCount: row.record_count,
    })),
  }));
}

/** The same edition predicate and D1 transaction govern both coverage and results. */
async function readEditions(db: D1Database, keys: readonly GazetteIssueKey[], parts: readonly GazetteIssueKey['part'][],
  filter: { sql: 'id = ?' | 'instr(search_text, ?) > 0'; value: string; limit: number }) {
  const scope = keys.map(() => '(part = ? AND language = ? AND issue_date = ? AND volume = ? AND issue_number = ?)').join(' OR ');
  const values = keys.flatMap((key) => [key.part, key.language, key.issueDate, key.volume, key.issueNumber]);
  const [editions, records] = await db.batch<EditionRow | GazetteDbRow>([
    db.prepare(`SELECT part, language, issue_date, volume, issue_number, record_count FROM gazette_editions
      WHERE ${scope} ORDER BY issue_date DESC, part, volume DESC, issue_number DESC`).bind(...values),
    db.prepare(`SELECT * FROM gazette_records WHERE (${scope}) AND ${filter.sql}
      ORDER BY issue_date DESC, part, volume DESC, issue_number DESC, id LIMIT ?`).bind(...values, filter.value, filter.limit),
  ]).catch(() => { throw new AccessError('RETRIEVAL_UNAVAILABLE', 'The Gazette edition store is unavailable.', 503); });
  const coverage = availableCoverage(parts, keys, editions.results as EditionRow[]);
  return { coverage, items: (records.results as GazetteDbRow[]).map(recordFromRow) };
}

export async function runGazetteRequest(db: D1Database, request: GazetteRequest) {
  if (request.operation === 'lookup') {
    const key = parseGazetteRecordId(request.id);
    if (!key) throw new RequestInputError('Supply a Gazette record ID returned by search.');
    const edition = await db.prepare(`SELECT record_count FROM gazette_editions
      WHERE part=? AND language=? AND issue_date=? AND volume=? AND issue_number=?`)
      .bind(key.part, key.language, key.issueDate, key.volume, key.issueNumber).first<{ record_count: number }>()
      .catch(() => { throw new AccessError('RETRIEVAL_UNAVAILABLE', 'The Gazette edition store is unavailable.', 503); });
    if (!edition) {
      if (isGazetteIssueSupported(key)) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'A configured Gazette issue edition is unavailable.', 503);
      throw new AccessError('UNSUPPORTED_COVERAGE', 'This Gazette issue is outside the persisted coverage.', 501);
    }
    const { items, coverage } = await readEditions(db, [key], [key.part], { sql: 'id = ?', value: request.id, limit: 1 });
    if (!items.length) throw new AccessError('NOT_FOUND', 'No Gazette record has that ID.', 404);
    return GazetteLookupResponseSchema.parse({ item: items[0], coverage: coverage[0] });
  }
  const query = request.query;
  const predicates = ['language=?'];
  const values: (string | number)[] = [query.language];
  if (query.part) { predicates.push('part=?'); values.push(query.part); }
  if (query.since) { predicates.push('issue_date>=?'); values.push(query.since); }
  if (query.until) { predicates.push('issue_date<=?'); values.push(query.until); }
  const scope = predicates.join(' AND ');
  const parts: GazetteIssueKey['part'][] = query.part ? [query.part] : ['I', 'II'];
  const topic = normalizeForSearch(query.topic);
  const [editions, records] = await db.batch<EditionRow | GazetteDbRow>([
    db.prepare(`SELECT part, language, issue_date, volume, issue_number, record_count FROM gazette_editions
      WHERE ${scope} ORDER BY issue_date DESC, part, volume DESC, issue_number DESC`).bind(...values),
    db.prepare(`SELECT * FROM gazette_records WHERE ${scope} AND instr(search_text, ?) > 0
      ORDER BY issue_date DESC, part, volume DESC, issue_number DESC, id LIMIT ?`).bind(...values, topic, query.limit),
  ]).catch(() => { throw new AccessError('RETRIEVAL_UNAVAILABLE', 'The Gazette edition store is unavailable.', 503); });
  const editionRows = editions.results as EditionRow[];
  if (!editionRows.length) {
    const configured = GAZETTE_PREVIEW_ISSUES.some((key) => key.language === query.language
      && (!query.part || key.part === query.part)
      && (!query.since || key.issueDate >= query.since) && (!query.until || key.issueDate <= query.until));
    if (configured) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'A configured Gazette issue edition is unavailable.', 503);
    throw new AccessError('UNSUPPORTED_COVERAGE', 'The requested Gazette date and part are outside the persisted coverage.', 501);
  }
  if (!query.since && !query.until && parts.some((part) => !editionRows.some((row) => row.part === part))) {
    throw new AccessError('RETRIEVAL_UNAVAILABLE', 'A requested Gazette part has no persisted issue edition.', 503);
  }
  const coverage = parts.map((part) => ({ part, language: query.language, available: true,
    issues: editionRows.filter((row) => row.part === part).map((row) => ({ issueDate: row.issue_date,
      volume: row.volume, issueNumber: row.issue_number, recordCount: row.record_count })) }));
  const items = (records.results as GazetteDbRow[]).map(recordFromRow);
  return GazetteSearchResponseSchema.parse({ items, count: items.length, coverage });
}
