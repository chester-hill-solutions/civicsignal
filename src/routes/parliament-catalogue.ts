import { z } from 'zod';
import { AccessError } from '../access';
import { BILLS_CANADA } from '../corpora/policies';
import { ParliamentCoverage, ParliamentLanguage, ParliamentList, ParliamentLookup, ParliamentSession,
  childResource, MemberPage, PassagePage, ParliamentCollection, VotePosition, keyPattern } from '../corpora/parliament-catalogue';
import { RequestInputError } from '../http';
import { normalizeForSearch } from '../text';
import type { Env } from '../types';

export const PARLIAMENT_OPENAPI_PATH = '/api/parliament/openapi.json';
const baseQuery = { session: ParliamentSession.default('45-1') };
export const CoverageQuery = z.strictObject(baseQuery);
export const LookupQuery = z.strictObject({ ...baseQuery, language: ParliamentLanguage });
const pageNumber = z.string().regex(/^\d{1,9}$/).transform(Number);
export const ListQuery = z.strictObject({ ...LookupQuery.shape, query: z.string().trim().min(1).max(300).optional(),
  limit: pageNumber.pipe(z.number().int().min(1).max(100)).default(25),
  offset: pageNumber.default(0), revision: z.string().regex(/^[a-f0-9]{64}$/).optional() });
export const MemberQuery = ListQuery.extend({ memberId: z.string().trim().min(1).max(200).optional(), position: VotePosition.optional() });
const projections = 'key, language, title, summary, date, url, details_json';
function edition(row: Record<string, unknown>) {
  return { ...row, details: JSON.parse(String(row.details_json)) };
}

function queryArgs<T>(params: URLSearchParams, schema: z.ZodType<T>) {
  const args = Object.fromEntries(params);
  if (Object.keys(args).length !== params.size) throw new RequestInputError('Supply each parameter once.');
  const result = schema.safeParse(args);
  if (!result.success) throw new RequestInputError('Invalid parliamentary catalogue parameters.');
  return result.data;
}

function coverageStatement(db: D1Database, collection: ParliamentCollection, session: string) {
  const unavailable = collection.endsWith('-journals') ? `,
    (SELECT json_object('en', count(*) FILTER (WHERE language='en'), 'fr', count(*) FILTER (WHERE language='fr'))
     FROM parliament_editions WHERE collection=c.collection AND session=c.session
       AND json_extract(details_json,'$.status')='unavailable') AS unavailable` : '';
  const supplement = collection === 'senate-roll-calls' ? `,
    (SELECT count(*) FROM parliament_editions WHERE collection=c.collection AND session=c.session
      AND language='en' AND key GLOB 'j*') AS journalOnlyRecordsPerLanguage` : '';
  return db.prepare(`SELECT collection, session, observed_at AS observedAt, revision,
    records_per_language AS recordsPerLanguage,
    (SELECT max(ed.date) FROM parliament_editions ed WHERE ed.collection=c.collection AND ed.session=c.session) AS latestRecordDate${unavailable}${supplement}
    FROM parliament_catalogues c WHERE collection=? AND session=?`).bind(collection, session);
}

function coverageFor(collection: ParliamentCollection, rows: unknown[]) {
  if (!rows.length) throw new AccessError('UNSUPPORTED_COVERAGE', 'No published inventory for this session.', 501);
  const row = z.record(z.string(), z.unknown()).parse(rows[0]);
  const attribution = { bills: BILLS_CANADA.attribution, 'house-votes': 'Source: House of Commons of Canada, recorded votes.',
    'senate-votes': 'Source: Senate of Canada, standing votes.',
    'house-journals': 'Source: House of Commons of Canada, Journals.', 'senate-journals': 'Source: Senate of Canada, Journals.',
    'house-roll-calls': 'Source: House of Commons of Canada, recorded votes.', 'senate-roll-calls': 'Source: Senate of Canada, standing votes and Journals.' }[collection];
  return ParliamentCoverage.parse({ ...row, attribution, basis: 'publisher-inventory',
    unavailableEditions: row.unavailable ? JSON.parse(String(row.unavailable)) : undefined });
}

async function list(db: D1Database, collection: ParliamentCollection, args: z.output<typeof ListQuery>) {
  const editions = db.prepare(`SELECT ${projections} FROM parliament_editions WHERE collection=? AND session=?
    AND language=? AND instr(search_text, ?) > 0 ORDER BY date DESC, key LIMIT ? OFFSET ?`)
    .bind(collection, args.session, args.language, normalizeForSearch(args.query ?? ''), args.limit + 1, args.offset);
  const [meta, rows] = await db.batch<Record<string, unknown>>([coverageStatement(db, collection, args.session), editions]);
  const coverage = coverageFor(collection, meta.results);
  if (args.revision && args.revision !== coverage.revision) {
    throw new RequestInputError('The catalogue revision changed. Restart pagination.');
  }
  return ParliamentList.parse({ coverage, items: rows.results.slice(0, args.limit).map(edition),
    nextOffset: rows.results.length > args.limit ? args.offset + args.limit : null });
}

async function lookup(db: D1Database, collection: ParliamentCollection, key: string, args: z.output<typeof LookupQuery>) {
  const editions = db.prepare(`SELECT ${projections} FROM parliament_editions
    WHERE collection=? AND session=? AND language=? AND key=?`).bind(collection, args.session, args.language, key);
  const [meta, rows] = await db.batch<Record<string, unknown>>([coverageStatement(db, collection, args.session), editions]);
  return ParliamentLookup.parse({ coverage: coverageFor(collection, meta.results), item: rows.results[0] ? edition(rows.results[0]) : null });
}

async function entries(db: D1Database, collection: ParliamentCollection, key: string | undefined,
  args: z.output<typeof MemberQuery>, resource: 'members' | 'passages') {
  const clauses = ['e.collection=?', 'e.session=?', 'e.language=?'];
  const bindings: (string | number)[] = [collection, args.session, args.language];
  for (const [column, value] of [['e.key', key], ['e.member_id', args.memberId]]) {
    if (value !== undefined) { clauses.push(column + '=?'); bindings.push(value); }
  }
  if (args.position === 'paired') clauses.push("json_extract(e.payload,'$.paired')=1");
  else if (args.position) { clauses.push('e.position=?'); bindings.push(args.position); }
  if (args.query) { clauses.push('instr(e.search_text, ?) > 0'); bindings.push(normalizeForSearch(args.query)); }
  const statement = db.prepare(`SELECT e.ordinal, e.payload, p.key, p.language, p.title, p.url, p.date
    FROM parliament_entries e JOIN parliament_editions p USING(collection,session,language,key)
    WHERE ${clauses.join(' AND ')} ORDER BY p.date DESC, p.key, e.ordinal LIMIT ? OFFSET ?`)
    .bind(...bindings, args.limit + 1, args.offset);
  const [meta, rows] = await db.batch<Record<string, unknown>>([coverageStatement(db, collection, args.session), statement]);
  const coverage = coverageFor(collection, meta.results);
  if (args.revision && args.revision !== coverage.revision) throw new RequestInputError('The catalogue revision changed. Restart pagination.');
  const items = rows.results.slice(0, args.limit).map(({ ordinal, payload, ...parent }) => ({
    ordinal, edition: parent, [resource === 'members' ? 'member' : 'passage']: JSON.parse(String(payload)),
  }));
  const schema = resource === 'members' ? MemberPage : PassagePage;
  return schema.parse({ coverage, items, nextOffset: rows.results.length > args.limit ? args.offset + args.limit : null });
}

export function prepareParliamentCatalogue(url: URL) {
  const match = /^\/api\/parliament\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) return undefined;
  const parsed = ParliamentCollection.safeParse(match[1]);
  if (!parsed.success) return undefined;
  const collection = parsed.data;
  const resource = childResource(collection);
  const indexed = resource !== undefined && (match[3] === resource || (!match[3] && match[2] === resource));
  if (match[3] && (!indexed || !keyPattern(collection).test(match[2]))) return undefined;
  const key = indexed && !match[3] ? undefined : match[2];
  return (env: Env) => {
    if (env.PARLIAMENT_CATALOGUE_PREVIEW !== 'on') throw new AccessError('UNSUPPORTED_COVERAGE', 'Parliamentary catalogues are disabled.', 501);
    const db = env.CIVIC_DB;
    if (!db) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Parliamentary catalogue storage is unavailable.', 503);
    if (indexed && resource) {
      const args = queryArgs(url.searchParams, resource === 'members' ? MemberQuery : ListQuery);
      return () => readPublished(() => entries(db, collection, key, args, resource));
    }
    if (key === 'coverage') {
      const { session } = queryArgs(url.searchParams, CoverageQuery);
      return () => readPublished(async () => coverageFor(collection, (await coverageStatement(db, collection, session).all()).results));
    }
    if (key === undefined) {
      const args = queryArgs(url.searchParams, ListQuery);
      return () => readPublished(() => list(db, collection, args));
    }
    if (!keyPattern(collection).test(key)) throw new RequestInputError('Invalid parliamentary record identifier.');
    const args = queryArgs(url.searchParams, LookupQuery);
    return () => readPublished(() => lookup(db, collection, key, args));
  };
}

async function readPublished<T>(read: () => Promise<T>) {
  try { return await read(); }
  catch (error) {
    if (error instanceof AccessError || error instanceof RequestInputError) throw error;
    throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Unable to read the parliamentary catalogue.', 503);
  }
}
