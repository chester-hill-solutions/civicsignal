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

import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const REPORTS = resolve(ROOT, 'dist/refresh');
const RECEIPTS = resolve(REPORTS, 'receipts');
const LOCK = resolve(REPORTS, 'lock.json');

interface Step {
  name: string;
  timeoutMs: number;
  commands: string[][];
  /** Where the step's own receipt lands, when it writes one. */
  receipt?: string;
  /** Which receipt fields summarise the step. */
  summary: (receipt: Record<string, unknown>, output: string[]) => Record<string, unknown>;
}

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const consultationsReceipt = resolve(RECEIPTS, 'consultations.json');
const callsReceipt = resolve(RECEIPTS, 'committee-calls.json');

const steps: Step[] = [
  {
    name: 'consultations',
    timeoutMs: 180_000,
    commands: [[
      'bun', 'scripts/materialize-consultations.ts',
      '--csv', 'https://open.canada.ca/static/consultations_open.csv',
      '--schema', 'https://open.canada.ca/data/recombinant-published-schema/consultations.json',
      '--db', 'data/corpus/consultations/catalogue.sqlite',
      '--receipt', consultationsReceipt,
    ]],
    receipt: consultationsReceipt,
    summary: receipt => ({
      counts: receipt.counts,
      changes: (receipt.changes as Record<string, unknown> | undefined)?.categories ?? null,
      revision: receipt.revision,
    }),
  },
  {
    name: 'committee-calls',
    timeoutMs: 300_000,
    commands: [['python3', '-B', 'scripts/committee-calls.py', '--receipt', callsReceipt]],
    receipt: callsReceipt,
    summary: receipt => (receipt.counts as Record<string, unknown> | undefined) ?? {},
  },
  {
    name: 'funding',
    timeoutMs: 900_000,
    commands: [
      ['python3', '-B', 'scripts/funding-nserc.py', '--output', 'data/corpus/funding/nserc.json'],
      ['python3', '-B', 'scripts/funding-esdc.py', '--output', 'data/corpus/funding/esdc.json'],
      ['bun', 'scripts/materialize-funding.ts', 'data/corpus/funding/catalogue.sqlite',
        'data/corpus/funding/nserc.json', 'data/corpus/funding/esdc.json'],
    ],
    summary: (_receipt, output) => {
      const lines = output.flatMap(line => {
        try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
      });
      return {
        sources: lines.map(line => ({ source: line.source, events: line.events, gaps: line.gaps })),
      };
    },
  },
];

function args(argv: string[]) {
  const only: string[] = [];
  let report: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') only.push(argv[++i] ?? '');
    else if (argv[i] === '--report') report = argv[++i];
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
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
}

function releaseLock(): void {
  try { unlinkSync(LOCK); } catch { /* already gone */ }
}

const tail = (text: string, limit = 4000) => text.length > limit ? `…${text.slice(-limit)}` : text;

async function run(command: string[], timeoutMs: number) {
  const started = Date.now();
  const child = Bun.spawn(command, {
    cwd: ROOT,
    env: process.env,
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
    stdout: tail(stdout),
    stderr: tail(stderr),
  };
}

async function main() {
  const { only, report } = args(process.argv.slice(2));
  const selected = only.length ? steps.filter(step => only.includes(step.name)) : steps;
  const unknown = only.filter(name => !steps.some(step => step.name === name));
  if (unknown.length) throw new Error(`unknown step(s): ${unknown.join(', ')}`);

  acquireLock();
  const startedAt = new Date().toISOString();
  const results = [];
  try {
    mkdirSync(RECEIPTS, { recursive: true });
    for (const step of selected) {
      const commands = [];
      for (const command of step.commands) {
        const result = await run(command, step.timeoutMs);
        commands.push(result);
        if (!result.ok) break;
      }
      const ok = commands.every(command => command.ok);
      let summary: Record<string, unknown> = {};
      if (ok && step.receipt) {
        try { summary = step.summary(json(step.receipt), commands.flatMap(command => command.stdout.split('\n'))); }
        catch { summary = { receipt: 'unreadable' }; }
      } else if (ok) {
        summary = step.summary({}, commands.flatMap(command => command.stdout.split('\n')));
      }
      const result = {
        name: step.name,
        ok,
        durationMs: commands.reduce((total, command) => total + command.durationMs, 0),
        commands,
        summary,
      };
      results.push(result);
      console.log(`${ok ? 'ok  ' : 'fail'} ${step.name} ${result.durationMs}ms`);
    }
  } finally {
    releaseLock();
  }

  const finishedAt = new Date().toISOString();
  const reportPath = report
    ? resolve(ROOT, report)
    : resolve(REPORTS, `${startedAt.replace(/[:.]/g, '-')}.json`);
  const document = {
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    ok: results.every(result => result.ok),
    steps: results,
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(document, null, 2) + '\n');
  writeFileSync(resolve(REPORTS, 'latest.json'), JSON.stringify(document, null, 2) + '\n');
  console.log(JSON.stringify({ ok: document.ok, durationMs: document.durationMs, report: reportPath }));
  if (!document.ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
