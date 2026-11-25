#!/usr/bin/env bun
/**
 * One daily refresh of the local intakes, each step isolated and reported.
 *
 * The daily set is the deadline-sensitive, cheap collections: consultations,
 * House committee calls and the funding catalogues. Heavier sources (the full
 * committee rewalk, GEDS, parliamentary catalogues) stay on a weekly operator
 * cadence; see docs/REFRESH.md.
 *
 *   bun scripts/refresh-daily.ts [--only consultations] [--report path]
 *
 * Every step writes its own receipt under dist/refresh/receipts. The run report
 * records each step's status, duration and change counts, and the process exits
 * non-zero when any step failed so launchd/cron surfaces it. A lock file stops
 * two runs overlapping; a stale lock from a dead process is replaced.
 */

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkReportPath, publishRefreshReport } from './lib/refresh-reports';
import { verifyCommitteeCalls, verifyConsultations, verifyFunding } from './lib/refresh-serving';

const ROOT = resolve(import.meta.dir, '..');
const REPORTS = resolve(ROOT, 'dist/refresh');
const RECEIPTS = resolve(REPORTS, 'receipts');
const LOCK = resolve(REPORTS, 'lock.json');

interface Step {
  name: string;
  timeoutMs: number;
  commands: string[][];
  /** Current acquisition receipt name under the receipts directory, if applicable. */
  receipt?: string;
  /** Which receipt fields summarise the step. */
  summary: (receipt: Record<string, unknown>, output: string[]) => Record<string, unknown>;
  verify: (receipt: Record<string, unknown>, outputs: string[]) => Promise<Record<string, unknown>>;
}

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const consultationStore = 'data/corpus/consultations/catalogue.sqlite';
const fundingStore = 'data/corpus/funding/catalogue.sqlite';
const committeeState = '.wrangler/committees-45-1';
const fundingReceipts = (output: string) => output.trim().split('\n').map(line =>
  JSON.parse(line) as Record<string, unknown>);

const steps: Step[] = [
  {
    name: 'consultations',
    timeoutMs: 180_000,
    commands: [[
      'bun', 'scripts/materialize-consultations.ts',
      '--csv', 'https://open.canada.ca/static/consultations_open.csv',
      '--schema', 'https://open.canada.ca/data/recombinant-published-schema/consultations.json',
      '--db', consultationStore,
    ]],
    receipt: 'consultations.json',
    summary: receipt => ({
      counts: receipt.counts,
      changes: (receipt.changes as Record<string, unknown> | undefined)?.categories ?? null,
      revision: receipt.revision,
    }),
    verify: receipt => verifyConsultations(resolve(ROOT, consultationStore), receipt),
  },
  {
    name: 'committee-calls',
    timeoutMs: 300_000,
    commands: [
      ['python3', '-B', 'scripts/committee-calls.py'],
      ['python3', '-B', 'scripts/materialize-committee-corpus.py', '--calls-only', '--persist-to', committeeState],
    ],
    receipt: 'committee-calls.json',
    summary: receipt => (receipt.counts as Record<string, unknown> | undefined) ?? {},
    verify: async (receipt, output) => {
      const publication = JSON.parse(output[1] ?? '') as Record<string, unknown>;
      if (typeof publication.database !== 'string') throw new Error('Committee publication has no local D1 path');
      const serving = await verifyCommitteeCalls(publication.database, receipt);
      return { ...serving, publication };
    },
  },
  {
    name: 'funding',
    timeoutMs: 900_000,
    commands: [
      ['python3', '-B', 'scripts/funding-nserc.py', '--output', 'data/corpus/funding/nserc.json'],
      ['python3', '-B', 'scripts/funding-esdc.py', '--output', 'data/corpus/funding/esdc.json'],
      ['bun', 'scripts/materialize-funding.ts', fundingStore,
        'data/corpus/funding/nserc.json', 'data/corpus/funding/esdc.json'],
    ],
    summary: (_receipt, output) => ({
      sources: fundingReceipts(output[2] ?? '').map(line => ({ source: line.source, events: line.events, gaps: line.gaps })),
    }),
    verify: (_receipt, output) => verifyFunding(resolve(ROOT, fundingStore), fundingReceipts(output[2] ?? '')),
  },
];

function args(argv: string[]) {
  const only: string[] = [];
  let report: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') only.push(argv[++i] ?? '');
    else if (argv[i] === '--report') {
      report = argv[++i];
      if (!report) throw new Error('--report requires a path');
    }
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return { only, report };
}

function acquireLock(): void {
  mkdirSync(REPORTS, { recursive: true });
  if (existsSync(LOCK)) {
    let held: { pid?: number; startedAt?: string } = {};
    try { held = json(LOCK); } catch { /* an unreadable lock is stale */ }
    const age = Date.now() - Date.parse(String(held.startedAt ?? 0));
    const alive = held.pid
      ? (() => { try { process.kill(Number(held.pid), 0); return true; } catch { return false; } })()
      : false;
    if (alive && age < 2 * 60 * 60 * 1000) {
      throw new Error(`another refresh is running (pid ${held.pid}, started ${held.startedAt})`);
    }
    unlinkSync(LOCK);
  }
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });
}

function releaseLock(): void {
  try { unlinkSync(LOCK); } catch { /* already gone */ }
}

const tail = (text: string, limit = 4000) => text.length > limit ? `…${text.slice(-limit)}` : text;

async function run(command: string[], timeoutMs: number, env = process.env) {
  const started = Date.now();
  const child = Bun.spawn(command, {
    cwd: ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return {
    command: command.join(' '),
    ok: exitCode === 0,
    exitCode,
    durationMs: Date.now() - started,
    stdout,
    stderr: tail(stderr),
  };
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

async function runStep(step: Step, temporary: string) {
  const started = Date.now();
  const receiptPath = step.receipt ? resolve(temporary, step.receipt) : undefined;
  const commands = [];
  let receipt: Record<string, unknown> = {};
  let summary: Record<string, unknown> = {};
  let serving: Record<string, unknown> | undefined;
  let error: string | undefined;
  try {
    for (const [index, command] of step.commands.entries()) {
      const input = index === 0 && receiptPath ? [...command, '--receipt', receiptPath] : command;
      const result = await run(input, step.timeoutMs);
      commands.push(result);
      if (!result.ok) throw new Error(`${command.slice(0, 3).join(' ')} exited with status ${result.exitCode}`);
      if (index === 0 && step.receipt && receiptPath) {
        receipt = json(receiptPath);
        renameSync(receiptPath, resolve(RECEIPTS, step.receipt));
        summary = step.summary(receipt, []);
      }
    }
    const output = commands.map(command => command.stdout);
    summary = step.summary(receipt, output);
    serving = await step.verify(receipt, output);
  } catch (failure) {
    error = errorMessage(failure);
  }
  return { name: step.name, ok: error === undefined, durationMs: Date.now() - started,
    commands: commands.map(command => ({ ...command, stdout: tail(command.stdout) })),
    summary, ...(serving ? { serving } : {}), ...(error ? { error } : {}) };
}

async function runLockedCommitteeStep(temporary: string): Promise<Awaited<ReturnType<typeof runStep>>> {
  const started = Date.now();
  const child = Bun.spawn(['python3', '-B', 'scripts/schedule/lock-committee.py', process.execPath, temporary], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code === 0) return JSON.parse(out) as Awaited<ReturnType<typeof runStep>>;
  return { name: 'committee-calls', ok: false, durationMs: Date.now() - started,
    commands: [], summary: {}, error: err.trim() || `Committee refresh exited with status ${code}` };
}

async function verifyDailyWorker(results: Awaited<ReturnType<typeof runStep>>[]) {
  const paths = Object.fromEntries(results.map(step => [step.name, step.serving?.database]));
  const checks = 'serves reconciled coverage, bilingual results and revisions from the acquired observation|computes dated states and follows bilingual listings to their acquired studies|follows both recommendations to the brief and related published terms';
  const result = await run(['bun', 'run', 'test', 'test/endpoints.test.ts', '-t', checks, '--reporter=json'], 180_000, {
    ...process.env,
    CIVICSIGNAL_CONSULTATIONS_SQLITE: String(paths.consultations),
    CIVICSIGNAL_CONSULTATIONS_RECEIPT: resolve(RECEIPTS, 'consultations.json'),
    CIVICSIGNAL_COMMITTEES_D1: String(paths['committee-calls']),
    CIVICSIGNAL_COMMITTEE_CALLS_RECEIPT: resolve(RECEIPTS, 'committee-calls.json'),
    CIVICSIGNAL_FUNDING_SQLITE: String(paths.funding),
  });
  if (!result.ok) throw new Error(result.stderr || tail(result.stdout));
  const report = JSON.parse(result.stdout) as { success: boolean; numPassedTests: number };
  if (!report.success || report.numPassedTests !== 4) throw new Error(`Expected four authenticated Worker checks to pass, observed ${report.numPassedTests}`);
  return { ok: true, passedTests: report.numPassedTests, durationMs: result.durationMs };
}

async function main() {
  if (process.argv[2] === '--locked-committee-step') {
    const step = steps.find(candidate => candidate.name === 'committee-calls');
    const temporary = process.argv[3];
    if (!step || !temporary) throw new Error('Missing committee step or receipt directory');
    console.log(JSON.stringify(await runStep(step, temporary)));
    return;
  }
  const { only, report } = args(process.argv.slice(2));
  const selected = only.length ? steps.filter(step => only.includes(step.name)) : steps;
  const unknown = only.filter(name => !steps.some(step => step.name === name));
  if (unknown.length) throw new Error(`unknown step(s): ${unknown.join(', ')}`);
  const custom = report ? resolve(ROOT, report) : undefined;
  checkReportPath(REPORTS, custom);

  acquireLock();
  let temporary: string | undefined;
  try {
    const startedAt = new Date().toISOString();
    mkdirSync(RECEIPTS, { recursive: true });
    temporary = mkdtempSync(resolve(RECEIPTS, '.run-'));
    const results = [];
    for (const step of selected) {
      const result = step.name === 'committee-calls' ? await runLockedCommitteeStep(temporary) : await runStep(step, temporary);
      results.push(result);
      console.log(`${result.ok ? 'ok  ' : 'fail'} ${step.name} ${result.durationMs}ms`);
      if (result.error) console.error(result.error);
    }
    let workerVerification;
    if (results.length === steps.length && results.every(step => step.ok)) {
      try { workerVerification = await verifyDailyWorker(results); }
      catch (failure) { workerVerification = { ok: false, error: errorMessage(failure) }; }
    }
    const finishedAt = new Date().toISOString();
    const document = {
      startedAt,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      ok: results.every(result => result.ok) && workerVerification?.ok !== false,
      ...(workerVerification ? { workerVerification } : {}),
      steps: results,
    };
    const reportPath = publishRefreshReport(REPORTS, document, custom);
    console.log(JSON.stringify({ ok: document.ok, durationMs: document.durationMs, report: reportPath }));
    if (!document.ok) process.exitCode = 1;
  } finally {
    releaseLock();
    if (temporary) rmSync(temporary, { force: true, recursive: true });
  }
}

if (import.meta.main) main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 2;
});
