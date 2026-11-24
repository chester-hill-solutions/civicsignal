import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dailyStepNames, publishRefreshReport } from '../scripts/lib/refresh-reports';

function run(minute: number, names: readonly string[], ok = true) {
  const startedAt = new Date(Date.UTC(2026, 10, 24, 12, minute)).toISOString();
  return {
    startedAt,
    finishedAt: startedAt,
    ok,
    steps: names.map(name => ({ name, ok: ok || name !== 'committee-calls' })),
  };
}

describe('daily refresh reports', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'refresh-reports-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  function read(name: string) {
    return JSON.parse(readFileSync(join(directory, name), 'utf8')) as ReturnType<typeof run> & { scope?: string };
  }

  it('keeps full attempts, successful full runs and partial runs independently', () => {
    const success = run(1, dailyStepNames);
    const failed = run(2, dailyStepNames, false);
    const partial = run(3, ['consultations']);
    publishRefreshReport(directory, success);
    publishRefreshReport(directory, failed);
    const custom = join(directory, 'operator-report.json');
    expect(publishRefreshReport(directory, partial, custom)).toBe(custom);
    expect(read('latest.json')).toEqual({ ...partial, scope: 'partial' });
    expect(read('latest-partial.json')).toEqual(read('operator-report.json'));
    expect(read('latest-full.json')).toEqual({ ...failed, scope: 'full' });
    expect(read('latest-successful-full.json')).toEqual({ ...success, scope: 'full' });
    expect(read('2026-11-24T12-03-00-000Z.json')).toEqual(read('operator-report.json'));
  });

  it('seeds the last legacy full run even if the old latest alias is partial', () => {
    const full = run(1, dailyStepNames);
    const oldPartial = run(2, ['committee-calls']);
    writeFileSync(join(directory, '2026-11-24T12-01-00-000Z.json'), JSON.stringify(full));
    writeFileSync(join(directory, '2026-11-24T12-02-00-000Z.json'), '{"interrupted":');
    writeFileSync(join(directory, 'latest.json'), JSON.stringify(oldPartial));
    publishRefreshReport(directory, run(3, ['funding']));
    expect(read('latest-full.json')).toEqual(full);
    expect(read('latest-successful-full.json')).toEqual(full);
    expect(read('latest-partial.json').steps.map(step => step.name)).toEqual(['funding']);
  });

  it('reserves canonical aliases for the publication logic', () => {
    const success = run(1, dailyStepNames);
    publishRefreshReport(directory, success);
    expect(() => publishRefreshReport(directory, run(2, ['consultations']), join(directory, 'latest-full.json')))
      .toThrow('reserved');
    expect(read('latest-full.json').startedAt).toBe(success.startedAt);
  });
});
