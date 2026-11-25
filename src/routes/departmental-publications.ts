import { z } from 'zod';
import { AccessError } from '../access';
import { RequestInputError } from '../http';
import type { Env } from '../types';

const base = '/api/departmental-publications';
export const DEPARTMENTAL_OPENAPI_PATH = base + '/openapi.json';
const language = z.enum(['en', 'fr']);
const page = {
  limit: z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/).transform(Number).default(20),
  cursor: z.string().regex(/^[a-f0-9]{64}\.[1-9]\d{0,8}$/).optional(),
};
const listQuery = z.strictObject({ ...page, query: z.string().trim().min(1).max(256).regex(/[\p{L}\p{N}]/u),
  language, institution: z.literal('ECCC').optional(), series: z.enum(['eval', 'audit']).optional(),
  workId: z.string().trim().min(1).max(240).optional(), fiscalYear: z.string().trim().min(1).max(32).optional(), kind: z.string().trim().min(1).max(48).optional() });
const editionQuery = z.strictObject({ language });
const versionQuery = z.strictObject({ language, ...page });
const coverageQuery = z.strictObject(page);

function input<T>(url: URL, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(Object.fromEntries(url.searchParams));
  if (new Set(url.searchParams.keys()).size !== url.searchParams.size || !parsed.success) {
    throw new RequestInputError('Invalid departmental publication parameters.');
  }
  return parsed.data;
}

type Page = { limit: number; cursor?: string };
async function readPage(db: D1Database, path: string, query: Page, generation: string, statement: { sql: string; args: string[] }) {
  const { cursor, limit, ...filters } = query;
  const bytes = new TextEncoder().encode(JSON.stringify([path, filters, generation]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const scope = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const [key, offsetText] = cursor?.split('.') ?? [];
  if (cursor && key !== scope) throw new RequestInputError('The cursor does not match this publication or query.');
  const offset = Number(offsetText ?? 0);
  const { results } = await db.prepare(statement.sql + ' LIMIT ? OFFSET ?').bind(...statement.args, limit + 1, offset).all();
  return { items: results.slice(0, limit), nextCursor: results.length > limit ? scope + '.' + (offset + limit) : null };
}

type Generation = { built_at: string; catalogue_cutoff: string; documents_seen: number;
  documents_extracted: number; passages: number; revision: string };
async function generation(db: D1Database) {
  const meta = await db.prepare(`SELECT e.built_at,e.catalogue_cutoff,e.documents_seen,e.documents_extracted,
    e.passages,i.revision FROM dp_extraction_runs e JOIN dp_inventory i USING (singleton) WHERE e.singleton=1`).first<Generation>();
  if (!meta) throw new AccessError('UNSUPPORTED_COVERAGE', 'No departmental publication generation is available.', 501);
  return meta;
}

async function search(db: D1Database, path: string, query: z.output<typeof listQuery>, meta: Generation) {
  const clauses = ['dp_passages_fts MATCH ?', 'p.language=?'];
  const args = ['"' + query.query.replaceAll('"', '""') + '"', query.language];
  for (const [column, value] of [['w.series', query.series], ['e.fiscal_year', query.fiscalYear], ['d.kind', query.kind], ['p.work_id', query.workId]] as const) {
    if (value) { clauses.push(column + '=?'); args.push(value); }
  }
  return readPage(db, path, query, meta.built_at, { args, sql:
    `SELECT p.passage_id,p.kind AS passage_kind,p.document_id,p.work_id,p.language,w.series,e.title,e.fiscal_year,d.kind AS document_kind,
    p.text,p.section,p.page,p.table_number,p.table_caption,p.row_number,p.column_number,p.attribution,p.citation_url,p.source_sha256
    FROM dp_passages_fts JOIN dp_passages p ON p.rowid=dp_passages_fts.rowid
    JOIN dp_documents d ON d.id=p.document_id JOIN dp_works w ON w.id=p.work_id
    JOIN dp_editions e ON e.work_id=p.work_id AND e.language=p.language WHERE ${clauses.join(' AND ')}
    ORDER BY rank,p.passage_id` });
}

async function readEdition(db: D1Database, id: string, lang: string) {
  const edition = await db.prepare(`SELECT e.*,w.series,w.revision FROM dp_editions e
    JOIN dp_works w ON w.id=e.work_id WHERE e.work_id=? AND e.language=?`).bind(id, lang).first();
  if (!edition) throw new AccessError('NOT_FOUND', 'No published departmental edition matches this identifier and language.', 404);
  return edition;
}

export function prepareDepartmentalPublications(url: URL) {
  if (url.pathname !== base && !url.pathname.startsWith(base + '/')) return undefined;
  const suffix = url.pathname.slice(base.length);
  const exact = /^\/(eccc-[\p{L}\p{N}-]+)(\/versions)?$/u.exec(suffix);
  if (suffix && suffix !== '/coverage' && !exact) return undefined;
  return (env: Env) => {
    if (env.DEPARTMENTAL_PUBLICATIONS_PREVIEW !== 'on') throw new AccessError('UNSUPPORTED_COVERAGE', 'Departmental publications preview is disabled.', 501);
    const db = env.DEPARTMENTAL_PUBLICATIONS_DB;
    if (!db) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Departmental publications storage is unavailable.', 503);
    const request = suffix === '' ? { kind: 'search', query: input(url, listQuery) } as const
      : suffix === '/coverage' ? { kind: 'coverage', query: input(url, coverageQuery) } as const
      : exact?.[2] ? { kind: 'versions', query: input(url, versionQuery) } as const
      : { kind: 'edition', query: input(url, editionQuery) } as const;
    return async () => {
      const meta = await generation(db);
      const source = { institution: 'ECCC', observedAt: meta.catalogue_cutoff, revision: meta.revision };
      if (request.kind === 'search') return { ...source, ...await search(db, url.pathname, request.query, meta) };
      if (request.kind === 'coverage') {
        const gaps = await readPage(db, url.pathname, request.query, meta.built_at, { args: [], sql:
          `SELECT id,kind,language,url,reason FROM dp_gaps UNION ALL SELECT
           json_extract(j.value,'$.document_id') AS id,'extraction' AS kind,d.language,d.url,
           json_extract(j.value,'$.reason') AS reason FROM dp_extraction_runs e, json_each(e.gaps_json) j
           JOIN dp_documents d ON d.id=json_extract(j.value,'$.document_id') ORDER BY kind,id` });
        return { ...source, documents: meta.documents_seen, searchableDocuments: meta.documents_extracted,
          passages: meta.passages, gaps: gaps.items, nextCursor: gaps.nextCursor };
      }
      const id = exact?.[1];
      if (!id) throw new RequestInputError('Missing publication identifier.');
      const edition = await readEdition(db, id, request.query.language);
      if (request.kind === 'versions') return { ...source, edition, ...await readPage(db, url.pathname, request.query, meta.built_at, { args: [id, request.query.language], sql:
        `SELECT v.document_id,d.url,v.content_sha256,v.sha256,v.observed_at,v.media,v.bytes
         FROM dp_document_versions v JOIN dp_documents d ON d.id=v.document_id
         WHERE d.work_id=? AND d.language=? ORDER BY v.observed_at DESC,v.document_id,v.content_sha256` }) };
      const docs = await db.prepare(`SELECT id,kind,label,url,final_url,status,sha256 FROM dp_documents
        WHERE work_id=? AND language=? ORDER BY kind,id`).bind(id, request.query.language).all();
      return { ...source, edition, documents: docs.results };
    };
  };
}

const text = z.string();
const optionalText = text.nullable();
const integer = z.number().int();
const sourceInfo = { institution: z.literal('ECCC'), observedAt: text, revision: text };
const editionInfo = z.object({ work_id: text, language, fiscal_year: text, title: text, lead: optionalText,
  index_url: text, first_observed_at: text, last_observed_at: text, series: text, revision: integer });
const passageInfo = z.object({ passage_id: text, passage_kind: text, document_id: text, work_id: text,
  language, series: text, title: text, fiscal_year: text, document_kind: text, text, section: optionalText,
  page: integer.nullable(), table_number: integer.nullable(), table_caption: optionalText,
  row_number: integer.nullable(), column_number: integer.nullable(), attribution: optionalText,
  citation_url: text, source_sha256: text });
const versionInfo = z.object({ document_id: text, url: text, content_sha256: text, sha256: text,
  observed_at: text, media: optionalText, bytes: integer });
const documentInfo = z.object({ id: text, kind: text, label: text, url: text, final_url: optionalText,
  status: text, sha256: optionalText });
const gapInfo = z.object({ id: text, kind: text, language: language.nullable(), url: optionalText, reason: text });
const searchResult = z.object({ ...sourceInfo, items: z.array(passageInfo), nextCursor: optionalText });
const coverageResult = z.object({ ...sourceInfo, documents: integer, searchableDocuments: integer,
  passages: integer, gaps: z.array(gapInfo), nextCursor: optionalText });
const editionResult = z.object({ ...sourceInfo, edition: editionInfo, documents: z.array(documentInfo) });
const versionsResult = z.object({ ...sourceInfo, edition: editionInfo, items: z.array(versionInfo), nextCursor: optionalText });

export function departmentalOpenApi() {
  const operations = [
    [base, 'Search published ECCC passages and table cells', listQuery, searchResult],
    [base + '/coverage', 'Read inventory totals and page through acquisition and extraction gaps', coverageQuery, coverageResult],
    [base + '/{id}', 'Read an edition and its source documents', editionQuery, editionResult],
    [base + '/{id}/versions', 'Read observed document versions for this edition', versionQuery, versionsResult],
  ] as const;
  const paths = Object.fromEntries(operations.map(([path, summary, query, response]) => {
    const parameters: { name: string; in: string; required: boolean; schema: Record<string, unknown> }[] = Object.entries(query.shape).map(([name, schema]) => ({ name, in: 'query',
      required: !schema.safeParse(undefined).success, schema: z.toJSONSchema(schema, { io: 'input' }) }));
    if (path.includes('{id}')) parameters.push({ name: 'id', in: 'path', required: true, schema: { type: 'string' } });
    return [path, { get: { summary, parameters, responses: { 200: { description: summary,
      content: { 'application/json': { schema: z.toJSONSchema(response) } } } } } }];
  }));
  return { openapi: '3.1.0', info: { title: 'CivicSignal departmental publications', version: '0.1.0' },
    components: { securitySchemes: { workspaceKey: { type: 'http', scheme: 'bearer' } } }, security: [{ workspaceKey: [] }], paths };
}
