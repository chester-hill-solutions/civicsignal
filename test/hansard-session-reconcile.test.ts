import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHouseHansardSessionCalendar } from '../scripts/lib/hansard-house-source';
import { analyzeHansardSessionCoverage } from '../scripts/lib/hansard-session-reconcile';
import { evaluateWorkerVitestReport } from '../scripts/hansard-session-reconcile';
import { importHansardEdition } from '../scripts/lib/hansard-store';
import { testD1 } from './helpers/d1';
import type { HansardSittingRef } from '../scripts/lib/hansard-week';
import { readFileSync } from 'node:fs';

const houseDates = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];
const houseCell = (date: string, sitting?: number) => `<td class="${sitting ? 'chamber-meeting' : ''}"><div><div class="${date}">` +
  (sitting ? `<a href="/documentviewer/en/45-1/house/sitting-${sitting}/hansard">${date}</a>` : '') + '</div></div></td>';

describe('current-session Hansard reconciliation', () => {
  it('parses all House calendar dates and excludes future sitting dates after the pinned cutoff', () => {
    const html = `<table class="publications-calendar"><tbody><tr>${houseDates.map((date, index) => houseCell(date, index === 0 ? 165 : index === 4 ? 169 : undefined)).join('')}</tr></tbody></table>`;
    expect(parseHouseHansardSessionCalendar(html, '45-1', '2026-11-18')).toEqual({
      cutoff: '2026-11-18', calendarDates: houseDates.slice(0, 3),
      sittings: [{ sittingId: '45-1-165', sittingDate: '2026-11-16' }],
    });
  });

  it('extracts all Senate issue dates from the session page without inferring quiet weeks', () => {
    const html = `<html lang="en"><head><title>Debates of the Senate (Hansard) - 45-1</title></head><body>
      <div class="sc-in-the-chamber-calendar-table-day"><a href="/en/content/sen/chamber/451/debates/001db_2025-05-26-e">26</a></div>
      <div class="sc-in-the-chamber-calendar-table-day"><a href="/en/content/sen/chamber/451/debates/002db_2025-05-27-e">27</a></div>
      <div class="sc-in-the-chamber-calendar-table-day"><a href="/en/content/sen/chamber/451/debates/003db_2025-06-02-e">2</a></div>
    </body></html>`;
    const script = `import { parseSenateHansardSessionCalendar } from './scripts/lib/hansard-senate-source.ts';
      const input=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify(parseSenateHansardSessionCalendar(input.html,'45-1')));`;
    const result = spawnSync('bun', ['--eval', script], { cwd: process.cwd(), input: JSON.stringify({ html }), encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0) throw new Error(result.stderr || 'Senate session calendar parser did not return.');
    expect(JSON.parse(result.stdout).sittings).toEqual([
      { sittingId: '45-1-1', sittingDate: '2025-05-26' },
      { sittingId: '45-1-2', sittingDate: '2025-05-27' },
      { sittingId: '45-1-3', sittingDate: '2025-06-02' },
    ]);
  });

  describe('local/feed/archive comparison', () => {
    let store: ReturnType<typeof testD1>;
    let directory: string;
    beforeEach(() => { store = testD1(); directory = mkdtempSync(join(tmpdir(), 'hansard-session-check-')); });
    afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

    it('reports a missing sitting week with independently complete House and feed rows', () => {
      const edition = readFileSync('test/fixtures/hansard/sitting-en.xml');
      const french = readFileSync('test/fixtures/hansard/sitting-fr.xml');
      importHansardEdition(store.sqlite, edition);
      importHansardEdition(store.sqlite, french);
      const expected: HansardSittingRef[] = [{ sittingId: '45-1-999', sittingDate: '2026-04-01' }];
      const result = analyzeHansardSessionCoverage(store.sqlite, 'house', '45-1', expected, { archiveRoot: directory, cutoff: '2026-11-22' });
      expect(result.counts).toMatchObject({ expectedSittings: 1, expectedEditions: 2, localEditions: 2, feedEditions: 2,
        archiveVerifiedWeeks: 0, missingWeeks: 1, conflicts: 0 });
      expect(result.missingWeeks[0]).toMatchObject({ weekOf: '2026-03-30', reasons: ['weekly-archive-or-receipt-missing'] });
    });

    it('fails closed when the local database has a sitting outside the current publisher calendar', () => {
      importHansardEdition(store.sqlite, readFileSync('test/fixtures/hansard/sitting-en.xml'));
      const result = analyzeHansardSessionCoverage(store.sqlite, 'house', '45-1', [], { archiveRoot: directory, cutoff: '2026-11-22' });
      expect(result.complete).toBe(false);
      expect(result.conflicts).toContain('house local edition exists outside the current publisher calendar: 45-1-999 en.');
    });

    it('ignores rows newer than an explicit pinned cutoff while preserving in-window conflicts', () => {
      importHansardEdition(store.sqlite, readFileSync('test/fixtures/hansard/sitting-en.xml'));
      const pinned = analyzeHansardSessionCoverage(store.sqlite, 'house', '45-1', [], { archiveRoot: directory, cutoff: '2026-03-31' });
      expect(pinned).toMatchObject({ complete: true, counts: { localEditions: 0, feedEditions: 0, conflicts: 0 } });
      const inWindow = analyzeHansardSessionCoverage(store.sqlite, 'house', '45-1', [], { archiveRoot: directory, cutoff: '2026-04-01' });
      expect(inWindow.complete).toBe(false);
      expect(inWindow.conflicts).toContain('house local edition exists outside the current publisher calendar: 45-1-999 en.');
    });

    it('rejects duplicate sitting identities in an otherwise hash-verified archive manifest', () => {
      const english = readFileSync('test/fixtures/hansard/sitting-en.xml');
      const french = readFileSync('test/fixtures/hansard/sitting-fr.xml');
      importHansardEdition(store.sqlite, english);
      importHansardEdition(store.sqlite, french);
      const sitting = { sittingId: '45-1-999', sittingDate: '2026-04-01' };
      const weekRoot = join(directory, '2026-03-30', 'current');
      mkdirSync(weekRoot, { recursive: true });
      const enHash = createHash('sha256').update(english).digest('hex');
      const frHash = createHash('sha256').update(french).digest('hex');
      writeFileSync(join(weekRoot, `${enHash}.xml`), english);
      writeFileSync(join(weekRoot, `${frHash}.xml`), french);
      const archived = { ...sitting, en: `${enHash}.xml`, fr: `${frHash}.xml` };
      writeFileSync(join(weekRoot, 'week.json'), JSON.stringify({ weekOf: '2026-03-30', sittings: [archived, archived] }));
      writeFileSync(join(weekRoot, 'receipt.json'), JSON.stringify({
        chamber: 'house', session: '45-1', weekOf: '2026-03-30', lookupSamples: [
          { ...sitting, language: 'en', sourceSha256: enHash }, { ...sitting, language: 'fr', sourceSha256: frHash },
        ],
      }));

      const result = analyzeHansardSessionCoverage(store.sqlite, 'house', '45-1', [sitting],
        { archiveRoot: directory, cutoff: '2026-04-01' });
      expect(result.complete).toBe(false);
      expect(result.weeks[0]?.archiveVerified).toBe(false);
      expect(result.missingWeeks[0]?.reasons).toContain('weekly-archive-duplicate-sitting:45-1-999:2026-04-01');
    });
  });

  describe('Worker Vitest qualification', () => {
    const selected = 'Hansard preview HTTP contract retrieves a cited speech from each archived Hansard edition';
    const report = (status: string, passed = 1, failed = 0) => JSON.stringify({
      success: failed === 0, numPassedTests: passed, numFailedTests: failed,
      testResults: [{ assertionResults: [{ fullName: selected, status }] }],
    });

    it('requires exactly one passing selected check and zero failures', () => {
      expect(evaluateWorkerVitestReport(0, report('passed'))).toMatchObject({ complete: true, passed: 1, failed: 0, selectedTest: 'passed' });
      expect(evaluateWorkerVitestReport(0, report('passed', 0))).toMatchObject({ complete: false });
      expect(evaluateWorkerVitestReport(0, report('passed', 2))).toMatchObject({ complete: false });
      expect(evaluateWorkerVitestReport(1, report('passed'))).toMatchObject({ complete: false });
    });

    it('rejects skipped and malformed reports even when the process exits successfully', () => {
      expect(evaluateWorkerVitestReport(0, report('skipped', 0))).toMatchObject({ complete: false, selectedTest: 'skipped' });
      expect(evaluateWorkerVitestReport(0, '{not json')).toMatchObject({ complete: false, passed: null, failed: null });
      expect(evaluateWorkerVitestReport(0, JSON.stringify({ success: true, numPassedTests: 1, numFailedTests: 0 })))
        .toMatchObject({ complete: false });
    });
  });
});
