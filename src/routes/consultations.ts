import { z } from 'zod';
import { AccessError } from '../access';
import noticeReplacements from '../corpora/consultation-notice-urls.json';
import {
  CONSULTATION_SOURCE, ConsultationCoverageSchema, ConsultationFactsSchema, ConsultationLanguageSchema,
  ConsultationLookupResponseSchema, ConsultationRecordSchema, ConsultationRevisionSchema,
  ConsultationSearchResponseSchema, ConsultationStateSchema, stateAsOf,
} from '../corpora/consultations';
import { RequestInputError } from '../http';
import { normalizeForSearch } from '../text';
import type { Env } from '../types';

export const CONSULTATIONS_API_PATH = '/api/consultations';
export const CONSULTATIONS_OPENAPI_PATH = `${CONSULTATIONS_API_PATH}/openapi.json`;

const pageNumber = z.string().regex(/^\d{1,9}$/).transform(Number);
const asOfValue = z.string().refine((value) =>
  z.iso.date().safeParse(value).success || z.iso.datetime({ offset: true }).safeParse(value).success,
  'Expected an ISO date or instant.',
);
const asOfField = asOfValue.optional();

export const ConsultationSearchQuery = z.strictObject({
  query: z.string().trim().min(1).max(256),
  language: ConsultationLanguageSchema,
  state: ConsultationStateSchema.optional(),
  institution: z.string().trim().min(1).max(100).optional(),
  subject: z.string().trim().min(1).max(100).optional(),
  asOf: asOfField,
  limit: pageNumber.pipe(z.number().int().min(1).max(100)).default(20),
  offset: pageNumber.default(0),
});
export const ConsultationLookupQuery = z.strictObject({ asOf: asOfField });
export const ConsultationCoverageQuery = z.strictObject({
  institution: z.string().trim().min(1).max(100).optional(),
  asOf: asOfField,
});

type SearchInput = z.output<typeof ConsultationSearchQuery>;
type Language = z.infer<typeof ConsultationLanguageSchema>;

function args<T>(params: URLSearchParams, schema: z.ZodType<T>, name: string): T {
  const raw = Object.fromEntries(params);
  if (Object.keys(raw).length !== params.size) throw new RequestInputError('Supply each parameter once.');
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new RequestInputError(`Invalid consultation ${name} parameters.`);
  return parsed.data;
}

function instant(value?: string): string {
  if (!value) return new Date().toISOString();
  const date = z.iso.date().safeParse(value).success ? `${value}T00:00:00.000Z` : value;
  const parsed = new Date(date);
  if (!Number.isFinite(parsed.getTime())) throw new RequestInputError('Expected an ISO date or instant.');
  return parsed.toISOString();
}

function json(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) as unknown : value;
}

function numeric(row: Record<string, unknown>, key: string): number {
  return Number(row[key] ?? 0);
}

function recordFromRow(row: Record<string, unknown>) {
  return ConsultationRecordSchema.parse({
    ...ConsultationFactsSchema.parse(json(row.facts_json)),
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.observed_at,
    revision: numeric(row, 'revision'),
    removedAt: row.removed_at ?? null,
  });
}

function catalogue(db: D1Database) {
  return db.prepare(`SELECT source, observed_at AS observedAt, revision, csv_sha256 AS csvSha256,
    schema_sha256 AS schemaSha256 FROM consultations_catalogues WHERE source=?`).bind(CONSULTATION_SOURCE);
}

function requireCatalogue(row: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!row) throw new AccessError('UNSUPPORTED_COVERAGE', 'No published consultation catalogue.', 501);
  return row;
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function descriptionSnippet(description: string, query: string): string {
  if (description.length <= 400) return description;
  const needle = normalizeForSearch(query);
  const found = normalizeForSearch(description).indexOf(needle);
  const width = found < 0 ? 399 : 398;
  const start = found < 0 ? 0 : Math.max(0, Math.min(found - 110, description.length - width));
  const end = Math.min(description.length, start + width);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < description.length ? '…' : '';
  return `${prefix}${description.slice(start, end).trim()}${suffix}`.slice(0, 400);
}

function titleFor(facts: z.infer<typeof ConsultationFactsSchema>, language: Language): string {
  return facts.editions[language].title || facts.editions[language === 'en' ? 'fr' : 'en'].title;
}

const stateSql = `CASE
    WHEN start_date IS NULL OR end_date IS NULL THEN 'unknown'
    WHEN ? < (start_date || 'T00:00:00.000Z') THEN 'planned'
    WHEN ? > (end_date || 'T23:59:59.999Z') THEN 'closed'
    ELSE 'open' END`;

async function search(db: D1Database, input: SearchInput, asOf: string) {
  const metaResult = await catalogue(db).first<Record<string, unknown>>();
  const meta = requireCatalogue(metaResult ?? undefined);
  const clauses = ['removed_at IS NULL',
    `${input.language === 'en' ? 'search_en' : 'search_fr'} LIKE '%' || ? || '%' ESCAPE '\\'`];
  const normalizedQuery = normalizeForSearch(input.query);
  const bindings: (string | number)[] = [escapeLike(normalizedQuery)];
  if (input.institution) { clauses.push('owner_org=?'); bindings.push(input.institution); }
  if (input.subject) {
    clauses.push(`EXISTS (SELECT 1 FROM json_each(facts_json, '$.subjects') subject
      WHERE json_extract(subject.value, '$.code')=?)`);
    bindings.push(input.subject);
  }
  if (input.state) {
    clauses.push(`${stateSql}=?`);
    bindings.push(asOf, asOf, input.state);
  }
  const rows = await db.prepare(`SELECT * FROM consultations_records WHERE ${clauses.join(' AND ')}
    ORDER BY start_date DESC, id`)
    .bind(...bindings)
    .all<Record<string, unknown>>();
  const ranked = rows.results.map((row) => {
    const facts = ConsultationFactsSchema.parse(json(row.facts_json));
    const edition = facts.editions[input.language];
    const title = titleFor(facts, input.language);
    const titleMatch = normalizeForSearch(edition.title).includes(normalizedQuery);
    const snippet = titleMatch ? title : descriptionSnippet(edition.description ?? '', input.query);
    const state = stateAsOf(facts.dates, asOf).state;
    return { titleMatch, item: {
      id: facts.id,
      registrationNumber: facts.registrationNumber,
      ownerOrg: facts.ownerOrg,
      institution: facts.institution,
      title,
      description: titleMatch || !edition.description ? null : descriptionSnippet(edition.description, input.query),
      dates: facts.dates,
      state,
      statusCode: facts.statusCode,
      status: facts.status.label,
      editions: (['en', 'fr'] as const).filter((language) => Boolean(facts.editions[language].title)),
      reportAvailableOnline: facts.reportAvailableOnline,
      match: { field: titleMatch ? 'title' as const : 'description' as const, snippet },
    } };
  });
  ranked.sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch));
  const page = ranked.slice(input.offset, input.offset + input.limit + 1);
  const items = page.slice(0, input.limit).map(({ item }) => item);
  return ConsultationSearchResponseSchema.parse({
    source: CONSULTATION_SOURCE, observedAt: meta.observedAt, asOf, items,
    nextOffset: page.length > input.limit ? input.offset + input.limit : null,
  });
}

export async function lookupConsultation(db: D1Database, id: string, asOf: string, noticeDb?: D1Database) {
  const [metaResult, recordResult, revisionsResult] = await Promise.all([
    catalogue(db).first<Record<string, unknown>>(),
    db.prepare('SELECT * FROM consultations_records WHERE id=?').bind(id).first<Record<string, unknown>>(),
    db.prepare(`SELECT observed_at AS observedAt, revision, event, changed_fields_json AS changedFields
      FROM consultations_revisions WHERE id=? ORDER BY observed_at DESC, revision DESC`).bind(id)
      .all<Record<string, unknown>>(),
  ]);
  const meta = requireCatalogue(metaResult ?? undefined);
  const item = recordResult ? recordFromRow(recordResult) : null;
  const revisions = revisionsResult.results.map((row) => ConsultationRevisionSchema.parse({
    ...row, revision: numeric(row, 'revision'), changedFields: json(row.changedFields),
  }));
  const noticeEvidence = item && !item.removedAt && noticeDb
    ? await participationNotices(noticeDb, id, String(meta.revision), item) : undefined;
  return ConsultationLookupResponseSchema.parse({
    source: CONSULTATION_SOURCE, observedAt: meta.observedAt, asOf, item, revisions,
    ...(noticeEvidence ? { participationNotices: noticeEvidence } : {}),
  });
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = z.url({ protocol: /^https?$/ }).safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function participationNotices(db: D1Database, id: string, revision: string, facts: z.infer<typeof ConsultationFactsSchema>) {
  // Exact revision, consultation ID and language prevent older notice text from being attached to this record.
  const result = await db.prepare(`SELECT * FROM notices
    WHERE catalogue_revision=? AND consultation_id=? AND language IN ('en','fr') ORDER BY language`)
    .bind(revision, id).all<Record<string, unknown>>();
  const editions = result.results.map((row) => noticeEdition(row, id, revision, facts));
  return { catalogueRevision: revision, editions };
}

type NoticeSource = { order: number; status: string; sourceUrl: string | null; finalUrl: string | null;
  sourceHash: string | null; sourceBytes: number | null };

function sourceRowsFor(row: Record<string, unknown>, status: string): unknown[] {
  const sourceData = row.sources_json === undefined || row.sources_json === null ? undefined : json(row.sources_json);
  if (Array.isArray(sourceData) && sourceData.length) return sourceData;
  if (Array.isArray(sourceData) && !row.body_sha256) return [];
  if (sourceData !== undefined && !Array.isArray(sourceData)) return [];
  return [{ status, sourceUrl: row.published_url, finalUrl: row.final_url,
    sha256: row.body_sha256, bytes: row.body_bytes }];
}

function noticeSource(entry: unknown, index: number, status: string, expectedUrls: string[]): NoticeSource | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const source = entry as Record<string, unknown>;
  const sourceUrl = httpUrl(source['sourceUrl'] ?? source['published_url'] ?? source['url']);
  const finalUrl = httpUrl(source['finalUrl'] ?? source['final_url']);
  const sourceHash = nullableString(source['sourceHash'] ?? source['bodySha256'] ?? source['sha256'] ?? source['body_sha256']);
  assertNoticeHash(sourceHash);
  if (sourceUrl && (!expectedUrls.length || !expectedUrls.includes(sourceUrl))) {
    throw new Error('Consultation notice URL does not match its exact catalogue edition.');
  }
  const bytes = source['sourceBytes'] ?? source['bodyBytes'] ?? source['bytes'];
  return { order: typeof source['order'] === 'number' ? source['order'] : index,
    status: String(source['status'] ?? status), sourceUrl, finalUrl, sourceHash,
    sourceBytes: bytes === null || bytes === undefined ? null : Number(bytes) };
}

function assertNoticeHash(hash: string | null): void {
  if (hash && !/^[a-f0-9]{64}$/u.test(hash)) throw new Error('Consultation notice source hash is invalid.');
}

function expectedProfileUrls(facts: z.infer<typeof ConsultationFactsSchema>, language: Language): string[] {
  const profile = facts.editions[language].profile;
  const candidates = [profile.url, profile.unwrapped, profile.published].filter((value): value is string => Boolean(value)).flatMap((value) => {
    const decoded = decodeUrl(value);
    return [value, decoded].flatMap((entry) => entry.split(/\s+;\s+/u));
  });
  const replacements: Record<string, string> = noticeReplacements;
  const urls = candidates.flatMap(value => [value, replacements[value]]).map(httpUrl);
  return [...new Set(urls.filter((value): value is string => value !== null))];
}

function decodeUrl(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function isNoticeSection(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return ['eligibility', 'deadline', 'submission-instructions'].includes(String(data['kind'])) &&
    typeof data['heading'] === 'string' && typeof data['text'] === 'string' && Boolean(data['text']);
}

function noticeSourceForSection(data: Record<string, unknown>, fetchedSources: NoticeSource[]) {
  const sourceUrl = httpUrl(data['sourceUrl'] ?? data['source_url'])
    ?? (fetchedSources.length === 1 ? fetchedSources[0]?.sourceUrl ?? null : null);
  const sourceHash = nullableString(data['bodySha256'] ?? data['sourceHash'] ?? data['sha256'])
    ?? fetchedSources.find((source) => source.sourceUrl === sourceUrl)?.sourceHash ?? null;
  const source = fetchedSources.find((candidate) => candidate.sourceUrl === sourceUrl && candidate.sourceHash === sourceHash);
  return source && sourceUrl && sourceHash ? { sourceUrl, sourceHash } : null;
}

function noticeSection(section: unknown, fetchedSources: NoticeSource[]) {
  if (!isNoticeSection(section)) return [];
  const data = section;
  const sourceMatch = noticeSourceForSection(data, fetchedSources);
  if (!sourceMatch) return [];
  const { sourceUrl, sourceHash } = sourceMatch;
  const citation = new URL(sourceUrl);
  const fragment = data['fragment'];
  if (typeof fragment === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/u.test(fragment)) citation.hash = fragment;
  const sectionText = data['text'];
  if (typeof sectionText !== 'string') return [];
  const text = sectionText.slice(0, 4000);
  return [{ kind: data['kind'], heading: data['heading'], citationUrl: citation.href,
    sourceUrl, sourceHash, quote: text, truncated: sectionText.length > text.length }];
}

function noticeEdition(row: Record<string, unknown>, id: string, revision: string,
  facts: z.infer<typeof ConsultationFactsSchema>) {
  const language = ConsultationLanguageSchema.parse(row.language);
  const status = String(row.status);
  const expectedUrls = expectedProfileUrls(facts, language);
  const sources = sourceRowsFor(row, status).flatMap((entry, index) => {
    const source = noticeSource(entry, index, status, expectedUrls);
    return source ? [source] : [];
  });
  const fetchedSources = sources.filter((source) => source.status === 'fetched' && source.sourceUrl && source.sourceHash);
  if (status === 'fetched' && !fetchedSources.length) throw new Error('Fetched consultation notice has no source-matched archived content.');
  const rawSections = status === 'fetched' ? json(row.sections_json) : [];
  if (!Array.isArray(rawSections)) throw new Error('Consultation notice sections are invalid.');
  const sections = rawSections.flatMap((section) => noticeSection(section, fetchedSources));
  const singleFetchedSource = fetchedSources.length === 1 ? fetchedSources[0] : null;
  return {
    consultationId: id, catalogueRevision: revision, language, status,
    checkedAt: row.checked_at,
    httpStatus: row.http_status === null || row.http_status === undefined ? null : Number(row.http_status),
    sourceHash: singleFetchedSource?.sourceHash ?? null,
    sourceBytes: singleFetchedSource?.sourceBytes ?? null,
    sourceUrl: singleFetchedSource?.sourceUrl ?? null,
    finalUrl: singleFetchedSource?.finalUrl ?? null,
    sources,
    ...(row.last_attempt_status === undefined ? {} : { lastAttemptStatus: row.last_attempt_status ?? null }),
    ...(row.last_attempt_at === undefined ? {} : { lastAttemptAt: row.last_attempt_at ?? null }),
    sections,
  };
}

async function coverage(db: D1Database, institution: string | undefined, asOf: string) {
  const meta = requireCatalogue((await catalogue(db).first<Record<string, unknown>>()) ?? undefined);
  const ownerFilter = institution ? 'AND owner_org=?' : '';
  const revisionFilter = institution ? 'JOIN consultations_records c ON c.id=r.id WHERE c.owner_org=?' : '';
  const ownerBindings = institution ? [institution, institution, institution] : [];
  // Keep the bilingual descriptions and search indexes inside D1. Materialize only
  // the fields needed by the status histogram and the catalogue-wide totals.
  const row = await db.prepare(`WITH current AS MATERIALIZED (
    SELECT status_code, ${stateSql} AS state, julianday(observed_at) < julianday(?) AS stale,
      report_available, json_extract(facts_json,'$.editions.en.profile.kind') AS profile,
      coalesce(json_extract(facts_json,'$.editions.fr.title'),'')='' AS missing_title,
      coalesce(json_extract(facts_json,'$.editions.fr.description'),'')='' AS missing_description
    FROM consultations_records WHERE removed_at IS NULL ${ownerFilter}
  )
  SELECT count(*) AS total,
    count(*) FILTER (WHERE state='open') AS open, count(*) FILTER (WHERE state='planned') AS planned,
    count(*) FILTER (WHERE state='closed') AS closed, count(*) FILTER (WHERE state='unknown') AS unknown,
    count(*) FILTER (WHERE stale) AS stale, count(*) FILTER (WHERE report_available=1) AS available,
    count(*) FILTER (WHERE missing_title) AS missingTitleFr,
    count(*) FILTER (WHERE missing_description) AS missingDescriptionFr,
    count(*) FILTER (WHERE profile='official') AS official,
    count(*) FILTER (WHERE profile='third-party-wrapper') AS wrapped,
    count(*) FILTER (WHERE profile='missing') AS missing, count(*) FILTER (WHERE profile='unparsable') AS unparsable,
    (SELECT json_group_object(status_code, n) FROM (SELECT status_code, count(*) AS n FROM current GROUP BY status_code)) AS statuses,
    (SELECT count(*) FROM consultations_records WHERE removed_at IS NOT NULL ${ownerFilter}) AS removed,
    (SELECT count(*) FROM consultations_revisions r ${revisionFilter}) AS revisions
  FROM current`).bind(asOf, asOf, String(meta.observedAt), ...ownerBindings).first<Record<string, unknown>>();
  if (!row) throw new Error('Consultation coverage totals are unavailable.');
  return ConsultationCoverageSchema.parse({
    source: CONSULTATION_SOURCE, observedAt: meta.observedAt, csvSha256: meta.csvSha256, schemaSha256: meta.schemaSha256,
    counts: { total: row.total, byState: { open: row.open, planned: row.planned, closed: row.closed, unknown: row.unknown },
      statusCodes: json(row.statuses), removed: row.removed, stale: row.stale },
    editions: { missingDescriptionFr: row.missingDescriptionFr, missingTitleFr: row.missingTitleFr,
      profileLinkKinds: { official: row.official, 'third-party-wrapper': row.wrapped, missing: row.missing, unparsable: row.unparsable } },
    reports: { available: row.available }, revisions: { total: row.revisions },
  });
}

async function readPublished<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof AccessError || error instanceof RequestInputError) throw error;
    throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Unable to read the consultation catalogue.', 503);
  }
}

export function prepareConsultations(url: URL) {
  if (url.pathname === CONSULTATIONS_OPENAPI_PATH) return undefined;
  if (url.pathname === `${CONSULTATIONS_API_PATH}/coverage`) {
    return (env: Env) => {
      if (env.CONSULTATIONS_PREVIEW !== 'on') throw new AccessError('UNSUPPORTED_COVERAGE', 'The consultations preview is disabled.', 501);
      const db = env.CONSULTATIONS_DB ?? env.CIVIC_DB;
      if (!db) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Consultation storage is unavailable.', 503);
      const input = args(url.searchParams, ConsultationCoverageQuery, 'coverage');
      const asOf = instant(input.asOf);
      return () => readPublished(() => coverage(db, input.institution, asOf));
    };
  }
  if (url.pathname === CONSULTATIONS_API_PATH) {
    return (env: Env) => {
      if (env.CONSULTATIONS_PREVIEW !== 'on') throw new AccessError('UNSUPPORTED_COVERAGE', 'The consultations preview is disabled.', 501);
      const db = env.CONSULTATIONS_DB ?? env.CIVIC_DB;
      if (!db) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Consultation storage is unavailable.', 503);
      const input = args(url.searchParams, ConsultationSearchQuery, 'search');
      const asOf = instant(input.asOf);
      return () => readPublished(() => search(db, input, asOf));
    };
  }
  const match = new RegExp(`^${CONSULTATIONS_API_PATH}/([^/]+)$`).exec(url.pathname);
  if (!match || match[1] === 'openapi.json') return undefined;
  return (env: Env) => {
    if (env.CONSULTATIONS_PREVIEW !== 'on') throw new AccessError('UNSUPPORTED_COVERAGE', 'The consultations preview is disabled.', 501);
    const db = env.CONSULTATIONS_DB ?? env.CIVIC_DB;
    if (!db) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Consultation storage is unavailable.', 503);
    const id = match[1] ?? '';
    // The registration keeps the publisher's case: `c-ISC0016` and `c-isc0016` are different consultations.
    if (!/^[a-z0-9.-]+_[A-Za-z0-9.-]+$/.test(id)) throw new RequestInputError('Invalid consultation identifier.');
    const input = args(url.searchParams, ConsultationLookupQuery, 'lookup');
    const asOf = instant(input.asOf);
    return () => readPublished(() => lookupConsultation(db, id, asOf, env.CONSULTATION_NOTICES_DB));
  };
}
