import { AccessError } from '../access';
import { z } from 'zod';
import {
  WrittenQuestionDocumentSchema, WrittenQuestionPassageSchema, WrittenQuestionAttributionSchema,
  HOUSE_WRITTEN_QUESTION_ATTRIBUTION, writtenQuestionAttributionForUrl,
  WrittenQuestionRecordSchema, writtenQuestionAnswerState, writtenQuestionFtsQuery,
  type WrittenQuestionDocument, type WrittenQuestionRecord,
} from '../corpora/written-questions';
import { RequestInputError } from '../http';
import type { Env } from '../types';
import {
  WRITTEN_QUESTIONS_PATHS, WrittenQuestionCoverageResponseSchema, WrittenQuestionLookupResponseSchema,
  WrittenQuestionSearchResponseSchema, WrittenQuestionSearchSchema, WrittenQuestionChunksResponseSchema,
  type WrittenQuestionSearchRequest,
} from './written-questions-contract';

interface RouteMatch { operation: 'search' | 'coverage' | 'lookup' | 'chunks'; session?: string; number?: number; language?: 'en' | 'fr' }
type RequestSpec =
  | { operation: 'search'; query: WrittenQuestionSearchRequest }
  | { operation: 'coverage'; session?: string }
  | { operation: 'lookup'; session: string; number: number; language: 'en' | 'fr' }
  | { operation: 'chunks'; session: string; number: number; language: 'en' | 'fr'; documentKey: string; offset: number; limit: number };

const SESSION = /^\d{1,2}-\d{1,2}$/u;
const officialUrl = zodUrlForHouse();

function zodUrlForHouse() {
  return (value: string) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && ['ourcommons.ca', 'www.ourcommons.ca', 'noscommunes.ca', 'www.noscommunes.ca'].includes(url.hostname)
        && !url.username && !url.password;
    } catch { return false; }
  };
}

function documentAttribution(value: string) {
  const attribution = writtenQuestionAttributionForUrl(value);
  if (attribution) return attribution;
  throw new AccessError('RETRIEVAL_UNAVAILABLE', 'A written-question answer citation failed source validation.', 503);
}

export function matchWrittenQuestionRoute(pathname: string): RouteMatch | undefined {
  const base = WRITTEN_QUESTIONS_PATHS.search;
  if (pathname === base) return { operation: 'search' };
  if (pathname === `${base}/coverage`) return { operation: 'coverage' };
  const chunkPath = new RegExp(`^${base}/(\\d{1,2}-\\d{1,2})/(\\d+)/((?:en)|(?:fr))/chunks$`, 'u').exec(pathname);
  if (chunkPath) {
    const [, session, rawNumber, language] = chunkPath;
    if (session && rawNumber && language) {
      const number = Number(rawNumber);
      if (!Number.isSafeInteger(number) || number < 1) throw new RequestInputError('Question number must be a positive integer.');
      return { operation: 'chunks', session, number, language: language as 'en' | 'fr' };
    }
  }
  const match = new RegExp(`^${base}/(\\d{1,2}-\\d{1,2})/(\\d+)/((?:en)|(?:fr))$`, 'u').exec(pathname);
  if (!match) return undefined;
  const [, session, rawNumber, language] = match;
  if (!session || !rawNumber || !language) return undefined;
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number) || number < 1) throw new RequestInputError('Question number must be a positive integer.');
  return { operation: 'lookup', session, number, language: language as 'en' | 'fr' };
}

function parseQuery(url: URL, allowed: readonly string[]) {
  if (url.search.length > 8192) throw new RequestInputError('The written-question query is too long.');
  const input: Record<string, unknown> = {};
  for (const name of url.searchParams.keys()) {
    if (!allowed.includes(name)) throw new RequestInputError('Unsupported written-question query parameter.');
    const values = url.searchParams.getAll(name);
    if (values.length !== 1) throw new RequestInputError(`Supply ${name} once.`);
    const value = values[0] ?? '';
    input[name] = (name === 'limit' || name === 'offset') && /^[0-9]+$/u.test(value) ? Number(value) : value;
  }
  return input;
}

export function parseWrittenQuestionRequest(route: RouteMatch, url: URL): RequestSpec {
  if (route.operation === 'chunks') {
    const input = parseQuery(url, ['documentKey', 'offset', 'limit']);
    if (typeof input['documentKey'] !== 'string' || !input['documentKey'].trim()) {
      throw new RequestInputError('documentKey is required for text-chunk retrieval.');
    }
    const number = (name: 'offset' | 'limit', fallback: number) => {
      const value = input[name] === undefined ? fallback : typeof input[name] === 'number' ? input[name] : Number.NaN;
      if (!Number.isInteger(value) || value < (name === 'offset' ? 0 : 1) || value > (name === 'limit' ? 20 : Number.MAX_SAFE_INTEGER)) {
        throw new RequestInputError(`${name} is invalid.`);
      }
      return value;
    };
    return { operation: 'chunks', session: route.session as string, number: route.number as number,
      language: route.language as 'en' | 'fr', documentKey: input['documentKey'].trim(), offset: number('offset', 0), limit: number('limit', 10) };
  }
  if (route.operation === 'lookup') {
    if (url.search) throw new RequestInputError('A written-question exact lookup takes no query parameters.');
    return { operation: 'lookup', session: route.session as string, number: route.number as number, language: route.language as 'en' | 'fr' };
  }
  if (route.operation === 'coverage') {
    const input = parseQuery(url, ['session']);
    if (input['session'] !== undefined && (typeof input['session'] !== 'string' || !SESSION.test(input['session']))) {
      throw new RequestInputError('session must be a Parliament-session key such as 45-1.');
    }
    return { operation: 'coverage', ...(input['session'] === undefined ? {} : { session: input['session'] as string }) };
  }
  const input = parseQuery(url, ['query', 'language', 'session', 'kind', 'limit']);
  const result = WrittenQuestionSearchSchema.safeParse(input);
  if (!result.success) throw new RequestInputError(`${result.error.issues[0]?.path.join('.') || 'query'} is invalid.`);
  return { operation: 'search', query: result.data };
}

export function writtenQuestionDatabase(env: Env): D1Database {
  if (env.WRITTEN_QUESTIONS_PREVIEW !== 'on') {
    throw new AccessError('UNSUPPORTED_COVERAGE', 'Written-question preview is disabled on this deployment.', 501);
  }
  if (!env.CIVIC_DB) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'The written-question database is unavailable.', 503);
  return env.CIVIC_DB;
}

function metadataValue(value: unknown) {
  try { return JSON.parse(String(value)); }
  catch { throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Stored written-question metadata is invalid.', 503); }
}

function questionFromRow(row: Record<string, unknown>): WrittenQuestionRecord {
  const validUrl = officialUrl(String(row['url']));
  if (!validUrl) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'A written-question citation failed source validation.', 503);
  return WrittenQuestionRecordSchema.parse({
    session: row['session'], number: Number(row['number']), language: row['language'], url: row['url'], text: row['text'],
    status: row['status'], metadata: metadataValue(row['metadata_json']), acquisition: row['acquisition'], error: row['error'],
    memberId: row['member_id'], memberName: row['member_name'], askedOn: row['asked_on'],
    sourceHash: row['source_hash'], attribution: HOUSE_WRITTEN_QUESTION_ATTRIBUTION,
  });
}

function documentFromRow(row: Record<string, unknown>): WrittenQuestionDocument {
  const attribution = WrittenQuestionAttributionSchema.parse(documentAttribution(String(row['url'])));
  const metadata = metadataValue(row['metadata_json']) as Record<string, unknown>;
  const text = String(row['text']);
  const textChars = Number(row['text_chars']);
  const chunkCount = Number(row['chunk_count']);
  return WrittenQuestionDocumentSchema.parse({
    session: row['session'], number: Number(row['number']), language: row['language'], documentKey: row['doc_key'],
    kind: row['kind'], respondent: row['respondent'], title: row['title'], url: row['url'],
    text: [...text].slice(0, 8192).join(''), fileLanguage: metadata['file_language'] ?? null,
    objectSha256: row['object_sha256'], metadata, attribution, textChars, chunkCount, hasMore: chunkCount > 1,
    availability: row['availability'],
  });
}

function dbFailure(error: unknown): never {
  if (error instanceof AccessError) throw error;
  throw new AccessError('RETRIEVAL_UNAVAILABLE', 'The written-question store is unavailable.', 503);
}

async function lookup(db: D1Database, session: string, number: number, language: 'en' | 'fr') {
  try {
    const row = await db.prepare(`SELECT session, number, language, url, text, status, metadata_json, acquisition, error,
        member_id, member_name, asked_on, source_hash FROM questions WHERE session = ? AND number = ? AND language = ?`)
      .bind(session, number, language).first<Record<string, unknown>>();
    if (!row) return { state: 'not-found' as const, session, number, language };
    const question = questionFromRow(row);
    const documents = await db.prepare(`SELECT session, number, language, doc_key, kind, respondent, title, url, text,
        object_sha256, metadata_json, text_chars, chunk_count, availability FROM documents
      WHERE session = ? AND number = ? AND language = ? ORDER BY kind, doc_key`)
      .bind(session, number, language).all<Record<string, unknown>>();
    const docs = documents.results.map(documentFromRow);
    const result = writtenQuestionAnswerState(question, docs);
    return result;
  } catch (error) { return dbFailure(error); }
}

function querySql(query: string, language: 'en' | 'fr', session?: string, kind?: 'question' | 'reply' | 'cover_page' | 'attachment') {
  const kinds = kind ? [kind] : ['question', 'reply', 'cover_page', 'attachment'];
  const filters = [`f.language = ?`, `CASE WHEN f.doc_key = '' THEN 'question' ELSE d.kind END IN (${kinds.map(() => '?').join(',')})`];
  const values: (string | number)[] = [query, language, ...kinds];
  if (session) { filters.push('f.session = ?'); values.push(session); }
  if (kind === 'question') filters.push("f.doc_key = ''");
  else if (kind) filters.push("f.doc_key <> ''");
  return { filters: filters.join(' AND '), values };
}

async function search(db: D1Database, input: WrittenQuestionSearchRequest) {
  const query = writtenQuestionFtsQuery(input.query);
  const sql = querySql(query, input.language, input.session, input.kind);
  try {
    const result = await db.prepare(`SELECT CASE WHEN f.doc_key = '' THEN 'question' ELSE d.kind END AS kind,
        f.session AS session, CAST(f.number AS INTEGER) AS number, f.language AS language,
        CASE WHEN f.doc_key = '' THEN NULL ELSE f.chunk_index END AS chunkIndex,
        NULLIF(f.doc_key, '') AS documentKey, q.member_id AS memberId, q.member_name AS memberName,
        q.asked_on AS askedOn, d.respondent AS respondent, d.title AS title,
        CASE WHEN f.doc_key = '' THEN q.text ELSE c.text END AS text,
        d.metadata_json AS documentMetadata, q.source_hash AS sourceHash,
        CASE WHEN f.doc_key = '' THEN 1 ELSE d.chunk_count END AS chunkCount,
        CASE WHEN f.doc_key = '' THEN length(q.text) ELSE d.text_chars END AS textChars,
        CASE WHEN f.doc_key = '' THEN q.url ELSE d.url END AS citationUrl,
        CASE WHEN f.doc_key = '' THEN 'question' ELSE d.availability END AS availability,
        bm25(wq_fts) AS rank
      FROM wq_fts AS f
      JOIN questions AS q ON q.session = f.session AND q.number = CAST(f.number AS INTEGER) AND q.language = f.language
      LEFT JOIN documents AS d ON d.session = f.session AND d.number = CAST(f.number AS INTEGER)
        AND d.language = f.language AND d.doc_key = f.doc_key AND f.doc_key <> ''
      LEFT JOIN document_chunks AS c ON c.session = f.session AND c.number = CAST(f.number AS INTEGER)
        AND c.language = f.language AND c.doc_key = f.doc_key AND c.chunk_index = f.chunk_index
      WHERE wq_fts MATCH ? AND ${sql.filters}
      ORDER BY rank, f.session, CAST(f.number AS INTEGER), f.doc_key LIMIT ?`)
      .bind(...sql.values, input.limit).all<Record<string, unknown>>();
    const items = result.results.map((row) => {
      const citationUrl = String(row['citationUrl']);
      const attribution = row['documentKey'] === null
        ? HOUSE_WRITTEN_QUESTION_ATTRIBUTION : documentAttribution(citationUrl);
      if (row['documentKey'] === null && !officialUrl(citationUrl)) {
        throw new AccessError('RETRIEVAL_UNAVAILABLE', 'A written-question citation failed source validation.', 503);
      }
      const metadata = row['documentMetadata'] ? metadataValue(row['documentMetadata']) as Record<string, unknown> : {};
      const chunkCount = Number(row['chunkCount']);
      return WrittenQuestionPassageSchema.parse({ kind: row['kind'], session: row['session'], number: Number(row['number']),
        language: row['language'], documentKey: row['documentKey'], memberId: row['memberId'], memberName: row['memberName'],
        askedOn: row['askedOn'], sourceHash: row['sourceHash'], respondent: row['respondent'], title: row['title'],
        text: row['text'], chunkIndex: row['chunkIndex'], chunkCount, textChars: Number(row['textChars']),
        hasMore: row['chunkIndex'] !== null && Number(row['chunkIndex']) + 1 < chunkCount,
        citationUrl, availability: row['availability'], rank: Number(row['rank']), attribution,
        fileLanguage: metadata['file_language'] ?? null,
      });
    });
    return WrittenQuestionSearchResponseSchema.parse({ items, count: items.length, language: input.language, coverageBasis: 'materialized-records' });
  } catch (error) { return dbFailure(error); }
}

async function readChunks(db: D1Database, request: Extract<RequestSpec, { operation: 'chunks' }>) {
  try {
    const document = await db.prepare(`SELECT d.session,d.number,d.language,d.doc_key,d.url,d.chunk_count,d.metadata_json,q.source_hash
      FROM documents d JOIN questions q USING(session,number,language)
      WHERE d.session=? AND d.number=? AND d.language=? AND d.doc_key=?`)
      .bind(request.session, request.number, request.language, request.documentKey).first<Record<string, unknown>>();
    if (!document) throw new AccessError('NOT_FOUND', 'No written-question document has that key.', 404);
    const attribution = documentAttribution(String(document['url']));
    const total = Number(document['chunk_count']);
    const result = await db.prepare(`SELECT chunk_index AS chunkIndex,text FROM document_chunks
      WHERE session=? AND number=? AND language=? AND doc_key=? AND chunk_index >= ?
      ORDER BY chunk_index LIMIT ?`)
      .bind(request.session, request.number, request.language, request.documentKey, request.offset, request.limit)
      .all<Record<string, unknown>>();
    const chunks = result.results.map((row) => ({ index: Number(row['chunkIndex']), text: String(row['text']) }));
    return WrittenQuestionChunksResponseSchema.parse({ session: request.session, number: request.number,
      language: request.language, documentKey: request.documentKey, citationUrl: document['url'],
      sourceHash: document['source_hash'], attribution,
      fileLanguage: (metadataValue(document['metadata_json']) as Record<string, unknown>)['file_language'] ?? null,
      offset: request.offset, limit: request.limit, total, hasMore: request.offset + chunks.length < total, chunks });
  } catch (error) { return dbFailure(error); }
}

async function coverage(db: D1Database, session?: string) {
  const scoped = session === undefined ? '' : 'WHERE session = ?';
  const binding = session === undefined ? [] : [session];
  try {
    const rows = await db.prepare(`WITH question_counts AS (
        SELECT session, language, COUNT(*) AS questions,
          SUM(acquisition = 'complete') AS complete, SUM(acquisition = 'pending') AS pending,
          SUM(acquisition = 'gap') AS questionGaps FROM questions ${scoped} GROUP BY session, language
      ), document_counts AS (
        SELECT session, language,
          SUM(kind = 'reply' AND availability = 'searchable') AS searchableReplies,
          SUM(kind = 'reply' AND availability = 'stored') AS storedReplies,
          SUM(kind = 'reply' AND availability = 'gap') AS replyGaps,
          SUM(kind = 'attachment' AND availability = 'searchable') AS searchableAttachments,
          SUM(kind = 'attachment' AND availability = 'stored') AS storedAttachments,
          SUM(kind = 'attachment' AND availability = 'gap') AS attachmentGaps
        FROM documents ${scoped} GROUP BY session, language
      ) SELECT q.session, q.language, q.questions, q.complete, q.pending, q.questionGaps,
        COALESCE(d.searchableReplies, 0) AS searchableReplies, COALESCE(d.storedReplies, 0) AS storedReplies,
        COALESCE(d.replyGaps, 0) AS replyGaps, COALESCE(d.searchableAttachments, 0) AS searchableAttachments,
        COALESCE(d.storedAttachments, 0) AS storedAttachments, COALESCE(d.attachmentGaps, 0) AS attachmentGaps
        FROM question_counts q LEFT JOIN document_counts d USING (session, language) ORDER BY q.session, q.language`)
      .bind(...binding, ...binding).all<Record<string, unknown>>();
    return WrittenQuestionCoverageResponseSchema.parse({
      coverage: rows.results.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
        [key, ['questions', 'complete', 'pending', 'questionGaps', 'searchableReplies', 'storedReplies', 'replyGaps',
          'searchableAttachments', 'storedAttachments', 'attachmentGaps'].includes(key) ? Number(value) : value]))),
      basis: 'materialized-records',
    });
  } catch (error) { return dbFailure(error); }
}

export async function runWrittenQuestionRequest(db: D1Database, request: RequestSpec) {
  switch (request.operation) {
    case 'lookup': return WrittenQuestionLookupResponseSchema.parse(await lookup(db, request.session, request.number, request.language));
    case 'search': return search(db, request.query);
    case 'coverage': return coverage(db, request.session);
    case 'chunks': return readChunks(db, request);
  }
}
