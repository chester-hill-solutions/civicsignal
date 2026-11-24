import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export const WrittenQuestionLanguageSchema = z.enum(['en', 'fr']);
export type WrittenQuestionLanguage = z.infer<typeof WrittenQuestionLanguageSchema>;
export const WrittenQuestionSearchKindSchema = z.enum(['question', 'reply', 'cover_page', 'attachment']);
export type WrittenQuestionSearchKind = z.infer<typeof WrittenQuestionSearchKindSchema>;
export const WrittenQuestionAttributionSchema = z.strictObject({
  publisher: z.literal('House of Commons of Canada'),
  surrogate: z.literal('Library of Parliament').nullable(),
});
export const HOUSE_WRITTEN_QUESTION_ATTRIBUTION = { publisher: 'House of Commons of Canada', surrogate: null } as const;
const documentLanguage = z.enum(['b', 'e', 'f']).nullable();
const ALMA_SURROGATE_PATH = /^\/view\/delivery\/01CALP_INST\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/?$/u;

export function writtenQuestionAttributionForUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    if (['ourcommons.ca', 'www.ourcommons.ca', 'noscommunes.ca', 'www.noscommunes.ca'].includes(url.hostname)) {
      return HOUSE_WRITTEN_QUESTION_ATTRIBUTION;
    }
    if (url.hostname === 'canada.ca' || url.hostname.endsWith('.canada.ca') || url.hostname.endsWith('.gc.ca')) {
      return HOUSE_WRITTEN_QUESTION_ATTRIBUTION;
    }
    if (url.hostname === 'na01.alma.exlibrisgroup.com' && ALMA_SURROGATE_PATH.test(url.pathname)) {
      return { publisher: 'House of Commons of Canada', surrogate: 'Library of Parliament' as const };
    }
  } catch { return undefined; }
  return undefined;
}

const sessionSchema = z.string().trim().regex(/^\d{1,2}-\d{1,2}$/u);
const questionNumberSchema = z.number().int().positive();
const urlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, 'Expected a secure source URL.');

export const WrittenQuestionRecordSchema = z.strictObject({
  session: sessionSchema,
  number: questionNumberSchema,
  language: WrittenQuestionLanguageSchema,
  url: urlSchema,
  text: z.string(),
  status: z.string().trim().min(1),
  metadata: z.unknown(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  attribution: WrittenQuestionAttributionSchema,
  acquisition: z.enum(['pending', 'complete', 'gap']),
  error: z.string().nullable(),
  memberId: z.string().trim().min(1).nullable(),
  memberName: z.string().trim().min(1).nullable(),
  askedOn: z.iso.date().nullable(),
});
export type WrittenQuestionRecord = z.infer<typeof WrittenQuestionRecordSchema>;

export const WrittenQuestionDocumentSchema = z.strictObject({
  session: sessionSchema,
  number: questionNumberSchema,
  language: WrittenQuestionLanguageSchema,
  documentKey: z.string().trim().min(1),
  kind: z.enum(['reply', 'cover_page', 'attachment']),
  respondent: z.string().trim().min(1).nullable(),
  title: z.string().trim().min(1).nullable(),
  fileLanguage: documentLanguage,
  url: urlSchema,
  text: z.string(),
  objectSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  metadata: z.unknown(),
  attribution: WrittenQuestionAttributionSchema,
  textChars: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  availability: z.enum(['searchable', 'stored', 'gap']),
});
export type WrittenQuestionDocument = z.infer<typeof WrittenQuestionDocumentSchema>;

export const WrittenQuestionPassageSchema = z.strictObject({
  kind: WrittenQuestionSearchKindSchema,
  session: sessionSchema,
  number: questionNumberSchema,
  language: WrittenQuestionLanguageSchema,
  documentKey: z.string().nullable(),
  memberId: z.string().nullable(),
  memberName: z.string().nullable(),
  askedOn: z.iso.date().nullable(),
  fileLanguage: documentLanguage,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  attribution: WrittenQuestionAttributionSchema,
  respondent: z.string().nullable(),
  title: z.string().nullable(),
  text: z.string().min(1),
  chunkIndex: z.number().int().nonnegative().nullable(),
  chunkCount: z.number().int().nonnegative(),
  textChars: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  citationUrl: urlSchema,
  availability: z.enum(['question', 'searchable']),
  rank: z.number().finite(),
});
export type WrittenQuestionPassage = z.infer<typeof WrittenQuestionPassageSchema>;

export type WrittenQuestionLookup =
  | { state: 'not-found'; session: string; number: number; language: WrittenQuestionLanguage }
  | { state: 'found'; question: WrittenQuestionRecord; documents: WrittenQuestionDocument[];
    answerState: 'available' | 'partial' | 'pending' | 'gap' | 'no-reply' };

export interface WrittenQuestionSearchOptions {
  language: WrittenQuestionLanguage;
  query: string;
  session?: string;
  kind?: WrittenQuestionSearchKind;
  limit?: number;
}

const QUESTION_SELECT = `session, number, language, url, text, status, metadata_json AS metadataJson, source_hash AS sourceHash,
  acquisition, error, member_id AS memberId, member_name AS memberName, asked_on AS askedOn`;
const DOCUMENT_SELECT = `session, number, language, doc_key AS documentKey, kind,
  respondent, title, url, text, object_sha256 AS objectSha256, metadata_json AS metadataJson, availability`;

function parseQuestion(row: Record<string, unknown>): WrittenQuestionRecord {
  let metadata: unknown;
  try {
    metadata = JSON.parse(String(row['metadataJson']));
  } catch {
    throw new Error('Stored written-question metadata is not valid JSON.');
  }
  return WrittenQuestionRecordSchema.parse({
    session: row['session'], number: Number(row['number']), language: row['language'], url: row['url'],
    text: row['text'], status: row['status'], metadata, sourceHash: row['sourceHash'], attribution: HOUSE_WRITTEN_QUESTION_ATTRIBUTION,
    acquisition: row['acquisition'], error: row['error'],
    memberId: row['memberId'], memberName: row['memberName'], askedOn: row['askedOn'],
  });
}

function parseDocument(row: Record<string, unknown>): WrittenQuestionDocument {
  const metadata = JSON.parse(String(row['metadataJson'])) as Record<string, unknown>;
  const chars = [...String(row['text'])].length;
  return WrittenQuestionDocumentSchema.parse({
    session: row['session'], number: Number(row['number']), language: row['language'],
    documentKey: row['documentKey'], kind: row['kind'], respondent: row['respondent'], title: row['title'],
    url: row['url'], text: [...String(row['text'])].slice(0, 8192).join(''), fileLanguage: documentLanguage.parse(metadata['file_language'] ?? null),
    textChars: chars, chunkCount: Math.ceil(chars / 8192), hasMore: chars > 8192,
    objectSha256: row['objectSha256'], metadata,
    attribution: writtenQuestionAttributionForUrl(String(row['url'])) ?? HOUSE_WRITTEN_QUESTION_ATTRIBUTION,
    availability: row['availability'],
  });
}

export function writtenQuestionAnswerState(question: WrittenQuestionRecord, documents: WrittenQuestionDocument[]): WrittenQuestionLookup {
  const replies = documents.filter(({ kind }) => kind === 'reply');
  if (question.acquisition === 'pending' && replies.length === 0) return { state: 'found', question, documents, answerState: 'pending' };
  if (question.acquisition === 'gap' && replies.length === 0) return { state: 'found', question, documents, answerState: 'gap' };
  if (replies.length === 0) return { state: 'found', question, documents, answerState: 'no-reply' };
  const searchable = replies.some(({ availability, text }) => availability === 'searchable' && text.trim().length > 0);
  const gaps = replies.some(({ availability }) => availability === 'gap') || question.acquisition === 'gap';
  if (searchable && !gaps) return { state: 'found', question, documents, answerState: 'available' };
  if (searchable || replies.some(({ availability }) => availability === 'stored')) return { state: 'found', question, documents, answerState: 'partial' };
  return { state: 'found', question, documents, answerState: 'gap' };
}

export function lookupWrittenQuestion(sqlite: DatabaseSync, session: string, number: number,
  language: WrittenQuestionLanguage): WrittenQuestionLookup {
  const checkedSession = sessionSchema.parse(session);
  const checkedNumber = questionNumberSchema.parse(number);
  const checkedLanguage = WrittenQuestionLanguageSchema.parse(language);
  const row = sqlite.prepare(`SELECT ${QUESTION_SELECT} FROM questions WHERE session = ? AND number = ? AND language = ?`)
    .get(checkedSession, checkedNumber, checkedLanguage) as Record<string, unknown> | undefined;
  if (!row) return { state: 'not-found', session: checkedSession, number: checkedNumber, language: checkedLanguage };
  const question = parseQuestion(row);
  const rows = sqlite.prepare(`SELECT ${DOCUMENT_SELECT} FROM documents
    WHERE session = ? AND number = ? AND language = ? ORDER BY kind, doc_key`)
    .all(checkedSession, checkedNumber, checkedLanguage) as Record<string, unknown>[];
  return writtenQuestionAnswerState(question, rows.map(parseDocument));
}

export function writtenQuestionFtsQuery(query: string) {
  const checked = z.string().trim().min(1).max(256).parse(query);
  const terms = checked.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!terms.length) throw new Error('Search query must contain at least one letter or number.');
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
}

export function searchWrittenQuestions(sqlite: DatabaseSync, options: WrittenQuestionSearchOptions): WrittenQuestionPassage[] {
  const language = WrittenQuestionLanguageSchema.parse(options.language);
  const query = writtenQuestionFtsQuery(options.query);
  const session = options.session === undefined ? undefined : sessionSchema.parse(options.session);
  const kind = options.kind === undefined ? undefined : WrittenQuestionSearchKindSchema.parse(options.kind);
  const limit = z.number().int().min(1).max(100).default(20).parse(options.limit);
  const kinds = kind ? [kind] : ['question', 'reply', 'cover_page', 'attachment'];
  const values: (string | number)[] = [query, language, ...kinds];
  const filters = ['f.language = ?', 'CASE WHEN f.doc_key = \'\' THEN \'question\' ELSE d.kind END IN (' + kinds.map(() => '?').join(',') + ')'];
  if (session) { filters.push('f.session = ?'); values.push(session); }
  if (kind === 'question') filters.push("f.doc_key = ''");
  else if (kind) filters.push("f.doc_key <> ''");
  if (session) { /* bound above */ }
  values.push(limit);
  const rows = sqlite.prepare(`SELECT
      CASE WHEN f.doc_key = '' THEN 'question' ELSE d.kind END AS kind,
      f.session AS session, CAST(f.number AS INTEGER) AS number, f.language AS language,
      NULLIF(f.doc_key, '') AS documentKey, q.member_id AS memberId, q.member_name AS memberName,
      q.asked_on AS askedOn, d.respondent AS respondent, d.title AS title, f.text AS text,
      q.source_hash AS sourceHash, d.metadata_json AS documentMetadata,
      NULL AS docChunkCount, length(d.text) AS docTextChars,
      CASE WHEN f.doc_key = '' THEN q.url ELSE d.url END AS citationUrl,
      CASE WHEN f.doc_key = '' THEN 'question' ELSE d.availability END AS availability,
      bm25(wq_fts) AS rank
    FROM wq_fts AS f
    JOIN questions AS q ON q.session = f.session AND q.number = CAST(f.number AS INTEGER) AND q.language = f.language
    LEFT JOIN documents AS d ON d.session = f.session AND d.number = CAST(f.number AS INTEGER)
      AND d.language = f.language AND d.doc_key = f.doc_key AND f.doc_key <> ''
    WHERE wq_fts MATCH ? AND ${filters.join(' AND ')}
    ORDER BY rank, f.session, CAST(f.number AS INTEGER), f.doc_key LIMIT ?`).all(...values) as Record<string, unknown>[];
  return rows.map((row) => {
    const metadata = row['documentMetadata'] ? JSON.parse(String(row['documentMetadata'])) as Record<string, unknown> : {};
    const sourceText = String(row['text']);
    const text = sourceText.slice(0, 8192);
    const textChars = Number(row['docTextChars'] ?? [...sourceText].length);
    const chunkCount = Number(row['docChunkCount'] ?? Math.ceil(textChars / 8192));
    return WrittenQuestionPassageSchema.parse({
      kind: row['kind'], session: row['session'], number: Number(row['number']), language: row['language'],
      documentKey: row['documentKey'], memberId: row['memberId'], memberName: row['memberName'], askedOn: row['askedOn'],
      sourceHash: row['sourceHash'], respondent: row['respondent'], title: row['title'],
      attribution: writtenQuestionAttributionForUrl(String(row['citationUrl'])) ?? HOUSE_WRITTEN_QUESTION_ATTRIBUTION,
      fileLanguage: row['documentKey'] === null ? null : documentLanguage.parse(metadata['file_language'] ?? null),
      text, chunkIndex: row['documentKey'] === null ? null : 0, chunkCount, textChars, hasMore: chunkCount > 1,
      citationUrl: row['citationUrl'], availability: row['availability'], rank: Number(row['rank']),
    });
  });
}

export interface WrittenQuestionCoverage {
  session: string; language: WrittenQuestionLanguage; questions: number; complete: number; pending: number;
  questionGaps: number; searchableReplies: number; storedReplies: number; replyGaps: number;
  searchableAttachments: number; storedAttachments: number; attachmentGaps: number;
}

export function readWrittenQuestionCoverage(sqlite: DatabaseSync, session?: string): WrittenQuestionCoverage[] {
  const checkedSession = session === undefined ? undefined : sessionSchema.parse(session);
  const rows = sqlite.prepare(`SELECT q.session, q.language, COUNT(DISTINCT q.number) AS questions,
      COUNT(DISTINCT CASE WHEN q.acquisition = 'complete' THEN q.number END) AS complete,
      COUNT(DISTINCT CASE WHEN q.acquisition = 'pending' THEN q.number END) AS pending,
      COUNT(DISTINCT CASE WHEN q.acquisition = 'gap' THEN q.number END) AS questionGaps,
      COUNT(DISTINCT CASE WHEN d.kind = 'reply' AND d.availability = 'searchable' THEN d.doc_key END) AS searchableReplies,
      COUNT(DISTINCT CASE WHEN d.kind = 'reply' AND d.availability = 'stored' THEN d.doc_key END) AS storedReplies,
      COUNT(DISTINCT CASE WHEN d.kind = 'reply' AND d.availability = 'gap' THEN d.doc_key END) AS replyGaps,
      COUNT(DISTINCT CASE WHEN d.kind = 'attachment' AND d.availability = 'searchable' THEN d.doc_key END) AS searchableAttachments,
      COUNT(DISTINCT CASE WHEN d.kind = 'attachment' AND d.availability = 'stored' THEN d.doc_key END) AS storedAttachments,
      COUNT(DISTINCT CASE WHEN d.kind = 'attachment' AND d.availability = 'gap' THEN d.doc_key END) AS attachmentGaps
    FROM questions AS q LEFT JOIN documents AS d
      ON d.session = q.session AND d.number = q.number AND d.language = q.language
    ${checkedSession ? 'WHERE q.session = ?' : ''}
    GROUP BY q.session, q.language ORDER BY q.session, q.language`)
    .all(...(checkedSession ? [checkedSession] : [])) as Record<string, unknown>[];
  return rows.map((row) => ({
    session: sessionSchema.parse(row['session']), language: WrittenQuestionLanguageSchema.parse(row['language']),
    questions: Number(row['questions']), complete: Number(row['complete'] ?? 0), pending: Number(row['pending'] ?? 0),
    questionGaps: Number(row['questionGaps'] ?? 0), searchableReplies: Number(row['searchableReplies'] ?? 0),
    storedReplies: Number(row['storedReplies'] ?? 0), replyGaps: Number(row['replyGaps'] ?? 0),
    searchableAttachments: Number(row['searchableAttachments'] ?? 0), storedAttachments: Number(row['storedAttachments'] ?? 0),
    attachmentGaps: Number(row['attachmentGaps'] ?? 0),
  }));
}
