import { z } from 'zod';
import { AccessError } from '../access';
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

async function search(db: D1Database, input: SearchInput, asOf: string) {
  const metaResult = await catalogue(db).first<Record<string, unknown>>();
  const meta = requireCatalogue(metaResult ?? undefined);
  const clauses = [`${input.language === 'en' ? 'search_en' : 'search_fr'} LIKE '%' || ? || '%' ESCAPE '\\'`];
  const normalizedQuery = normalizeForSearch(input.query);
  const bindings: (string | number)[] = [escapeLike(normalizedQuery)];
  if (input.institution) { clauses.push('owner_org=?'); bindings.push(input.institution); }
  if (input.subject) {
    clauses.push(`EXISTS (SELECT 1 FROM json_each(facts_json, '$.subjects') subject
      WHERE json_extract(subject.value, '$.code')=?)`);
    bindings.push(input.subject);
  }
  const stateSql = `CASE
    WHEN start_date IS NULL OR end_date IS NULL THEN 'unknown'
    WHEN ? < (start_date || 'T00:00:00.000Z') THEN 'planned'
    WHEN ? > (end_date || 'T23:59:59.999Z') THEN 'closed'
    ELSE 'open' END`;
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

async function lookup(db: D1Database, id: string, asOf: string) {
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
  return ConsultationLookupResponseSchema.parse({
    source: CONSULTATION_SOURCE, observedAt: meta.observedAt, asOf, item, revisions,
  });
}

async function coverage(db: D1Database, institution: string | undefined, asOf: string) {
  const meta = requireCatalogue((await catalogue(db).first<Record<string, unknown>>()) ?? undefined);
  const filter = institution ? 'WHERE owner_org=?' : '';
  const records = await db.prepare(`SELECT * FROM consultations_records ${filter} ORDER BY id`)
    .bind(...(institution ? [institution] : [])).all<Record<string, unknown>>();
  const revisions = await db.prepare(`SELECT count(*) AS total FROM consultations_revisions r
    ${institution ? 'JOIN consultations_records c ON c.id=r.id WHERE c.owner_org=?' : ''}`)
    .bind(...(institution ? [institution] : [])).first<Record<string, unknown>>();
  const counts = { total: 0, byState: { open: 0, planned: 0, closed: 0, unknown: 0 }, statusCodes: {} as Record<string, number>, stale: 0 };
  const editions = { missingDescriptionFr: 0, missingTitleFr: 0,
    profileLinkKinds: { official: 0, 'third-party-wrapper': 0, missing: 0, unparsable: 0 } };
  let reportsAvailable = 0;
  for (const row of records.results) {
    const facts = ConsultationFactsSchema.parse(json(row.facts_json));
    counts.total++;
    counts.byState[stateAsOf(facts.dates, asOf).state]++;
    counts.statusCodes[facts.statusCode] = (counts.statusCodes[facts.statusCode] ?? 0) + 1;
    if (Date.parse(String(row.observed_at)) < Date.parse(String(meta.observedAt))) counts.stale++;
    if (!facts.editions.fr.description) editions.missingDescriptionFr++;
    if (!facts.editions.fr.title) editions.missingTitleFr++;
    editions.profileLinkKinds[facts.editions.en.profile.kind]++;
    if (row.report_available === 1 || row.report_available === true) reportsAvailable++;
  }
  return ConsultationCoverageSchema.parse({
    source: CONSULTATION_SOURCE, observedAt: meta.observedAt,
    csvSha256: meta.csvSha256, schemaSha256: meta.schemaSha256, counts, editions,
    reports: { available: reportsAvailable }, revisions: { total: numeric(revisions ?? {}, 'total') },
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
      const db = env.CIVIC_DB;
      if (!db) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Consultation storage is unavailable.', 503);
      const input = args(url.searchParams, ConsultationCoverageQuery, 'coverage');
      const asOf = instant(input.asOf);
      return () => readPublished(() => coverage(db, input.institution, asOf));
    };
  }
  if (url.pathname === CONSULTATIONS_API_PATH) {
    return (env: Env) => {
      if (env.CONSULTATIONS_PREVIEW !== 'on') throw new AccessError('UNSUPPORTED_COVERAGE', 'The consultations preview is disabled.', 501);
      const db = env.CIVIC_DB;
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
    const db = env.CIVIC_DB;
    if (!db) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Consultation storage is unavailable.', 503);
    const id = match[1] ?? '';
    // The registration keeps the publisher's case: `c-ISC0016` and `c-isc0016` are different consultations.
    if (!/^[a-z0-9.-]+_[A-Za-z0-9.-]+$/.test(id)) throw new RequestInputError('Invalid consultation identifier.');
    const input = args(url.searchParams, ConsultationLookupQuery, 'lookup');
    const asOf = instant(input.asOf);
    return () => readPublished(() => lookup(db, id, asOf));
  };
}
