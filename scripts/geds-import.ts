#!/usr/bin/env bun
/**
 * Complete local GEDS import.
 *
 *   bun scripts/geds-import.ts --csv /tmp/geds/gedsOpenData.csv \
 *     --db dist/geds/geds.sqlite --archive dist/geds/archive \
 *     --as-of 2026-11-24T00:00:00Z
 *
 * With no `--csv` it downloads the official ZIP from the catalogue's resource
 * URL, archives the original by SHA-256, and streams the Latin-1 CSV out of the
 * ZIP. A local report is written to `dist/geds/receipt.json`; an additional
 * receipt is written only when the caller supplies `--receipt`.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { applyGedsMigrations, openSqliteGedsDatabase } from './lib/sqlite-geds-db';
import { FileGedsArchive } from './lib/file-geds-archive';
import { GEDS_DATASET_ID, GEDS_SOURCE_URL, fetchGedsSource, refreshGeds } from '../src/geds/refresh';
import { firstValue } from '../src/geds/db';
import type { GedsRefreshSummary } from '../src/geds/types';

interface Args {
  csv?: string;
  download: boolean;
  db: string;
  archive: string;
  asOf?: string;
  sourceUrl: string;
  sourceDate?: string;
  report: string;
  receipt?: string;
}

interface SnapshotLanguageCoverage {
  rows?: number;
  title?: number;
  department?: number;
  organization?: number;
}

interface SnapshotManifest {
  effectiveAt?: string;
  counts?: {
    sourceRows?: number;
    storedRows?: number;
    people?: number;
    officeListings?: number;
    organizations?: number;
    roles?: number;
    changes?: GedsChangeCounts;
  };
  languageCoverage?: {
    en?: SnapshotLanguageCoverage;
    fr?: SnapshotLanguageCoverage;
  };
  missing?: Record<string, number>;
  unresolved?: { total?: number; sample?: GedsRefreshSummary['unresolved'] };
  duplicateRoleKeys?: number;
}

interface GedsChangeCounts {
  added?: number;
  changed?: number;
  removed?: number;
}
interface DatabaseCounts {
  people: number;
  organizations: number;
  roles: number;
  changes: number;
  observations: number;
  snapshots: number;
}

function valueOr<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

function receiptCounts(
  summary: GedsRefreshSummary,
  coverageCounts: SnapshotManifest['counts'],
  changeTotal: number,
  tables: DatabaseCounts,
) {
  return {
    sourceRows: valueOr(coverageCounts?.sourceRows, summary.counts.sourceRows),
    storedRoles: valueOr(coverageCounts?.storedRows, valueOr(coverageCounts?.roles, summary.counts.roles)),
    people: valueOr(coverageCounts?.people, summary.counts.people),
    officeListings: valueOr(coverageCounts?.officeListings, summary.counts.officeListings),
    organizations: valueOr(coverageCounts?.organizations, summary.counts.organizations),
    // What this run wrote. A replay writes nothing and verifies every row.
    added: summary.counts.added,
    changed: summary.counts.changedRoles,
    removed: summary.counts.removed,
    unchanged: summary.counts.unchanged,
    // How many change events the published snapshot records in total.
    changeEvents: changeTotal,
    database: tables,
  };
}

function fillLanguageCoverage(
  coverage: SnapshotLanguageCoverage | undefined,
  fallback: GedsRefreshSummary['languageCoverage']['en'],
) {
  return {
    rows: valueOr(coverage?.rows, fallback.rows),
    title: valueOr(coverage?.title, fallback.title),
    department: valueOr(coverage?.department, fallback.department),
    organization: valueOr(coverage?.organization, fallback.organization),
  };
}

function receiptCoverage(summary: GedsRefreshSummary, manifest: SnapshotManifest | null) {
  return {
    languageCoverage: {
      en: fillLanguageCoverage(manifest?.languageCoverage?.en, summary.languageCoverage.en),
      fr: fillLanguageCoverage(manifest?.languageCoverage?.fr, summary.languageCoverage.fr),
    },
    missing: manifest?.missing ?? (summary.changed ? summary.missing : null),
    unresolved: {
      count: manifest?.unresolved?.total ?? null,
      sample: valueOr(manifest?.unresolved?.sample, summary.unresolved),
    },
    duplicateRoleKeys: valueOr(manifest?.duplicateRoleKeys, summary.duplicateRoleKeys),
  };
}

function receiptImport(
  args: Args,
  summary: GedsRefreshSummary,
  latest: { snapshot_id: string; seq: number; published_at: string } | null,
  now: Date,
) {
  return {
    command: args.csv
      ? `bun scripts/geds-import.ts --csv ${args.csv} --db ${args.db} --archive ${args.archive} --as-of ${valueOr(args.asOf, now.toISOString())}`
      : `bun scripts/geds-import.ts --download --db ${args.db} --archive ${args.archive} --as-of ${valueOr(args.asOf, now.toISOString())}`,
    database: args.db,
    archive: args.archive,
    inputMode: args.csv ? 'caller-supplied-csv' : 'publisher-zip-download',
    // A replay verified the published snapshot and wrote nothing.
    outcome: summary.changed ? 'published' : 'replay',
    observationTime: summary.observation.observedAt,
    observationTimeSource: args.asOf ? 'caller-supplied --as-of' : 'import runtime clock',
    sourceDate: summary.observation.sourceDate ?? null,
    sourceDateSource: args.sourceDate
      ? 'caller-supplied --source-date'
      : args.csv
        ? null
        : summary.observation.sourceDate
          ? 'publisher Last-Modified header'
          : null,
    originalName: summary.observation.originalName ?? null,
    originalHash: summary.observation.zipSha256,
    csvHash: summary.observation.csvSha256,
    archiveKey: summary.observation.archiveKey ?? null,
    archived: summary.observation.archived,
    snapshot: summary.snapshot ? summary.snapshot : latest,
    durationMs: summary.durationMs,
    resumed: summary.resume,
  };
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    download: false,
    db: 'dist/geds/geds.sqlite',
    archive: 'dist/geds/archive',
    sourceUrl: GEDS_SOURCE_URL,
    report: 'dist/geds/receipt.json',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === '--csv') args.csv = next();
    else if (arg === '--download') args.download = true;
    else if (arg === '--db') args.db = next();
    else if (arg === '--archive') args.archive = next();
    else if (arg === '--as-of') args.asOf = next();
    else if (arg === '--source-url') args.sourceUrl = next();
    else if (arg === '--source-date') args.sourceDate = next();
    else if (arg === '--report') args.report = next();
    else if (arg === '--receipt') args.receipt = next();
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: bun scripts/geds-import.ts [--csv file | --download] [--db path] [--archive dir] [--as-of iso] [--source-date iso] [--report path] [--receipt path]',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return args;
}

async function importSource(
  args: Args,
  db: ReturnType<typeof openSqliteGedsDatabase>['db'],
  archive: FileGedsArchive,
  now: Date,
): Promise<GedsRefreshSummary> {
  if (args.csv) {
    const csvPath = resolve(args.csv);
    if (!existsSync(csvPath)) throw new Error(`no CSV at ${csvPath}`);
    console.log(`reading ${csvPath} (${(statSync(csvPath).size / 1024 / 1024).toFixed(1)} MB, ISO-8859-1)`);
    const bytes = new Uint8Array(readFileSync(csvPath));
    return refreshGeds({
      db,
      archive,
      now,
      datasetId: GEDS_DATASET_ID,
      sourceUrl: args.sourceUrl,
      csvBytes: bytes,
      originalFormat: 'csv',
    originalName: basename(csvPath),
      sourceDate: args.sourceDate,
      resume: true,
    });
  } else {
    console.log(`downloading ${args.sourceUrl}`);
    const fetched = await fetchGedsSource(args.sourceUrl);
    if (fetched.notModified) throw new Error('source answered 304; nothing to do');
    return refreshGeds({
      db,
      archive,
      now,
      datasetId: GEDS_DATASET_ID,
      sourceUrl: args.sourceUrl,
      zipBytes: fetched.zipBytes,
      originalFormat: 'zip',
      originalName: 'gedsOpenData.zip',
      sourceDate: args.sourceDate ?? fetched.sourceDate,
      etag: fetched.etag,
      contentLength: fetched.contentLength,
      resume: true,
    });
  }
}

function acquireWriterLock(dbPath: string): ReturnType<typeof openSqliteGedsDatabase>['raw'] {
  const { raw } = openSqliteGedsDatabase(`${dbPath}.writer-lock`);
  try {
    raw.exec('PRAGMA busy_timeout = 1000');
    raw.exec('BEGIN IMMEDIATE');
    return raw;
  } catch (error) {
    raw.close();
    throw new Error(`cannot acquire GEDS import writer lock for ${dbPath}: ${String(error)}`);
  }
}

async function changeEventTotal(
  db: ReturnType<typeof openSqliteGedsDatabase>['db'],
  seq: number | undefined,
): Promise<number> {
  if (seq === undefined) return 0;
  const result = await db
    .prepare(`SELECT COUNT(*) AS n FROM geds_changes WHERE seq = ?`)
    .bind(seq)
    .first<{ n: number }>();
  return Number(result?.n ?? 0);
}

async function makeReceipt(
  args: Args,
  summary: GedsRefreshSummary,
  archive: FileGedsArchive,
  db: ReturnType<typeof openSqliteGedsDatabase>['db'],
  now: Date,
) {
  const latest = await firstValue<{ snapshot_id: string; seq: number; published_at: string }>(
    db,
    `SELECT snapshot_id, seq, published_at FROM geds_snapshots WHERE status = 'published' ORDER BY seq DESC LIMIT 1`,
  );
  const manifest = summary.snapshot?.manifestKey
    ? await archive.getJson<SnapshotManifest>(summary.snapshot.manifestKey)
    : null;
  const coverageCounts = manifest?.counts;
  const changeTotal = await changeEventTotal(db, summary.snapshot?.seq ?? latest?.seq);
  const tables = {
    people: Number((await firstValue<{ n: number }>(db, `SELECT COUNT(*) AS n FROM geds_persons`))?.n ?? 0),
    organizations: Number(
      (await firstValue<{ n: number }>(db, `SELECT COUNT(*) AS n FROM geds_organizations WHERE valid_to_seq IS NULL`))?.n ?? 0,
    ),
    roles: Number(
      (await firstValue<{ n: number }>(db, `SELECT COUNT(*) AS n FROM geds_roles WHERE valid_to_seq IS NULL`))?.n ?? 0,
    ),
    changes: Number((await firstValue<{ n: number }>(db, `SELECT COUNT(*) AS n FROM geds_changes`))?.n ?? 0),
    observations: Number((await firstValue<{ n: number }>(db, `SELECT COUNT(*) AS n FROM geds_observations`))?.n ?? 0),
    snapshots: Number((await firstValue<{ n: number }>(db, `SELECT COUNT(*) AS n FROM geds_snapshots`))?.n ?? 0),
  };

  return {
    generatedAt: new Date().toISOString(),
    dataset: {
      id: GEDS_DATASET_ID,
      title: 'Government of Canada Employee Contact Information',
      titleFr: 'Information sur les coordonnées des fonctionnaires du gouvernement du Canada',
      publisher: 'Shared Services Canada / Services partagés Canada',
      licence: 'Open Government Licence - Canada',
      datasetUrl: `https://open.canada.ca/data/dataset/${GEDS_DATASET_ID}`,
      resourceUrl: args.sourceUrl,
      encoding: 'ISO-8859-1',
    },
    import: receiptImport(args, summary, latest, now),
    counts: receiptCounts(summary, coverageCounts, changeTotal, tables),
    ...receiptCoverage(summary, manifest),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = resolve(args.db);
  const archivePath = resolve(args.archive);
  mkdirSync(dirname(dbPath), { recursive: true });
  mkdirSync(archivePath, { recursive: true });

  const writerLock = acquireWriterLock(dbPath);
  try {
    const { db, raw } = openSqliteGedsDatabase(dbPath);
    try {
      const applied = applyGedsMigrations(raw, resolve('preview/geds/migrations'));
      console.log(`schema: ${applied.join(', ')}`);
      const archive = new FileGedsArchive(archivePath);

      const now = args.asOf ? new Date(args.asOf) : new Date();
      if (Number.isNaN(now.getTime())) throw new Error('--as-of is not a date');
      const summary = await importSource(args, db, archive, now);

      const receipt = await makeReceipt(args, summary, archive, db, now);

      const outputPaths = [args.report, ...(args.receipt ? [args.receipt] : [])];
      for (const path of outputPaths) {
        mkdirSync(dirname(resolve(path)), { recursive: true });
        writeFileSync(resolve(path), JSON.stringify(receipt, null, 2) + '\n');
      }

      console.log(JSON.stringify(receipt, null, 2));
    } finally {
      raw.close();
    }
  } finally {
    writerLock.exec('ROLLBACK');
    writerLock.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
