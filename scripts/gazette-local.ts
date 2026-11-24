import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { GAZETTE_PREVIEW_ISSUES, GazetteIssueSchema, gazetteIssueId, isGazetteIssueSupported, type GazetteEdition } from '../src/corpora/gazette';
import { recallGazette } from './lib/gazette-recall';
import { fetchGazetteIssue, parseGazetteIssue } from './lib/gazette-source';
import { importGazetteEdition, validateGazetteEdition } from './lib/gazette-store';

const USAGE = `Usage:
  bun scripts/gazette-local.ts replay <sqlite-file> <week.json>
  bun scripts/gazette-local.ts import <sqlite-file> <edition.json>
  bun scripts/gazette-local.ts sync <sqlite-file>
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
