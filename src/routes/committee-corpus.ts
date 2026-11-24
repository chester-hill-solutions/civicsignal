import { AccessError } from '../access';
import { RequestInputError } from '../http';
import type { Env } from '../types';
import {
  CommitteeLanguageSchema,
  CommitteeRecordSchema,
  CommitteeCorpusPageSchema,
  CommitteeCorpusSearchResponseSchema,
  CommitteeCorpusCoverageSchema,
  CommitteeDetailResponseSchema,
  CommitteePassagesResponseSchema,
  CommitteePassageSchema,
  CommitteeCallSchema,
  CommitteeCallsResponseSchema,
  CommitteeCallDetailResponseSchema,
  type CommitteeCall,
  type CommitteeLanguage,
} from '../corpora/committee-corpus';
import {
  OpportunityDeadlineSchema,
  OpportunityOpenState,
  openStateAsOf,
  type OpportunityDeadline,
} from '../corpora/opportunity';

export const COMMITTEE_CORPUS_PATH = '/api/committees';

type Op = 'session' | 'committee' | 'studies' | 'meetings' | 'study' | 'meeting' | 'document' | 'passages'
  | 'search' | 'coverage' | 'calls' | 'call';
type Route = { op: Op; session?: string; id?: string; parentId?: string };
type Paging = { offset: number; limit: number };
type OperationContext = {
  db: D1Database;
  route: Route;
  parameters: Record<string, string>;
  language: CommitteeLanguage | undefined;
  offset: number;
  limit: number;
};
const SESSION = /^\d{1,2}-\d{1,2}$/u;
const ID = /^[a-z0-9][a-z0-9._-]{0,99}$/u;

export function matchCommitteeCorpusRoute(path: string): Route | undefined {
  if (!path.startsWith(`${COMMITTEE_CORPUS_PATH}/`)) return undefined;
  if (path === `${COMMITTEE_CORPUS_PATH}/search`) return { op: 'search' };
  if (path === `${COMMITTEE_CORPUS_PATH}/coverage`) return { op: 'coverage' };

  const parts = path.slice(COMMITTEE_CORPUS_PATH.length + 1).split('/');
  if (!SESSION.test(parts[0] ?? '')) return undefined;
  const session = parts[0] ?? '';
  if (parts.length === 1) return { op: 'session', session };
  return matchSessionResource(session, parts.slice(1));
}

function matchSessionResource(session: string, parts: string[]): Route | undefined {
  if (parts[0] === 'documents') return matchDocumentResource(session, parts.slice(1));
  if (parts[0] === 'calls') {
    if (parts.length === 1) return { op: 'calls', session };
    const callId = parts[1] ?? '';
    return ID.test(callId) && parts.length === 2 ? { op: 'call', session, id: callId } : undefined;
  }
  const id = parts[0] ?? '';
  if (!ID.test(id)) return undefined;
  if (parts.length === 1) return { op: 'committee', session, id };
  return matchCommitteeChild(session, id, parts.slice(1));
}

function matchDocumentResource(session: string, parts: string[]): Route | undefined {
  const id = parts[0] ?? '';
  if (!ID.test(id)) return undefined;
  if (parts.length === 1) return { op: 'document', session, id };
  if (parts.length === 2 && parts[1] === 'passages') return { op: 'passages', session, id };
  return undefined;
}

function matchCommitteeChild(session: string, parentId: string, parts: string[]): Route | undefined {
  const section = parts[0] ?? '';
  if (section !== 'studies' && section !== 'meetings') return undefined;
  if (parts.length === 1) return { op: section, session, id: parentId };
  const id = parts[1] ?? '';
  if (!ID.test(id) || parts.length !== 2) return undefined;
  return { op: section === 'studies' ? 'study' : 'meeting', session, id, parentId };
}
function params(url: URL, allowed: readonly string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const key of url.searchParams.keys()) {
    const values = url.searchParams.getAll(key);
    if (!allowed.includes(key) || values.length !== 1) {
      throw new RequestInputError(`Unsupported or repeated query parameter: ${key}.`);
    }
    output[key] = values[0] ?? '';
  }
  return output;
}

function paging(parameters: Record<string, string>) {
  const parseInteger = (key: string, fallback: number, maximum: number) => {
    const raw = parameters[key];
    const value = raw === undefined ? fallback : /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
      throw new RequestInputError(`${key} is invalid.`);
    }
    return value;
  };
  const offset = parseInteger('offset', 0, Number.MAX_SAFE_INTEGER);
  const limit = parseInteger('limit', 20, 100);
  if (limit < 1) throw new RequestInputError('limit must be at least 1.');
  return { offset, limit };
}

function database(env: Env): D1Database {
  if (env.COMMITTEE_CORPUS_PREVIEW !== 'on') {
    throw new AccessError('UNSUPPORTED_COVERAGE', 'Committee corpus preview is disabled.', 501);
  }
  if (!env.COMMITTEE_DB) {
    throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Committee corpus database is unavailable.', 503);
  }
  return env.COMMITTEE_DB;
}

const ALLOWED_PARAMETERS: Record<Op, readonly string[]> = {
  coverage: ['session', 'chamber', 'committeeId', 'language', 'kind', 'offset', 'limit'],
  search: ['language', 'query', 'session', 'chamber', 'committeeId', 'studyId', 'kind', 'offset', 'limit'],
  calls: ['language', 'query', 'committeeId', 'status', 'asOf', 'offset', 'limit'],
  call: ['language', 'asOf'],
  passages: ['language', 'offset', 'limit'],
  session: ['language', 'offset', 'limit'],
  committee: ['language', 'offset', 'limit'],
  studies: ['language', 'offset', 'limit'],
  meetings: ['language', 'offset', 'limit'],
  study: ['language', 'offset', 'limit'],
  meeting: ['language', 'offset', 'limit'],
  document: ['language', 'offset', 'limit'],
};

function prepareParameters(route: Route, url: URL) {
  const p = params(url, ALLOWED_PARAMETERS[route.op]);
  let language: CommitteeLanguage | undefined;
  if (['search', 'passages'].includes(route.op) || p.language !== undefined) {
    const parsed = CommitteeLanguageSchema.safeParse(p.language);
    if (!parsed.success) throw new RequestInputError('Supply language=en or fr.');
    language = parsed.data;
  }
  validateParameters(route, p);
  return { parameters: p, language, ...paging(p) };
}

function validateParameters(route: Route, p: Record<string, string>) {
  if (route.op === 'search' && (!p.query?.trim() || p.query.length > 256)) {
    throw new RequestInputError('query must contain 1 to 256 characters.');
  }
  if (route.op === 'calls') validateCallParameters(p);
}

function validateCallParameters(p: Record<string, string>) {
  if (p.query !== undefined && (!p.query.trim() || p.query.length > 256)) {
    throw new RequestInputError('query must contain 1 to 256 characters.');
  }
  if (p.status !== undefined && !OpportunityOpenState.safeParse(p.status).success) {
    throw new RequestInputError('status must be open, closed or unknown.');
  }
  if (p.asOf !== undefined && Number.isNaN(Date.parse(p.asOf))) {
    throw new RequestInputError('asOf must be an ISO date or instant.');
  }
}

export function prepareCommitteeCorpus(url: URL): ((env: Env) => () => Promise<unknown>) | undefined {
  const route = matchCommitteeCorpusRoute(url.pathname);
  if (!route) return undefined;
  return (env) => {
    const db = database(env);
    const { parameters, language, offset, limit } = prepareParameters(route, url);
    return () => runCommitteeCorpusOperation({ db, route, parameters, language, offset, limit });
  };
}

function runCommitteeCorpusOperation(context: OperationContext): Promise<unknown> {
  const { route } = context;
  if (route.op === 'coverage') return readCommitteeCoverage(context);
  if (route.op === 'calls') return listCommitteeCalls(context);
  if (route.op === 'call') return readCommitteeCall(context);
  if (route.op === 'search') return searchCommitteeRecords(context);
  if (route.op === 'committee') return readCommitteeRecord(context);
  if (route.op === 'session' || route.op === 'studies' || route.op === 'meetings') {
    return listCommitteeRecords(context);
  }
  if (route.op === 'study' || route.op === 'meeting' || route.op === 'document') {
    return readCommitteeDocument(context);
  }
  if (route.op === 'passages') return readCommitteePassages(context);
  return Promise.resolve({});
}

async function readCommitteeCoverage(context: OperationContext) {
  const { db, parameters, offset, limit } = context;
  const session = parameters.session ?? '45-1';
  const filters = ['r.session = ?'];
  const values: unknown[] = [session];
  for (const [key, column] of [
    ['chamber', 'chamber'], ['committeeId', 'committee_id'], ['language', 'language'], ['kind', 'kind'],
  ] as const) {
    const value = parameters[key];
    if (value) {
      filters.push(column === 'committee_id'
        ? "COALESCE(r.committee_id, CASE WHEN r.kind='committee' THEN r.id END) = ?"
        : `r.${column} = ?`);
      values.push(value);
    }
  }
  const where = filters.join(' AND ');
  const [snapshot, counts, total, rows] = await Promise.all([
    db.prepare('SELECT cutoff FROM cc_snapshot WHERE session = ?').bind(session).first<{ cutoff: string }>(),
    db.prepare(`SELECT COALESCE(r.committee_id, CASE WHEN r.kind='committee' THEN r.id END) AS committee_id,
        r.chamber,r.language,r.kind,r.status,COUNT(*) AS count,
        c.metadata_json AS committee_metadata
      FROM cc_records r LEFT JOIN cc_records c ON c.session=r.session AND c.language=r.language
        AND c.id=COALESCE(r.committee_id, CASE WHEN r.kind='committee' THEN r.id END) AND c.kind='committee'
      WHERE ${where}
      GROUP BY COALESCE(r.committee_id, CASE WHEN r.kind='committee' THEN r.id END),r.chamber,r.language,r.kind,r.status,c.metadata_json
      ORDER BY COALESCE(r.committee_id, CASE WHEN r.kind='committee' THEN r.id END),r.chamber,r.language,r.kind,r.status`).bind(...values).all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS count FROM cc_records r WHERE ${where}
      AND r.status IN ('stored','pending','unavailable','removed')`).bind(...values).first<{ count: number }>(),
    db.prepare(`SELECT r.id,COALESCE(r.committee_id, CASE WHEN r.kind='committee' THEN r.id END) AS committee_id,
        r.chamber,r.language,r.kind,r.status,c.metadata_json AS committee_metadata
      FROM cc_records r LEFT JOIN cc_records c ON c.session=r.session AND c.language=r.language
        AND c.id=COALESCE(r.committee_id, CASE WHEN r.kind='committee' THEN r.id END) AND c.kind='committee'
      WHERE ${where} AND r.status IN ('stored','pending','unavailable','removed')
      ORDER BY r.committee_id,r.kind,r.id,r.language LIMIT ? OFFSET ?`)
      .bind(...values, limit + 1, offset).all<Record<string, unknown>>(),
  ]);

  return CommitteeCorpusCoverageSchema.parse({
    session,
    cutoff: snapshot?.cutoff ?? null,
    counts: counts.results.map(coverageCount),
    outstanding: {
      ids: rows.results.slice(0, limit).map(outstandingRecord),
      offset,
      limit,
      total: Number(total?.count ?? 0),
      hasMore: rows.results.length > limit,
    },
    basis: 'materialized-records',
  });
}

function coverageCount(row: Record<string, unknown>) {
  return {
    committeeId: nullableString(row.committee_id),
    chamber: nullableString(row.chamber),
    language: row.language,
    kind: row.kind,
    status: row.status,
    count: Number(row.count),
    directoryCutoffs: readDirectoryCutoffs(row.committee_metadata),
  };
}

function outstandingRecord(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    committeeId: nullableString(row.committee_id),
    chamber: nullableString(row.chamber),
    language: row.language,
    kind: row.kind,
    status: row.status,
    directoryCutoffs: readDirectoryCutoffs(row.committee_metadata),
  };
}

async function searchCommitteeRecords(context: OperationContext) {
  const { db, parameters, language, offset, limit } = context;
  const query = parameters.query?.trim();
  if (!language || !query) throw new RequestInputError('Search requires query text and language=en or fr.');
  const words = query.split(/\s+/u).map(word => `"${word.replaceAll('"', '""')}"`).join(' AND ');
  const filters = ['f.language = ?'];
  const values: unknown[] = [language];
  addSearchFilters(filters, values, parameters);
  const rows = await searchRows({ db, words, filters, values, offset, limit });
  const selected = rows.results.slice(0, limit);
  const parentMap = await searchParents(db, selected, language);
  const items = selected.map(row => searchItem(row, language, parentMap));
  return CommitteeCorpusSearchResponseSchema.parse({
    items, language, offset, limit, hasMore: rows.results.length > limit, coverageBasis: 'materialized-records',
  });
}

function addSearchFilters(filters: string[], values: unknown[], parameters: Record<string, string>) {
  const columns = [
    ['session', 'f.session'], ['chamber', 'r.chamber'], ['committeeId', 'r.committee_id'], ['kind', 'r.kind'],
  ] as const;
  for (const [name, column] of columns) {
    const value = parameters[name];
    if (value) {
      filters.push(`${column} = ?`);
      values.push(value);
    }
  }
  const studyId = parameters.studyId;
  if (studyId) {
    filters.push('(f.document_id = ? OR f.document_id IN (SELECT child_id FROM cc_links WHERE session = f.session AND language = f.language AND parent_id = ?))');
    values.push(studyId, studyId);
  }
}

async function searchRows(options: {
  db: D1Database;
  words: string;
  filters: string[];
  values: unknown[];
} & Paging) {
  const { db, words, filters, values, offset, limit } = options;
  return db.prepare(`SELECT f.session,f.document_id,f.position,r.title,r.url,r.kind,r.metadata_json,r.committee_id,
      p.location,p.text,p.speaker,p.affiliation
    FROM cc_fts f JOIN cc_records r ON r.session=f.session AND r.id=f.document_id AND r.language=f.language
    LEFT JOIN cc_passages p ON p.session=f.session AND p.language=f.language
      AND p.document_id=f.document_id AND p.position=f.position
    WHERE cc_fts MATCH ? AND ${filters.join(' AND ')}
    ORDER BY bm25(cc_fts),f.session,f.document_id,f.position LIMIT ? OFFSET ?`)
    .bind(words, ...values, limit + 1, offset).all<Record<string, unknown>>();
}

async function searchParents(
  db: D1Database,
  rows: Record<string, unknown>[],
  language: CommitteeLanguage,
) {
  const linksByRecord = new Map<string, CommitteeRelation[]>();
  if (!rows.length) return linksByRecord;
  const placeholders = rows.map(() => '?').join(',');
  const values = rows.map(row => String(row.document_id));
  const links = await db.prepare(`SELECT l.session,l.language,l.child_id,l.parent_id,l.relation,r.kind
    FROM cc_links l JOIN cc_records r ON r.session=l.session AND r.language=l.language AND r.id=l.parent_id
    WHERE l.child_id IN (${placeholders})
    ORDER BY l.session,l.language,l.child_id,l.parent_id`).bind(...values).all<Record<string, unknown>>();
  for (const link of links.results) {
    const key = recordKey(link.session, link.language, link.child_id);
    const relations = linksByRecord.get(key) ?? [];
    relations.push({ id: String(link.parent_id), kind: String(link.kind), relation: String(link.relation), direction: 'parent' });
    linksByRecord.set(key, relations);
  }
  return linksByRecord;
}

function searchItem(
  row: Record<string, unknown>,
  language: CommitteeLanguage,
  linksByRecord: Map<string, CommitteeRelation[]>,
) {
  const metadata = parseJson(row.metadata_json);
  const committeeId = nullableString(row.committee_id);
  const parents = [...(linksByRecord.get(recordKey(row.session, language, row.document_id)) ?? [])];
  if (committeeId && !parents.some(parent => parent.id === committeeId)) {
    parents.push({ id: committeeId, kind: 'committee', relation: 'committee', direction: 'parent' });
  }
  return {
    citation: { id: String(row.document_id), title: String(row.title), url: String(row.url), language, kind: String(row.kind) },
    position: Number(row.position),
    location: nullableString(row.location),
    text: metadata.delivery === 'excerpt' ? String(row.text ?? '').slice(0, 400) : null,
    speaker: nullableString(row.speaker),
    affiliation: nullableString(row.affiliation),
    authors: publishedAuthors(metadata),
    credits: publishedCredits(metadata),
    parents,
  };
}

function publishedAuthors(metadata: Record<string, unknown>): string[] {
  const authors = metadata.authors ?? metadata.author ?? metadata.submitter;
  if (Array.isArray(authors)) return authors.map(String);
  return authors ? [String(authors)] : [];
}

function publishedCredits(metadata: Record<string, unknown>) {
  const credits = Array.isArray(metadata.credits) ? metadata.credits : [];
  return credits.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const credit = value as Record<string, unknown>;
    const organization = typeof credit.organization === 'string' ? credit.organization : undefined;
    const submitter = typeof credit.submitter === 'string' ? credit.submitter : undefined;
    if (!organization && !submitter) return [];
    return [{ ...(organization ? { organization } : {}), ...(submitter ? { submitter } : {}) }];
  });
}


const CALL_SELECT = `SELECT r.session,r.id,r.language,r.title,r.url,r.metadata_json,r.committee_id,
    c.title AS committee_title,s.id AS study_id,s.title AS study_title,s.url AS study_url
  FROM cc_records r
  LEFT JOIN cc_records c ON c.session=r.session AND c.language=r.language
    AND c.id=r.committee_id AND c.kind='committee'
  LEFT JOIN cc_records s ON s.session=r.session AND s.language=r.language AND s.kind='study'
    AND s.id = r.committee_id || '-study-' || json_extract(r.metadata_json,'$.studyId')
  WHERE r.kind = 'call'`;

function asOfInstant(value: string | undefined): string {
  return (value ? new Date(value) : new Date()).toISOString();
}

async function listCommitteeCalls(context: OperationContext) {
  const { db, route, parameters, language, offset, limit } = context;
  const session = route.session ?? '45-1';
  const asOf = asOfInstant(parameters.asOf);
  const filters = ['r.session = ?'];
  const values: unknown[] = [session];
  if (language) { filters.push('r.language = ?'); values.push(language); }
  if (parameters.committeeId) { filters.push('r.committee_id = ?'); values.push(parameters.committeeId); }
  if (parameters.query) {
    const like = `%${parameters.query}%`;
    filters.push("(r.title LIKE ? OR json_extract(r.metadata_json,'$.instructions') LIKE ?)");
    values.push(like, like);
  }
  const rows = await db.prepare(`${CALL_SELECT} AND ${filters.join(' AND ')} ORDER BY r.id,r.language`)
    .bind(...values).all<Record<string, unknown>>();
  const items = rows.results.map(row => callFromRow(row, asOf));
  // The open state is computed for a date, so it cannot be filtered in SQL.
  const matched = parameters.status ? items.filter(item => item.status === parameters.status) : items;
  return CommitteeCallsResponseSchema.parse({
    session,
    asOf,
    items: matched.slice(offset, offset + limit),
    offset,
    limit,
    hasMore: matched.length > offset + limit,
    coverageBasis: 'materialized-records',
  });
}

async function readCommitteeCall(context: OperationContext) {
  const { db, route, parameters, language } = context;
  const session = route.session;
  const id = route.id;
  if (!session || !id) throw new RequestInputError('A session and call ID are required.');
  const asOf = asOfInstant(parameters.asOf);
  const row = await db.prepare(`${CALL_SELECT} AND r.session = ? AND r.id = ? AND r.language = ? LIMIT 1`)
    .bind(session, id, language ?? 'en').first<Record<string, unknown>>();
  if (!row) {
    return CommitteeCallDetailResponseSchema.parse({ state: 'not-found', session, id, language: language ?? 'en' });
  }
  const item = callFromRow(row, asOf);
  return CommitteeCallDetailResponseSchema.parse({
    state: 'found',
    asOf,
    item,
    related: await callRelatedCounts(db, session, language ?? 'en', item.study?.id ?? null),
  });
}

async function callRelatedCounts(
  db: D1Database,
  session: string,
  language: CommitteeLanguage,
  studyId: string | null,
) {
  if (!studyId) return { submissions: 0, evidence: 0, meetings: 0 };
  const rows = await db.prepare(`SELECT r.kind AS kind,COUNT(*) AS count FROM cc_links l
      JOIN cc_records r ON r.session=l.session AND r.language=l.language AND r.id=l.child_id
      WHERE l.session = ? AND l.language = ? AND l.parent_id = ? GROUP BY r.kind`)
    .bind(session, language, studyId).all<{ kind: string; count: number }>();
  const counts = new Map(rows.results.map(row => [String(row.kind), Number(row.count)]));
  return {
    submissions: (counts.get('submission') ?? 0) + (counts.get('brief') ?? 0),
    evidence: counts.get('evidence') ?? 0,
    meetings: counts.get('meeting') ?? 0,
  };
}

function callFromRow(row: Record<string, unknown>, asOf: string): CommitteeCall {
  const metadata = parseJson(row.metadata_json);
  const deadline = readDeadline(metadata.deadline);
  const observedAt = instantString(metadata.observedAt);
  const firstObservedAt = instantString(metadata.firstObservedAt ?? metadata.observedAt);
  const lastListedAt = instantString(metadata.lastListedAt ?? metadata.observedAt);
  // Without a deadline, the observation that last listed the call is what vouches
  // for it; a call that left the list does not stay open on an older stamp.
  const { state, basis } = openStateAsOf(deadline, { firstObservedAt, observedAt: lastListedAt }, asOf);
  const instructions = metadata.delivery === 'excerpt' && typeof metadata.instructions === 'string'
    ? metadata.instructions
    : null;
  return CommitteeCallSchema.parse({
    id: String(row.id),
    language: row.language,
    title: String(row.title),
    url: String(row.url),
    status: state,
    statusBasis: basis,
    deadline,
    instructions: instructions?.slice(0, 400) ?? null,
    instructionsTruncated: instructions !== null && instructions.length > 400,
    instructionUrl: nullableString(metadata.instructionUrl),
    committee: { id: String(row.committee_id), name: nullableString(row.committee_title) },
    study: row.study_id
      ? { id: String(row.study_id), title: String(row.study_title), url: String(row.study_url) }
      : null,
    listingUrl: String(metadata.listingUrl ?? row.url),
    contentWarning: metadata.contentWarning === true,
    contentWarningText: nullableString(metadata.contentWarningText),
    listed: metadata.listed !== false,
    lastListedAt,
    pendingChange: Boolean(metadata.pendingDigest),
    contentConflict: metadata.contentConflict === true,
    observedAt,
    firstObservedAt,
  });
}

function readDeadline(value: unknown): OpportunityDeadline | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const parsed = OpportunityDeadlineSchema.safeParse({
    text: candidate.text,
    instant: candidate.instant ?? null,
    timeZone: candidate.timeZone ?? null,
  });
  return parsed.success ? parsed.data : null;
}

function instantString(value: unknown): string {
  const parsed = Date.parse(String(value ?? ''));
  if (Number.isNaN(parsed)) throw new Error('A call record has no usable observation stamp.');
  return new Date(parsed).toISOString();
}

async function readCommitteeRecord(context: OperationContext) {
  const { db, route, language, offset, limit } = context;
  const id = route.id;
  const session = route.session;
  if (!id || !session) throw new RequestInputError('A session and committee ID are required.');
  const row = await db.prepare("SELECT session,id,language,kind,chamber,committee_id,title,url,status,metadata_json,object_sha256 FROM cc_records WHERE session = ? AND id = ? AND kind = 'committee' AND language = ? LIMIT 1")
    .bind(session, id, language ?? 'en').first<Record<string, unknown>>();
  return detailResponse({ db, row, session, id, language: language ?? 'en', offset, limit });
}

async function listCommitteeRecords(context: OperationContext) {
  const { db, route, language, offset, limit } = context;
  const filters: string[] = [];
  const values: unknown[] = [];
  if (route.session) { filters.push('session = ?'); values.push(route.session); }
  if (route.id) {
    const committee = await db.prepare("SELECT id FROM cc_records WHERE session = ? AND id = ? AND kind = 'committee' LIMIT 1")
      .bind(route.session, route.id).first<{ id: string }>();
    if (!committee) return { state: 'not-found', session: route.session, committeeId: route.id };
    filters.push('committee_id = ?');
    values.push(route.id);
  }
  if (route.op === 'session') filters.push("kind = 'committee'");
  if (route.op === 'studies') filters.push("kind = 'study'");
  if (route.op === 'meetings') filters.push("kind = 'meeting'");
  if (language) { filters.push('language = ?'); values.push(language); }
  const rows = await db.prepare(`SELECT session,id,language,kind,chamber,committee_id,title,url,status,metadata_json,object_sha256
    FROM cc_records WHERE ${filters.join(' AND ')} ORDER BY id,language LIMIT ? OFFSET ?`)
    .bind(...values, limit + 1, offset).all<Record<string, unknown>>();
  return CommitteeCorpusPageSchema.parse({ items: rows.results.slice(0, limit).map(recordFromRow), offset, limit, hasMore: rows.results.length > limit });
}

async function readCommitteeDocument(context: OperationContext) {
  const { db, route, language, offset, limit } = context;
  const id = route.id;
  const session = route.session;
  if (!id || !session) throw new RequestInputError('A session and record ID are required.');
  const kind = route.op === 'study' ? 'study' : route.op === 'meeting' ? 'meeting' : null;
  const kindSql = kind ? ' AND kind = ?' : '';
  const documentKindSql = route.op === 'document' ? " AND kind NOT IN ('committee','study','meeting')" : '';
  const parentSql = route.parentId ? ' AND committee_id = ?' : '';
  const bindings = [session, id, language ?? 'en', ...(kind ? [kind] : []), ...(route.parentId ? [route.parentId] : [])];
  const row = await db.prepare(`SELECT session,id,language,kind,chamber,committee_id,title,url,status,metadata_json,object_sha256
    FROM cc_records WHERE session = ? AND id = ? AND language = ?${kindSql}${documentKindSql}${parentSql} LIMIT 1`)
    .bind(...bindings).first<Record<string, unknown>>();
  return detailResponse({ db, row, session, id, language: language ?? 'en', offset, limit });
}

async function detailResponse(options: {
  db: D1Database;
  row: Record<string, unknown> | null;
  session: string;
  id: string;
  language: CommitteeLanguage;
} & Paging) {
  const { db, row, session, id, language, offset, limit } = options;
  if (!row) return CommitteeDetailResponseSchema.parse({ state: 'not-found', session, id, language });
  const links = await relatedRecords({ db, row, session, id, language, offset, limit });
  const committeeId = nullableString(row.committee_id);
  if (committeeId && committeeId !== id && !links.some(link => link.id === committeeId)) {
    links.push({ id: committeeId, kind: 'committee', relation: 'committee', direction: 'parent' });
  }
  return CommitteeDetailResponseSchema.parse({
    state: 'found', record: recordFromRow(row), links: links.slice(0, limit), offset, limit, hasMore: links.length > limit,
  });
}

async function relatedRecords(options: {
  db: D1Database;
  row: Record<string, unknown>;
  session: string;
  id: string;
  language: CommitteeLanguage;
} & Paging) {
  const { db, row, session, id, language, offset, limit } = options;
  const links = await db.prepare(`SELECT related_id,kind,relation,direction FROM (
    SELECT r.id AS related_id,r.kind,l.relation,'child' AS direction FROM cc_links l
      JOIN cc_records r ON r.session=l.session AND r.language=l.language AND r.id=l.child_id
      WHERE l.session = ? AND l.language = ? AND l.parent_id = ?
    UNION ALL
    SELECT r.id AS related_id,r.kind,l.relation,'parent' AS direction FROM cc_links l
      JOIN cc_records r ON r.session=l.session AND r.language=l.language AND r.id=l.parent_id
      WHERE l.session = ? AND l.language = ? AND l.child_id = ?
    UNION
    SELECT r.id AS related_id,r.kind,'committee' AS relation,'child' AS direction FROM cc_records r
      WHERE r.session = ? AND r.language = ? AND r.committee_id = ? AND r.id <> ?
        AND r.kind IN ('study','meeting') AND ? = 'committee'
        AND NOT EXISTS (SELECT 1 FROM cc_links l WHERE l.session=r.session AND l.language=r.language
          AND l.parent_id=? AND l.child_id=r.id)
    ) ORDER BY relation,related_id LIMIT ? OFFSET ?`)
    .bind(session, language, id, session, language, id, session, language, id, id, row.kind,
      id, limit + 1, offset)
    .all<Record<string, unknown>>();
  return links.results.map(link => ({
    id: String(link.related_id), kind: String(link.kind), relation: String(link.relation), direction: link.direction,
  }));
}

async function readCommitteePassages(context: OperationContext) {
  const { db, route, language, offset, limit } = context;
  const id = route.id;
  const session = route.session;
  if (!id || !session || !language) throw new RequestInputError('Passages require a session, document ID, and language=en or fr.');
  const record = await db.prepare(`SELECT session,id,language,kind,chamber,committee_id,title,url,status,metadata_json,object_sha256
    FROM cc_records WHERE session = ? AND id = ? AND language = ? AND kind NOT IN ('committee','study','meeting') LIMIT 1`)
    .bind(session, id, language).first<Record<string, unknown>>();
  if (!record) return CommitteePassagesResponseSchema.parse({ state: 'not-found', session, id, language });
  const rows = await db.prepare(`SELECT p.position,p.location,p.text,p.speaker,p.affiliation,r.title,r.url,r.kind,r.metadata_json
    FROM cc_passages p JOIN cc_records r ON r.session=p.session AND r.language=p.language AND r.id=p.document_id
    WHERE p.session = ? AND p.language = ? AND p.document_id = ? ORDER BY p.position LIMIT ? OFFSET ?`)
    .bind(session, language, id, limit + 1, offset).all<Record<string, unknown>>();
  const items = rows.results.slice(0, limit).map(row => passageFromRow(row, id, language));
  return CommitteePassagesResponseSchema.parse({
    state: 'found', record: recordFromRow(record), items, offset, limit, hasMore: rows.results.length > limit,
  });
}

function passageFromRow(row: Record<string, unknown>, id: string, language: CommitteeLanguage) {
  return CommitteePassageSchema.parse({
    position: Number(row.position),
    location: nullableString(row.location),
    text: parseJson(row.metadata_json).delivery === 'excerpt' ? String(row.text ?? '').slice(0, 400) : null,
    speaker: nullableString(row.speaker),
    affiliation: nullableString(row.affiliation),
    citation: { id, title: String(row.title), url: String(row.url), language, kind: String(row.kind) },
  });
}

type CommitteeRelation = { id: string; kind: string; relation: string; direction: 'parent' | 'child' };

function recordKey(session: unknown, language: unknown, id: unknown) {
  return `${session}:${language}:${id}`;
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}
function parseJson(value: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readDirectoryCutoffs(value: unknown): Record<string, string | null> {
  const metadata = parseJson(value);
  const cutoffs = metadata.directoryCutoffs;
  if (!cutoffs || typeof cutoffs !== 'object' || Array.isArray(cutoffs)) return {};
  return Object.fromEntries(Object.entries(cutoffs).flatMap(([key, cutoff]) =>
    typeof cutoff === 'string' || cutoff === null ? [[key, cutoff]] : []));
}

function recordFromRow(row: Record<string, unknown>) {
  return CommitteeRecordSchema.parse({
    session: String(row.session), id: String(row.id), language: row.language, kind: row.kind,
    chamber: row.chamber == null ? null : String(row.chamber),
    committeeId: row.committee_id == null ? null : String(row.committee_id),
    title: String(row.title), url: String(row.url), status: row.status,
    metadata: parseJson(row.metadata_json),
    objectSha256: row.object_sha256 == null ? null : String(row.object_sha256),
  });
}
