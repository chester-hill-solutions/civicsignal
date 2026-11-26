import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { discoverHouseHansardSession } from './lib/hansard-house-source';
import { discoverSenateHansardSession } from './lib/hansard-senate-source';
import { analyzeHansardSessionCoverage, type SessionReconciliation } from './lib/hansard-session-reconcile';

const USAGE = 'Usage: bun scripts/hansard-session-reconcile.ts <house|senate> <session> <sqlite-file> <weekly-archive-root> [YYYY-MM-DD] [receipt-root]';

export async function reconcileHansardSession(chamber: 'house' | 'senate', session: string, databaseFile: string,
  archiveDirectory: string, options: { cutoff?: string; receiptRoot?: string } = {}): Promise<Record<string, unknown>> {
  const cutoff = options.cutoff ?? lastCompletedSunday();
  if (!/^\d+-\d+$/u.test(session) || !/^\d{4}-\d{2}-\d{2}$/u.test(cutoff)) throw new Error('Invalid Hansard session or cutoff.');
  const calendar = chamber === 'house'
    ? await discoverHouseHansardSession(session, cutoff)
    : await discoverSenateHansardSession(session, cutoff);
  const absoluteDatabase = resolve(databaseFile);
  const absoluteArchive = resolve(archiveDirectory);
  const outputDirectory = resolve(options.receiptRoot ?? 'dist/hansard/reconciliation', session, chamber);
  const calendarObject = persistCalendarObject(outputDirectory, calendar.bytes);
  const { Database: SQLite } = createRequire(import.meta.url)('bun:sqlite') as {
    Database: new (file: string, options: { readonly: boolean }) => DatabaseSync;
  };
  const database = new SQLite(absoluteDatabase, { readonly: true });
  let analysis: SessionReconciliation;
  try { analysis = analyzeHansardSessionCoverage(database, chamber, session, calendar.sittings, { archiveRoot: absoluteArchive, cutoff }); }
  finally { database.close(); }
  const { repairs, verifiedWeeks } = repairMissingWeeks(analysis, chamber, session, absoluteDatabase, absoluteArchive);
  const finalDatabase = new SQLite(absoluteDatabase, { readonly: true });
  try { analysis = analyzeHansardSessionCoverage(finalDatabase, chamber, session, calendar.sittings, { archiveRoot: absoluteArchive, cutoff }); }
  finally { finalDatabase.close(); }
  if (!analysis.conflicts.length && !repairs.length) verifyLatestArchivedWeek(analysis, absoluteDatabase, absoluteArchive, verifiedWeeks);
  const workerFailures = verifiedWeeks.filter((check) => check.complete !== true);
  const complete = analysis.complete && repairs.every((repair) => repair.complete === true) && workerFailures.length === 0;
  const runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`;
  const sourceCalendar = {
    url: calendar.url,
    sourceSha256: createHash('sha256').update(calendar.bytes).digest('hex'),
    byteCount: calendar.bytes.length,
    archiveFile: calendarObject.file,
    archiveSha256: calendarObject.sha256,
    coverage: 'calendarDates' in calendar && Array.isArray(calendar.calendarDates)
      ? { firstCalendarDate: calendar.calendarDates[0] ?? null, lastCalendarDate: calendar.calendarDates.at(-1) ?? null,
        coveredCalendarDates: calendar.calendarDates.length }
      : { firstSittingDate: calendar.sittings[0]?.sittingDate ?? null, lastSittingDate: calendar.sittings.at(-1)?.sittingDate ?? null,
        coveredPublishedSittings: calendar.sittings.length },
  };
  const receipt = { schemaVersion: 1, runId, chamber, session, cutoff, completedAt: new Date().toISOString(),
    databasePath: absoluteDatabase, archiveRoot: absoluteArchive, calendar: sourceCalendar,
    counts: analysis.counts, expectedSittings: analysis.expected, weeklyCoverage: analysis.weeks,
    conflicts: analysis.conflicts, repairs, workerChecks: verifiedWeeks, complete };
  const receiptDirectory = resolve(outputDirectory, 'receipts');
  mkdirSync(receiptDirectory, { recursive: true });
  const receiptPath = resolve(receiptDirectory, `${runId}.json`);
  writeAtomicJson(receiptPath, receipt);
  const latestPath = resolve(receiptDirectory, 'latest.json');
  writeAtomicJson(latestPath, { receiptPath, runId, completedAt: receipt.completedAt, complete });
  return { complete, receiptPath, latestPath, counts: analysis.counts, repairs, workerChecks: verifiedWeeks, conflicts: analysis.conflicts };
}

function repairMissingWeeks(analysis: SessionReconciliation, chamber: 'house' | 'senate', session: string,
  database: string, archive: string): { repairs: Array<Record<string, unknown>>; verifiedWeeks: Array<Record<string, unknown>> } {
  const repairs: Array<Record<string, unknown>> = [];
  const verifiedWeeks: Array<Record<string, unknown>> = [];
  for (const missing of analysis.conflicts.length ? [] : analysis.missingWeeks) {
    const repair = runWeekRepair(chamber, session, missing.weekOf, database, archive);
    repairs.push({ weekOf: missing.weekOf, reasons: missing.reasons, ...repair });
    if (repair.complete) verifiedWeeks.push({ weekOf: missing.weekOf, ...verifyArchivedWeekWorker(database, archive, missing.weekOf) });
  }
  return { repairs, verifiedWeeks };
}

function verifyLatestArchivedWeek(analysis: SessionReconciliation, database: string, archive: string,
  verifiedWeeks: Array<Record<string, unknown>>): void {
  const latest = [...analysis.weeks].reverse().find((week) => week.archiveVerified);
  if (latest) verifiedWeeks.push({ weekOf: latest.weekOf, ...verifyArchivedWeekWorker(database, archive, latest.weekOf) });
}

function lastCompletedSunday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const dateText = ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)?.value).join('-');
  const date = new Date(`${dateText}T00:00:00Z`);
  const daysSinceSunday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - daysSinceSunday);
  return date.toISOString().slice(0, 10);
}

function persistCalendarObject(outputDirectory: string, bytes: Uint8Array): { file: string; sha256: string } {
  const directory = resolve(outputDirectory, 'objects');
  mkdirSync(directory, { recursive: true });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = resolve(directory, `${sha256}.html`);
  if (existsSync(file)) {
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== sha256) throw new Error('Retained Hansard calendar object failed its SHA-256 check.');
  } else writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  return { file, sha256 };
}

function runWeekRepair(chamber: 'house' | 'senate', session: string, weekOf: string,
  database: string, archive: string): { complete: boolean; captureExit: number | null; replayExit: number | null; errors: string[] } {
  const capture = spawnSync('bun', ['scripts/capture-hansard-week.ts', chamber, session, weekOf, resolve(archive, weekOf)], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60 * 60 * 1000,
  });
  const errors: string[] = [];
  if (capture.error) errors.push(`capture: ${capture.error.message}`);
  if (capture.status !== 0) errors.push(`capture: ${(capture.stderr || capture.stdout).trim().slice(-1200)}`);
  if (capture.status !== 0) return { complete: false, captureExit: capture.status, replayExit: null, errors };
  const command = chamber === 'house' ? 'replay-week' : 'replay-senate-week';
  const replay = spawnSync('bun', ['scripts/hansard-local.ts', command, database, resolve(archive, weekOf, 'current', 'week.json')], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60 * 60 * 1000,
  });
  if (replay.error) errors.push(`replay: ${replay.error.message}`);
  if (replay.status !== 0) errors.push(`replay: ${(replay.stderr || replay.stdout).trim().slice(-1200)}`);
  return { complete: replay.status === 0, captureExit: capture.status, replayExit: replay.status, errors };
}

export function evaluateWorkerVitestReport(exitCode: number | null, reportText: string): {
  complete: boolean; passed: number | null; failed: number | null; selectedTest: string | null; error?: string;
} {
  const selectedTest = 'Hansard preview HTTP contract retrieves a cited speech from each archived Hansard edition';
  try {
    const report = JSON.parse(reportText) as {
      success?: unknown; numPassedTests?: unknown; numFailedTests?: unknown;
      testResults?: Array<{ assertionResults?: Array<{ fullName?: unknown; status?: unknown }> }>;
    };
    if (!Array.isArray(report.testResults)) throw new Error('Vitest JSON report has no testResults array.');
    const assertions = report.testResults.flatMap((file) => Array.isArray(file.assertionResults) ? file.assertionResults : []);
    const matches = assertions.filter((assertion) => assertion.fullName === selectedTest);
    const complete = exitCode === 0 && report.success === true && report.numPassedTests === 1 && report.numFailedTests === 0 &&
      matches.length === 1 && matches[0]?.status === 'passed';
    return { complete, passed: typeof report.numPassedTests === 'number' ? report.numPassedTests : null,
      failed: typeof report.numFailedTests === 'number' ? report.numFailedTests : null,
      selectedTest: matches.length === 1 ? String(matches[0]?.status) : null,
      ...(!complete ? { error: 'Vitest did not report exactly one successful selected Worker check with zero failures.' } : {}) };
  } catch (error) {
    return { complete: false, passed: null, failed: null, selectedTest: null,
      error: `Invalid Vitest JSON report: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function verifyArchivedWeekWorker(database: string, archive: string, weekOf: string): Record<string, unknown> {
  const manifest = resolve(archive, weekOf, 'current', 'week.json');
  const receipt = resolve(archive, weekOf, 'current', 'receipt.json');
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'hansard-worker-check-'));
  const reportPath = join(temporaryDirectory, 'vitest.json');
  try {
    const result = spawnSync('bun', ['run', 'test', 'test/endpoints.test.ts', '-t', 'retrieves a cited speech from each archived Hansard edition',
      '--reporter=json', `--outputFile=${reportPath}`], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 5 * 60 * 1000,
      env: { ...process.env, CIVICSIGNAL_HANSARD_SQLITE: database,
        CIVICSIGNAL_HANSARD_WEEK_MANIFEST: manifest, CIVICSIGNAL_HANSARD_WEEK_RECEIPT: receipt },
    });
    let reportText = '';
    try { reportText = readFileSync(reportPath, 'utf8'); } catch { /* parsed as malformed/missing below */ }
    const qualification = evaluateWorkerVitestReport(result.status, reportText);
    const output = (result.stdout || result.stderr || '').trim();
    return { ...qualification, exitCode: result.status,
      summary: output.split('\n').filter((line) => /JSON report written|FAIL|Error/u.test(line)).slice(-8) };
  } finally { rmSync(temporaryDirectory, { recursive: true, force: true }); }
}

function writeAtomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let published = false;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
    published = true;
  } finally { if (!published) try { unlinkSync(temporary); } catch { /* no temporary remains */ } }
}

async function main(args: string[]): Promise<void> {
  const [chamber, session, database, archive, cutoff, receiptRoot] = args;
  if ((chamber !== 'house' && chamber !== 'senate') || !session || !database || !archive || args.length > 6) throw new Error(USAGE);
  const result = await reconcileHansardSession(chamber, session, database, archive, { cutoff, receiptRoot });
  console.log(JSON.stringify(result, null, 2));
  if (!result.complete) process.exitCode = 1;
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
