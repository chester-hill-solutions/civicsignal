import { z } from 'zod';
import { AccessError } from '../access';
import { FundingCatalogueCoverage, FundingEdition, FundingLanguage, FundingLookupResponse,
  FundingMatch, FundingSearchResponse, FundingSource, FundingStatus, FundingVersionsResponse } from '../corpora/funding';
import { RequestInputError } from '../http';
import { normalizeForSearch } from '../text';
import type { Env } from '../types';

export const FUNDING_API_PATH = '/api/funding-programs';
export const FUNDING_OPENAPI_PATH = `${FUNDING_API_PATH}/openapi.json`;
const pageNumber = z.string().regex(/^\d{1,9}$/).transform(Number);
export const FundingCoverageQuery = z.strictObject({ source: FundingSource });
export const FundingLookupQuery = z.strictObject({ language: FundingLanguage });
export const FundingListQuery = z.strictObject({
  source: FundingSource,
  language: FundingLanguage,
  query: z.string().trim().min(1).max(300).optional(),
  status: FundingStatus.optional(),
  offset: pageNumber.default(0),
  limit: pageNumber.pipe(z.number().int().min(1).max(100)).default(25),
  revision: z.string().min(1).max(200).optional(),
});
export const FundingVersionsQuery = z.strictObject({
  language: FundingLanguage,
  offset: pageNumber.default(0),
  limit: pageNumber.pipe(z.number().int().min(1).max(100)).default(25),
  revision: z.string().min(1).max(200).optional(),
});

function args<T>(params: URLSearchParams, schema: z.ZodType<T>, name: string): T {
  const raw = Object.fromEntries(params);
  if (Object.keys(raw).length !== params.size) throw new RequestInputError('Supply each parameter once.');
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new RequestInputError(`Invalid funding ${name} parameters.`);
  return parsed.data;
}

function json(value: unknown) { return typeof value === 'string' ? JSON.parse(value) as unknown : value; }
function readEdition(row: Record<string, unknown>) {
  const { sections_json, ...edition } = row;
  return FundingEdition.parse({ ...edition, sections: json(sections_json) });
}
function catalogue(db: D1Database, source: z.infer<typeof FundingSource>) {
  return db.prepare(`SELECT source, observed_at AS observedAt, revision, indexes_json, gaps_json
    FROM funding_catalogues WHERE source=?`).bind(source);
}
type CoverageTotals = { records: number; en: { total: number; searchable: number; metadataOnly: number };
  fr: { total: number; searchable: number; metadataOnly: number } };
function coverage(source: z.infer<typeof FundingSource>, rows: unknown[], totals: CoverageTotals) {
  if (!rows.length) throw new AccessError('UNSUPPORTED_COVERAGE', 'No published funding inventory for this source.', 501);
  const row = z.record(z.string(), z.unknown()).parse(rows[0]);
  const { indexes_json, gaps_json, ...catalogueRow } = row;
  return FundingCatalogueCoverage.parse({ ...catalogueRow, indexes: json(indexes_json), gaps: json(gaps_json),
    records: totals.records, recordsPerLanguage: { en: totals.en, fr: totals.fr } });
}

function snippet(text: string, query = '') {
  const normalized = normalizeForSearch(text);
  const needle = normalizeForSearch(query);
  const index = normalized.indexOf(needle);
  const start = Math.max(0, index < 0 ? 0 : index - 110);
  const end = Math.min(text.length, start + 260);
  return (start ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

function searchSectionSql(query?: string) {
  const match = query ? `AND instr(section.normalized_heading || ' ' || section.normalized_text, ?) > 0` : '';
  const start = query ? 'max(1, instr(section.normalized_text, ?) - 110)' : '1';
  return `(SELECT json_object('field', section.field, 'heading', section.heading,
      'text', substr(section.text, ${start}, 260), 'url', section.url)
    FROM funding_sections AS section WHERE section.source=f.source AND section.id=f.id AND section.language=f.language
      ${match} ORDER BY section.section_index LIMIT 1)`;
}

async function list(db: D1Database, input: z.output<typeof FundingListQuery>) {
  const clauses = ['source=?', 'language=?'];
  const bindings: (string | number)[] = [input.source, input.language];
  if (input.query) { clauses.push('instr(search_text, ?) > 0'); bindings.push(normalizeForSearch(input.query)); }
  if (input.status) { clauses.push('status=?'); bindings.push(input.status); }
  const section = searchSectionSql(input.query);
  const statement = db.prepare(`SELECT f.id, f.revision, f.language, f.title, f.url, f.status,
    f.status_text AS statusText, f.availability, ${section} AS matched_section_json
    FROM funding_editions AS f WHERE ${clauses.map(clause => clause.startsWith('source=') ? 'f.' + clause : clause).join(' AND ')}
    ORDER BY f.title COLLATE NOCASE, f.id LIMIT ? OFFSET ?`)
    .bind(...(input.query ? [normalizeForSearch(input.query), normalizeForSearch(input.query)] : []), ...bindings, input.limit + 1, input.offset);
  const [inventory, rows] = await db.batch<Record<string, unknown>>([
    catalogue(db, input.source),
    statement,
  ]);
  if (!inventory.results.length) throw new AccessError('UNSUPPORTED_COVERAGE', 'No published funding inventory for this source.', 501);
  const revision = String(inventory.results[0]?.revision ?? '');
  if (input.revision && input.revision !== revision) throw new RequestInputError('The funding inventory revision changed. Restart pagination.');
  const items = rows.results.slice(0, input.limit).map((row) => {
    const { matched_section_json, ...editionRow } = row;
    const edition = FundingEdition.parse({ ...editionRow, sections: [] });
    const rawMatch = matched_section_json ? json(matched_section_json) as Record<string, unknown> : null;
    const match = rawMatch ? FundingMatch.parse({ section: rawMatch.field, heading: rawMatch.heading,
      snippet: snippet(String(rawMatch.text), input.query), url: rawMatch.url })
      : { section: 'other' as const, heading: edition.title,
        snippet: snippet([edition.title, edition.statusText].filter(Boolean).join(' — '), input.query), url: edition.url };
    return { id: edition.id, revision: String(row.revision), language: edition.language, title: edition.title,
      url: edition.url, status: edition.status, statusText: edition.statusText, availability: edition.availability, match };
  });
  return FundingSearchResponse.parse({ source: input.source, revision, items,
    nextOffset: rows.results.length > input.limit ? input.offset + input.limit : null });
}

export async function lookupFundingEdition(db: D1Database, source: z.infer<typeof FundingSource>, id: string, language: z.infer<typeof FundingLanguage>) {
  const [inventory, row] = await db.batch<Record<string, unknown>>([
    catalogue(db, source),
    db.prepare(`SELECT id, revision, language, title, url, status, status_text AS statusText, availability, sections_json
      FROM funding_editions WHERE source=? AND id=? AND language=?`).bind(source, id, language),
  ]);
  if (!inventory.results.length) throw new AccessError('UNSUPPORTED_COVERAGE', 'No published funding inventory for this source.', 501);
  return FundingLookupResponse.parse({ source, revision: inventory.results[0]?.revision,
    item: row.results[0] ? readEdition(row.results[0]) : null });
}

async function versions(db: D1Database, source: z.infer<typeof FundingSource>, id: string,
  input: z.output<typeof FundingVersionsQuery>) {
  const inventory = await catalogue(db, source).all<Record<string, unknown>>();
  const snapshot = inventory.results[0];
  if (!snapshot) throw new AccessError('UNSUPPORTED_COVERAGE', 'No published funding inventory for this source.', 501);
  const currentRevision = String(snapshot.revision ?? '');
  if (input.revision && input.revision !== currentRevision) throw new RequestInputError('The funding inventory revision changed. Restart version pagination.');
  const versionRows = await db.prepare(`SELECT observed_at AS observedAt, revision, event, edition_json
    FROM funding_versions WHERE source=? AND id=? AND language=? AND observed_at<=?
    ORDER BY observed_at DESC, revision DESC LIMIT ? OFFSET ?`)
    .bind(source, id, input.language, String(snapshot.observedAt ?? snapshot.observed_at), input.limit + 1, input.offset)
    .all<Record<string, unknown>>();
  const items = versionRows.results.slice(0, input.limit).map(({ edition_json, ...row }) => ({ ...row, edition: json(edition_json) }));
  return FundingVersionsResponse.parse({ source, id, language: input.language, revision: currentRevision, items,
    nextOffset: versionRows.results.length > input.limit ? input.offset + input.limit : null });
}

export function prepareFunding(url: URL) {
  if (url.pathname === FUNDING_OPENAPI_PATH) return undefined;
  if (url.pathname === `${FUNDING_API_PATH}/coverage`) {
    return (env: Env) => {
      if (env.FUNDING_PREVIEW !== 'on') throw new AccessError('UNSUPPORTED_COVERAGE', 'The funding programme preview is disabled.', 501);
      const db = env.CIVIC_DB;
      if (!db) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Funding catalogue storage is unavailable.', 503);
      const { source } = args(url.searchParams, FundingCoverageQuery, 'coverage');
      return () => readPublished(async () => {
        const [meta, counts] = await db.batch<Record<string, unknown>>([catalogue(db, source),
          db.prepare(`SELECT count(*) AS total_count,
            count(*) FILTER (WHERE language='en') AS en_total,
            count(*) FILTER (WHERE language='en' AND availability='published') AS en_searchable,
            count(*) FILTER (WHERE language='en' AND availability='metadata-only') AS en_metadata,
            count(*) FILTER (WHERE language='fr') AS fr_total,
            count(*) FILTER (WHERE language='fr' AND availability='published') AS fr_searchable,
            count(*) FILTER (WHERE language='fr' AND availability='metadata-only') AS fr_metadata
            FROM funding_editions WHERE source=?`).bind(source)]);
        const count = z.record(z.string(), z.unknown()).parse(counts.results[0] ?? {});
        return coverage(source, meta.results, { records: Number(count.total_count ?? 0),
          en: { total: Number(count.en_total ?? 0), searchable: Number(count.en_searchable ?? 0), metadataOnly: Number(count.en_metadata ?? 0) },
          fr: { total: Number(count.fr_total ?? 0), searchable: Number(count.fr_searchable ?? 0), metadataOnly: Number(count.fr_metadata ?? 0) } });
      });
    };
  }
  const match = /^\/api\/funding-programs(?:\/([^/]+))?(?:\/(versions))?$/.exec(url.pathname);
  if (!match) return undefined;
  const id = match[1];
  const suffix = match[2];
  if (id === 'openapi.json' || (id === undefined && suffix)) return undefined;
  return (env: Env) => {
    if (env.FUNDING_PREVIEW !== 'on') throw new AccessError('UNSUPPORTED_COVERAGE', 'The funding programme preview is disabled.', 501);
    const db = env.CIVIC_DB;
    if (!db) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Funding catalogue storage is unavailable.', 503);
    if (id === undefined) {
      const input = args(url.searchParams, FundingListQuery, 'list');
      return () => readPublished(() => list(db, input));
    }
    const identity = /^(nserc|esdc)-[a-z0-9]+(?:-[a-z0-9]+)*$/.exec(id);
    if (!identity) throw new RequestInputError('Invalid funding programme identifier.');
    const source = identity[1] as z.infer<typeof FundingSource>;
    if (suffix === 'versions') {
      const input = args(url.searchParams, FundingVersionsQuery, 'versions');
      return () => readPublished(() => versions(db, source, id, input));
    }
    const input = args(url.searchParams, FundingLookupQuery, 'lookup');
    return () => readPublished(() => lookupFundingEdition(db, source, id, input.language));
  };
}

async function readPublished<T>(read: () => Promise<T>) {
  try { return await read(); }
  catch (error) {
    if (error instanceof AccessError || error instanceof RequestInputError) throw error;
    throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Unable to read the funding catalogue.', 503);
  }
}

