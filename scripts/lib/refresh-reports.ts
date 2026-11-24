import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const dailyStepNames = ['consultations', 'committee-calls', 'funding'] as const;

type Scope = 'full' | 'partial';
type Run = {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  steps: Array<{ name: string; ok: boolean }>;
};
const aliases = ['latest.json', 'latest-full.json', 'latest-partial.json', 'latest-successful-full.json'];
const archive = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.json$/u;

export function refreshScope(steps: Run['steps']): Scope {
  const names = new Set(steps.map(step => step.name));
  return names.size === dailyStepNames.length && dailyStepNames.every(name => names.has(name)) ? 'full' : 'partial';
}

export function checkReportPath(directory: string, custom: string | undefined) {
  if (custom && aliases.some(name => resolve(directory, name) === custom)) {
    throw new Error('The report path is reserved for a refresh receipt alias');
  }
}

function write(path: string, report: Run) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function historicalReport(path: string): Run | undefined {
  try {
    const report = JSON.parse(readFileSync(path, 'utf8')) as Run;
    if (Number.isFinite(Date.parse(report.startedAt)) && Number.isFinite(Date.parse(report.finishedAt))
      && typeof report.ok === 'boolean' && Array.isArray(report.steps) && report.steps.length
      && report.steps.every(step => dailyStepNames.some(name => name === step.name) && typeof step.ok === 'boolean')) {
      return report;
    }
  } catch { /* A truncated legacy report cannot seed an alias. */ }
}

function seedMissingAliases(directory: string) {
  const candidates = [
    { file: 'latest-full.json', matches: (run: Run) => refreshScope(run.steps) === 'full' },
    { file: 'latest-partial.json', matches: (run: Run) => refreshScope(run.steps) === 'partial' },
    { file: 'latest-successful-full.json', matches: (run: Run) =>
      refreshScope(run.steps) === 'full' && run.ok && run.steps.every(step => step.ok) },
  ].filter(candidate => !existsSync(resolve(directory, candidate.file)));
  if (!candidates.length) return;
  // Include the legacy alias because a run using --report previously could omit the dated archive.
  const history = [...readdirSync(directory).filter(name => archive.test(name)), 'latest.json']
    .flatMap(name => historicalReport(resolve(directory, name)) ?? [])
    .sort((left, right) => Date.parse(right.finishedAt) - Date.parse(left.finishedAt));
  for (const candidate of candidates) {
    const match = history.find(candidate.matches);
    if (match) write(resolve(directory, candidate.file), match);
  }
}

export function publishRefreshReport(directory: string, report: Run, custom?: string) {
  checkReportPath(directory, custom);
  const reportPath = resolve(directory, `${report.startedAt.replace(/[:.]/g, '-')}.json`);
  const scope = refreshScope(report.steps);
  const document = { ...report, scope };
  write(reportPath, document);
  write(resolve(directory, `latest-${scope}.json`), document);
  if (scope === 'full' && report.ok) write(resolve(directory, 'latest-successful-full.json'), document);
  seedMissingAliases(directory);
  write(resolve(directory, 'latest.json'), document);
  if (custom && custom !== reportPath) write(custom, document);
  return custom ?? reportPath;
}
