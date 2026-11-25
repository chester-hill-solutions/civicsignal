import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { GAZETTE_PREVIEW_ISSUES, GazetteIssueSchema, gazetteIssueId, isGazetteIssueSupported, type GazetteEdition } from '../src/corpora/gazette';
import { recallGazette } from './lib/gazette-recall';
import { fetchGazetteIssue, parseGazetteIssue } from './lib/gazette-source';
import { discoverCurrentGazetteIssues } from './lib/gazette-current';
import { importGazetteEdition, importGazetteEditions, validateGazetteEdition } from './lib/gazette-store';

const USAGE = `Usage:
  bun scripts/gazette-local.ts replay <sqlite-file> <week.json>
  bun scripts/gazette-local.ts import <sqlite-file> <edition.json>
  bun scripts/gazette-local.ts sync <sqlite-file>
  bun scripts/gazette-local.ts sync-current <sqlite-file> [YYYY-MM-DD]
  bun scripts/gazette-local.ts search <sqlite-file> <en|fr> <I|II> "<topic>"
  bun scripts/gazette-local.ts show <sqlite-file> <record-id>
  bun scripts/gazette-local.ts verify-live`;

const manifest = z.strictObject({
  issues: GazetteIssueSchema.extend({ file: z.string().trim().min(1) }).array().length(GAZETTE_PREVIEW_ISSUES.length),
});

async function fetchVerifiedGazettePreview() {
  const editions: GazetteEdition[] = [];
  for (const expected of GAZETTE_PREVIEW_ISSUES) {
    editions.push(validateGazetteEdition(await fetchGazetteIssue(expected)));
  }
  return editions;
}

export async function syncCurrent(databaseFile: string, cutoff?: string, send: typeof fetch = fetch,
  receiptFile = process.env.CIVICSIGNAL_GAZETTE_RECEIPT ?? 'dist/gazette/receipt.json') {
  const keys = await discoverCurrentGazetteIssues(cutoff, send);
  const editions: GazetteEdition[] = [];
  for (const key of keys) editions.push(validateGazetteEdition(await fetchGazetteIssue(key, send, true)));
  const absoluteDatabase = resolve(databaseFile);
  const directory = dirname(absoluteDatabase);
  mkdirSync(directory, { recursive: true });
  const sqlite = openStore(absoluteDatabase);
  let results: ReturnType<typeof importGazetteEditions>;
  let recordCounts = new Map<string, number>();
  try {
    results = importGazetteEditions(sqlite, editions);
    recordCounts = new Map((sqlite.prepare(`SELECT part, language, issue_date, volume, issue_number, record_count
      FROM gazette_editions`).all() as Array<{ part: string; language: string; issue_date: string; volume: number;
        issue_number: number; record_count: number }>).map((row) =>
      [`${row.part}:${row.language}:${row.issue_date}:v${row.volume}:n${row.issue_number}`, row.record_count]));
  } finally { sqlite.close(); }
  const completedAt = new Date().toISOString();
  const receipt = {
    schemaVersion: 1,
    source: 'https://gazette.gc.ca',
    completedAt,
    cutoff: cutoff ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
    databasePath: absoluteDatabase,
    editions: results.map((item) => ({ ...item,
      recordCount: recordCounts.get(`${item.part}:${item.language}:${item.issueDate}:v${item.volume}:n${item.issueNumber}`) ?? null,
    })),
  };
  const absoluteReceipt = resolve(receiptFile);
  mkdirSync(dirname(absoluteReceipt), { recursive: true });
  const temporary = `${absoluteReceipt}.tmp-${process.pid}-${randomUUID()}`;
  let published = false;
  try {
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    renameSync(temporary, absoluteReceipt);
    published = true;
  } finally {
    if (!published) try { unlinkSync(temporary); } catch { /* no temporary remains */ }
  }
  return { complete: true as const, persisted: true as const, atomic: true as const,
    receiptPath: absoluteReceipt, receipt, editions: receipt.editions };
}

export function parseGazetteReplayManifest(value: unknown) {
  const parsed = manifest.parse(value);
  const seen = new Set<string>();
  for (const issue of parsed.issues) {
    if (!isGazetteIssueSupported(issue)) throw new Error('Gazette replay manifest contains an issue outside the configured preview set.');
    const identity = gazetteIssueId(issue);
    if (seen.has(identity)) throw new Error('Gazette replay manifest contains a duplicate issue edition.');
    seen.add(identity);
  }
  return parsed;
}

function openStore(databaseFile: string) {
  const { Database: SQLite } = createRequire(import.meta.url)('bun:sqlite') as {
    Database: new (file: string, options: { readonly: boolean; create: boolean; strict: boolean }) => DatabaseSync;
  };
  const sqlite = new SQLite(databaseFile, { readonly: false, create: true, strict: true });
  sqlite.exec(readFileSync(new URL('../preview/gazette/migrations/0001_gazette.sql', import.meta.url), 'utf8'));
  return sqlite;
}

async function main(args: string[]) {
  const [command, databaseFile, inputFile] = args;
  if (command === 'search' || command === 'show') {
    console.log(JSON.stringify(await recallGazette(args), null, 2));
    return;
  }
  if (command === 'verify-live') {
    if (args.length !== 1) throw new Error(USAGE);
    const issues = await fetchVerifiedGazettePreview();
    const result = issues.map(({ part, language, issueDate, volume, issueNumber, records }) => ({
      part, language, issueDate, volume, issueNumber, recordCount: records.length,
      kinds: [...new Set(records.map(({ kind }) => kind))].sort(),
    }));
    console.log(JSON.stringify({ source: 'live-read-only', persisted: false, issues: result }, null, 2));
    return;
  }
  if (command === 'sync') {
    if (!databaseFile || args.length !== 2) throw new Error(USAGE);
    const issues = await fetchVerifiedGazettePreview();
    const sqlite = openStore(databaseFile);
    try {
      const editions = issues.map((edition) => importGazetteEdition(sqlite, edition));
      console.log(JSON.stringify({ complete: true, persisted: true, editions }, null, 2));
    } finally {
      sqlite.close();
    }
    return;
  }
  if (command === 'sync-current') {
    if (!databaseFile || args.length < 2 || args.length > 3) throw new Error(USAGE);
    console.log(JSON.stringify(await syncCurrent(databaseFile, args[2]), null, 2));
    return;
  }
  if (!databaseFile || !inputFile) throw new Error(USAGE);
  if (command !== 'replay' && command !== 'import') throw new Error(USAGE);
  if (args.length !== 3) throw new Error(USAGE);
  const sqlite = openStore(databaseFile);
  try {
    if (command === 'import') {
      const result = importGazetteEdition(sqlite, JSON.parse(readFileSync(inputFile, 'utf8')));
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const parsed = parseGazetteReplayManifest(JSON.parse(readFileSync(inputFile, 'utf8')));
    const base = dirname(resolve(inputFile));
    const result = [];
    for (const entry of parsed.issues) {
      const html = readFileSync(resolve(base, entry.file), 'utf8');
      const { file: _file, ...expected } = entry;
      const edition = await parseGazetteIssue(html, expected);
      result.push(importGazetteEdition(sqlite, edition));
    }
    console.log(JSON.stringify({ complete: true, editions: result }, null, 2));
  } finally {
    sqlite.close();
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
