import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import {
  lookupWrittenQuestion, readWrittenQuestionCoverage, searchWrittenQuestions,
  type WrittenQuestionSearchKind,
} from '../src/corpora/written-questions';

const USAGE = `Usage:
  bun scripts/written-questions-read.ts lookup <sqlite-file> <session> <number> <en|fr>
  bun scripts/written-questions-read.ts search <sqlite-file> <en|fr> "<query>" [--session <session>] [--kind question|reply|cover_page|attachment] [--limit <1-100>]
  bun scripts/written-questions-read.ts coverage <sqlite-file> [session]`;

function openStore(databaseFile: string) {
  const { Database } = createRequire(import.meta.url)('bun:sqlite') as {
    Database: new (file: string, options: { readonly: true; strict: true }) => DatabaseSync;
  };
  return new Database(databaseFile, { readonly: true, strict: true });
}

function parseSearchArgs(args: string[]) {
  const [databaseFile, language, query, ...flags] = args;
  if (!databaseFile || !language || !query) throw new Error(USAGE);
  const options: { session?: string; kind?: WrittenQuestionSearchKind; limit?: number } = {};
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (!value || value.startsWith('--')) throw new Error(USAGE);
    if (flag === '--session') options.session = value;
    else if (flag === '--kind') {
      if (value !== 'question' && value !== 'reply' && value !== 'cover_page' && value !== 'attachment') throw new Error(USAGE);
      options.kind = value;
    } else if (flag === '--limit') {
      if (!/^\d+$/u.test(value)) throw new Error(USAGE);
      options.limit = Number(value);
    } else throw new Error(USAGE);
    index += 1;
  }
  return { databaseFile, language, query, options };
}

async function main(args: string[]) {
  const [command, databaseFile, ...rest] = args;
  if (command === 'lookup') {
    const [session, rawNumber, language] = rest;
    if (!databaseFile || !session || !rawNumber || !language || rest.length !== 3 || !/^\d+$/u.test(rawNumber)) throw new Error(USAGE);
    const sqlite = openStore(databaseFile);
    try { console.log(JSON.stringify(lookupWrittenQuestion(sqlite, session, Number(rawNumber), language as 'en' | 'fr'), null, 2)); }
    finally { sqlite.close(); }
    return;
  }
  if (command === 'search') {
    const { databaseFile: file, language, query, options } = parseSearchArgs(rest.length ? [databaseFile ?? '', ...rest] : []);
    if (!databaseFile || file !== databaseFile) throw new Error(USAGE);
    const sqlite = openStore(databaseFile);
    try { console.log(JSON.stringify(searchWrittenQuestions(sqlite, { language: language as 'en' | 'fr', query, ...options }), null, 2)); }
    finally { sqlite.close(); }
    return;
  }
  if (command === 'coverage') {
    if (!databaseFile || rest.length > 1) throw new Error(USAGE);
    const sqlite = openStore(databaseFile);
    try { console.log(JSON.stringify(readWrittenQuestionCoverage(sqlite, rest[0]), null, 2)); }
    finally { sqlite.close(); }
    return;
  }
  throw new Error(USAGE);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
