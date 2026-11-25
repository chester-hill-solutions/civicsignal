import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from './lib/file-integrity';
import { localD1 } from './lib/local-d1';
import { runWrittenQuestionRequest } from '../src/routes/written-questions';

export const WRITTEN_QUESTION_CHUNK_CHARS = 8192;
const SEARCH_OVERLAP_CHARS = 64;
const HOUSE_BINDING = /\{\s*"binding"\s*:\s*"CIVIC_DB"\s*,\s*"database_name"\s*:\s*"[^"]+"\s*,\s*"database_id"\s*:\s*"([0-9a-f-]{36})"/u;
const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

type SqliteConstructor = new (path: string, options?: Record<string, boolean>) => DatabaseSync;
const sqliteModule = createRequire(import.meta.url)(process.versions['bun'] ? 'bun:sqlite' : 'node:sqlite') as {
  Database?: SqliteConstructor;
  DatabaseSync?: SqliteConstructor;
};
const Sqlite: SqliteConstructor = (() => {
  const constructor = process.versions['bun'] ? sqliteModule.Database : sqliteModule.DatabaseSync;
  if (!constructor) throw new Error('The active JavaScript runtime does not provide its synchronous SQLite module.');
  return constructor;
})();

export function openSqlite(path: string, readOnly = false): DatabaseSync {
  const options: Record<string, boolean> = process.versions['bun']
    ? { readonly: readOnly, create: !readOnly, strict: true }
    : { readOnly };
  return new Sqlite(path, options);
}

interface MaterializationStats {
  questions: number;
  questionChars: number;
  documents: number;
  documentChars: number;
  chunks: number;
  indexedPassages: number;
}

export function* splitWrittenQuestionText(text: string): Generator<{ index: number; text: string; searchText: string }> {
  let start = 0;
  let index = 0;
  while (start < text.length) {
    let end = offsetByCodePoints(text, start, WRITTEN_QUESTION_CHUNK_CHARS);
    if (end < text.length) {
      const boundary = text.lastIndexOf(' ', end - 1);
      if (boundary > offsetByCodePoints(text, start, Math.floor(WRITTEN_QUESTION_CHUNK_CHARS / 2))) end = boundary + 1;
    }
    const part = text.slice(start, end);
    if (!part) throw new Error('Text chunking did not advance.');
    const overlap = index === 0 ? '' : text.slice(offsetBeforeCodePoints(text, start, SEARCH_OVERLAP_CHARS), start);
    yield { index, text: part, searchText: overlap + part };
    start = end;
    index += 1;
  }
}

function offsetByCodePoints(text: string, start: number, count: number) {
  let offset = start;
  for (let index = 0; offset < text.length && index < count; index += 1) {
    const point = text.codePointAt(offset);
    offset += point !== undefined && point > 0xffff ? 2 : 1;
  }
  return offset;
}

function offsetBeforeCodePoints(text: string, end: number, count: number) {
  let offset = end;
  for (let index = 0; offset > 0 && index < count; index += 1) {
    const last = text.charCodeAt(offset - 1);
    offset -= last >= 0xdc00 && last <= 0xdfff && offset > 1
      && text.charCodeAt(offset - 2) >= 0xd800 && text.charCodeAt(offset - 2) <= 0xdbff ? 2 : 1;
  }
  return offset;
}

function codePointLength(text: string) {
  let count = 0;
  for (let offset = 0; offset < text.length; count += 1) {
    const point = text.codePointAt(offset);
    offset += point !== undefined && point > 0xffff ? 2 : 1;
  }
  return count;
}

function firstCodePointSlice(text: string, count: number) {
  return text.slice(0, offsetByCodePoints(text, 0, count));
}

function wranglerDatabaseId() {
  const config = readFileSync(resolve(PROJECT_ROOT, 'wrangler.jsonc'), 'utf8');
  const id = HOUSE_BINDING.exec(config)?.[1];
  if (!id) throw new Error('Could not read the CIVIC_DB identifier from wrangler.jsonc.');
  return id;
}

function recordedMigrations(state: string, table: string, expected: string[]) {
  if (!existsSync(join(state, 'v3/d1/miniflare-D1DatabaseObject'))) return false;
  const sqlite = new Sqlite(databaseFile(state));
  try {
    const installed = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!installed) return false;
    const rows = sqlite.prepare(`SELECT name FROM ${table}`).all();
    const applied = new Set(rows.map(row => row['name']));
    return expected.every(name => applied.has(name));
  } finally { sqlite.close(); }
}

function applyLocalMigrations(databaseId: string, state: string) {
  const directories = [['migrations', 'd1_migrations'], ['preview/written-questions/migrations', 'wq_preview_migrations']] as const;
  for (const [relative, table] of directories) {
    const dir = resolve(PROJECT_ROOT, relative);
    const expected = readdirSync(dir).filter(name => name.endsWith('.sql'));
    if (recordedMigrations(state, table, expected)) continue;
    const result = spawnSync('cf', ['d1', 'migrations', 'apply', databaseId, '--local', '--persist-to', state,
      '--dir', dir, '--table', table], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    // Some cf local versions keep the Miniflare listener open after committing the migration ledger.
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    if (!timedOut && result.status !== 0) throw result.error ?? new Error(result.stderr.trim() || 'cf migration failed.');
    if (!recordedMigrations(state, table, expected)) throw new Error(`Incomplete local D1 migration ledger: ${table}.`);
  }
}

function string(value: unknown) {
  if (typeof value !== 'string') throw new Error('Source database has an invalid text value.');
  return value;
}
function integer(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('Source database has an invalid integer.');
  return parsed;
}
function nullableString(value: unknown) { return value === null ? null : string(value); }
function rowIterator(sqlite: DatabaseSync, query: string) {
  return sqlite.prepare(query).iterate() as Iterable<Record<string, unknown>>;
}
function scalar(sqlite: DatabaseSync, sql: string) { return sqlite.prepare(sql).get() as Record<string, unknown>; }

function sourceStats(sqlite: DatabaseSync): MaterializationStats {
  for (const [table, columns] of Object.entries({
    sessions: ['session', 'metadata_json'],
    questions: ['session', 'number', 'language', 'url', 'text', 'status', 'member_id', 'member_name', 'asked_on',
      'metadata_json', 'source_hash', 'content_hash', 'acquisition', 'error', 'last_checked'],
    documents: ['session', 'number', 'language', 'doc_key', 'kind', 'respondent', 'title', 'url', 'text',
      'object_sha256', 'availability', 'metadata_json'],
  })) {
    const actual = new Set([...rowIterator(sqlite, `PRAGMA table_info(${table})`)].map((row) => string(row['name'])));
    if (columns.some((column) => !actual.has(column))) throw new Error(`Source database is missing required ${table} columns.`);
  }
  const counts = scalar(sqlite, `SELECT (SELECT COUNT(*) FROM questions) AS questions,
      (SELECT COUNT(*) FROM documents) AS documents,
      (SELECT COALESCE(SUM(length(text)),0) FROM questions) AS questionChars,
      (SELECT COALESCE(SUM(length(text)),0) FROM documents) AS documentChars`);
  const result = { questions: integer(counts['questions']), questionChars: integer(counts['questionChars']),
    documents: integer(counts['documents']), documentChars: integer(counts['documentChars']), chunks: 0, indexedPassages: 0 };
  if (!result.questions) throw new Error('Source database contains no written-question records.');
  return result;
}

function createStage(target: DatabaseSync) {
  target.exec(`CREATE TABLE IF NOT EXISTS wq_stage_questions AS SELECT * FROM questions WHERE 0;
    CREATE TABLE IF NOT EXISTS wq_stage_documents AS SELECT * FROM documents WHERE 0;
    CREATE TABLE IF NOT EXISTS wq_stage_document_chunks (
      session TEXT NOT NULL, number INTEGER NOT NULL, language TEXT NOT NULL, doc_key TEXT NOT NULL,
      chunk_index INTEGER NOT NULL, text TEXT NOT NULL, search_text TEXT NOT NULL,
      PRIMARY KEY(session,number,language,doc_key,chunk_index));
    CREATE TABLE IF NOT EXISTS wq_stage_sessions AS SELECT * FROM wq_sessions WHERE 0;
    CREATE VIRTUAL TABLE IF NOT EXISTS wq_stage_fts USING fts5(session UNINDEXED,number UNINDEXED,language UNINDEXED,doc_key UNINDEXED,chunk_index UNINDEXED,text);
    CREATE TABLE IF NOT EXISTS wq_stage_materialization_state AS SELECT * FROM wq_materialization_state WHERE 0;`);
}

function resetStage(target: DatabaseSync) {
  target.exec('DELETE FROM wq_stage_fts; DELETE FROM wq_stage_document_chunks; DELETE FROM wq_stage_documents; DELETE FROM wq_stage_questions; DELETE FROM wq_stage_sessions; DELETE FROM wq_stage_materialization_state;');
}

function importCandidate(source: DatabaseSync, target: DatabaseSync, stats: MaterializationStats, sourceSha256: string) {
  const sessionInsert = target.prepare('INSERT INTO wq_stage_sessions (session,metadata_json) VALUES (?,?)');
  const questionInsert = target.prepare(`INSERT INTO wq_stage_questions (session,number,language,url,text,status,member_id,member_name,asked_on,
    metadata_json,source_hash,content_hash,acquisition,error,last_checked) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const documentInsert = target.prepare(`INSERT INTO wq_stage_documents (session,number,language,doc_key,kind,respondent,title,url,text,
    text_chars,chunk_count,object_sha256,availability,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const chunkInsert = target.prepare('INSERT INTO wq_stage_document_chunks (session,number,language,doc_key,chunk_index,text,search_text) VALUES (?,?,?,?,?,?,?)');
  const ftsInsert = target.prepare('INSERT INTO wq_stage_fts VALUES (?,?,?,?,?,?)');
  for (const row of rowIterator(source, 'SELECT session,metadata_json FROM sessions ORDER BY session')) {
    sessionInsert.run(string(row['session']), string(row['metadata_json']));
  }
  for (const row of rowIterator(source, `SELECT session,number,language,url,text,status,member_id,member_name,asked_on,metadata_json,
      source_hash,content_hash,acquisition,error,last_checked FROM questions ORDER BY session,number,language`)) {
    const key = [string(row['session']), integer(row['number']), string(row['language'])] as const;
    const text = string(row['text']);
    questionInsert.run(...key, string(row['url']), text, string(row['status']), nullableString(row['member_id']),
      nullableString(row['member_name']), nullableString(row['asked_on']), string(row['metadata_json']), string(row['source_hash']),
      nullableString(row['content_hash']), string(row['acquisition']), nullableString(row['error']), nullableString(row['last_checked']));
    ftsInsert.run(key[0], String(key[1]), key[2], '', 0, text);
    stats.indexedPassages += 1;
  }
  for (const row of rowIterator(source, `SELECT session,number,language,doc_key,kind,respondent,title,url,text,object_sha256,availability,metadata_json
      FROM documents ORDER BY session,number,language,doc_key`)) {
    const key = [string(row['session']), integer(row['number']), string(row['language']), string(row['doc_key'])] as const;
    const text = string(row['text']);
    const textChars = codePointLength(text);
    let chunkCount = 0;
    for (const _chunk of splitWrittenQuestionText(text)) chunkCount += 1;
    documentInsert.run(...key, string(row['kind']), nullableString(row['respondent']), nullableString(row['title']), string(row['url']),
      firstCodePointSlice(text, WRITTEN_QUESTION_CHUNK_CHARS), textChars, chunkCount, nullableString(row['object_sha256']),
      string(row['availability']), string(row['metadata_json']));
    for (const chunk of splitWrittenQuestionText(text)) {
      chunkInsert.run(...key, chunk.index, chunk.text, chunk.searchText);
      ftsInsert.run(key[0], String(key[1]), key[2], key[3], chunk.index, chunk.searchText);
    }
    stats.chunks += chunkCount;
    stats.indexedPassages += chunkCount;
  }
  target.prepare(`INSERT INTO wq_stage_materialization_state
    (singleton,source_sha256,question_count,document_count,chunk_count,indexed_passage_count,completed_at) VALUES (1,?,?,?,?,?,?)`)
    .run(sourceSha256, stats.questions, stats.documents, stats.chunks, stats.indexedPassages, new Date().toISOString());
}

function verifyStats(target: DatabaseSync, tablePrefix: 'wq_stage_' | '') {
  const qTable = `${tablePrefix}questions`;
  const dTable = `${tablePrefix}documents`;
  const cTable = `${tablePrefix}document_chunks`;
  const fTable = tablePrefix ? 'wq_stage_fts' : 'wq_fts';
  const questions = scalar(target, `SELECT COUNT(*) AS count, COALESCE(SUM(length(text)),0) AS chars FROM ${qTable}`);
  const documents = scalar(target, `SELECT COUNT(*) AS count, COALESCE(SUM(text_chars),0) AS chars,
      COALESCE(SUM(chunk_count),0) AS chunks FROM ${dTable}`);
  const chunks = scalar(target, `SELECT COUNT(*) AS count, COALESCE(SUM(length(text)),0) AS chars FROM ${cTable}`);
  const passages = scalar(target, `SELECT COUNT(*) AS count FROM ${fTable}`);
  return { questions: integer(questions['count']), questionChars: integer(questions['chars']),
    documents: integer(documents['count']), documentChars: integer(documents['chars']),
    chunks: integer(documents['chunks']), storedChunks: integer(chunks['count']), chunkChars: integer(chunks['chars']),
    indexedPassages: integer(passages['count']) };
}

function sourceEquivalent(target: DatabaseSync, expected: MaterializationStats, prefix: 'wq_stage_' | '' = 'wq_stage_') {
  const actual = verifyStats(target, prefix);
  if (actual.questions !== expected.questions || actual.questionChars !== expected.questionChars
    || actual.documents !== expected.documents || actual.documentChars !== expected.documentChars
    || actual.chunks !== expected.chunks || actual.storedChunks !== expected.chunks
    || actual.chunkChars !== expected.documentChars || actual.indexedPassages !== expected.indexedPassages) {
    throw new Error(`Source equivalence failed for ${prefix || 'serving'} tables; the active generation was not changed.`);
  }
}

function swapCandidate(target: DatabaseSync) {
  target.exec('BEGIN IMMEDIATE');
  try {
    target.exec(`DELETE FROM wq_fts; DELETE FROM document_chunks; DELETE FROM documents; DELETE FROM questions; DELETE FROM wq_sessions;
      INSERT INTO wq_sessions SELECT * FROM wq_stage_sessions;
      INSERT INTO questions SELECT * FROM wq_stage_questions;
      INSERT INTO documents SELECT * FROM wq_stage_documents;
      INSERT INTO document_chunks SELECT * FROM wq_stage_document_chunks;
      INSERT INTO wq_fts SELECT * FROM wq_stage_fts;
      DELETE FROM wq_materialization_state;
      INSERT INTO wq_materialization_state SELECT * FROM wq_stage_materialization_state;
      `);
  } catch (error) { target.exec('ROLLBACK'); throw error; }
}

async function verifyActualHandlers(target: DatabaseSync) {
  const db = localD1(target);
  const q1 = await runWrittenQuestionRequest(db, { operation: 'lookup', session: '45-1', number: 1, language: 'en' });
  const q1010 = await runWrittenQuestionRequest(db, { operation: 'lookup', session: '45-1', number: 1010, language: 'en' });
  if (!('state' in q1) || q1.state !== 'found' || !('state' in q1010) || q1010.state !== 'found' || q1010.documents.length === 0) {
    throw new Error('Actual-record retrieval checks failed for Q-1 or Q-1010.');
  }
  const results = await runWrittenQuestionRequest(db, {
    operation: 'search', query: { query: 'drinking water advisories', language: 'en', session: '45-1', limit: 100 },
  });
  if (!('items' in results) || !results.items.some((item) => item.number === 1010 && item.kind === 'question')) {
    throw new Error('Actual-record FTS search failed to surface Q-1010.');
  }
  return { q1Documents: q1.documents.length, q1010Documents: q1010.documents.length,
    q1010AnswerState: q1010.answerState, q1010SearchHits: results.items.filter((item) => item.number === 1010).length };
}

function databaseFile(stateDirectory: string) {
  const fs = createRequire(import.meta.url)('node:fs') as { readdirSync(path: string): string[]; statSync(path: string): { isFile(): boolean } };
  const dir = resolve(stateDirectory, 'v3/d1/miniflare-D1DatabaseObject');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite');
  if (files.length !== 1) throw new Error('Expected one isolated local CIVIC_DB SQLite file.');
  const sqliteName = files[0];
  if (!sqliteName) throw new Error('Local D1 database file is unavailable.');
  const path = join(dir, sqliteName);
  if (!fs.statSync(path).isFile()) throw new Error('Local D1 database file is not a regular file.');
  return path;
}

async function main(args: string[]) {
  const [sourcePath, statePath = '.wrangler/written-questions-final'] = args;
  if (!sourcePath || args.length > 2) throw new Error('Usage: bun scripts/materialize-written-questions.ts <closed-local-source.sqlite> [local-state-directory]');
  const source = openSqlite(resolve(sourcePath), true);
  const expected = sourceStats(source);
  const digest = await sha256File(resolve(sourcePath));
  const stateDirectory = resolve(PROJECT_ROOT, statePath);
  mkdirSync(stateDirectory, { recursive: true });
  const databaseId = wranglerDatabaseId();
  applyLocalMigrations(databaseId, stateDirectory);
  const target = openSqlite(databaseFile(stateDirectory));
  try {
    createStage(target);
    target.exec('BEGIN IMMEDIATE');
    try { resetStage(target); importCandidate(source, target, expected, digest); target.exec('COMMIT'); }
    catch (error) { target.exec('ROLLBACK'); throw error; }
    swapCandidate(target);
    let handlerChecks: Awaited<ReturnType<typeof verifyActualHandlers>>;
    try {
      sourceEquivalent(target, expected, '');
      handlerChecks = await verifyActualHandlers(target);
      target.exec('COMMIT');
    } catch (error) {
      target.exec('ROLLBACK');
      throw error;
    }
    console.log(JSON.stringify({ materialized: true, target: 'isolated-local-d1', sourceSha256: digest,
      questions: expected.questions, documents: expected.documents, chunks: expected.chunks,
      indexedPassages: expected.indexedPassages, sourceTextCharacters: expected.questionChars + expected.documentChars,
      objectBytesCopied: 0, sourceEquivalent: true, actualHandlerChecks: handlerChecks }, null, 2));
  } finally {
    source.close();
    target.close();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
