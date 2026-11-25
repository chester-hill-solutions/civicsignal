import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GazetteIssueKey } from '../src/corpora/gazette';

const script = `
  import { discoverCurrentGazetteIssues, parseGazetteAnnualListing } from './scripts/lib/gazette-current.ts';
  import { syncCurrent } from './scripts/gazette-local.ts';
  import { readFileSync } from 'node:fs';
  const input = JSON.parse(await Bun.stdin.text());
  try {
    if (input.action === 'parse') {
      console.log(JSON.stringify({ issues: parseGazetteAnnualListing(input.html, input.year, input.part, input.language, input.cutoff) }));
    } else if (input.action === 'sync-fail') {
      let issueRequests = 0;
      const send = async (url) => {
        if (url.pathname.includes('/html/index-')) {
          issueRequests += 1;
          if (issueRequests === 4) return new Response('unavailable', { status: 502, headers: { 'Content-Type': 'text/html' } });
          return new Response(input.issuePages[url.pathname] ?? '', { status: 200, headers: { 'Content-Type': 'text/html' } });
        }
        return new Response(input.pages[url.pathname] ?? '', { status: input.pages[url.pathname] ? 200 : 404,
          headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      };
      await syncCurrent(input.database, input.cutoff, send, input.receipt);
      console.log(JSON.stringify({ complete: true }));
    } else if (input.action === 'sync') {
      const send = async (url) => {
        const isIssue = url.pathname.includes('/html/index-');
        const source = isIssue ? input.issuePages : input.pages;
        return new Response(source[url.pathname] ?? '', {
          status: source[url.pathname] ? 200 : 404,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      };
      await syncCurrent(input.database, input.cutoff, send, input.receipt);
      console.log(JSON.stringify({ complete: true, receipt: JSON.parse(readFileSync(input.receipt, 'utf8')) }));
    } else {
      const send = async (url) => new Response(input.pages[url.pathname] ?? '', {
        status: input.pages[url.pathname] ? 200 : 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
      console.log(JSON.stringify({ issues: await discoverCurrentGazetteIssues(input.cutoff, send) }));
    }
  } catch (error) { console.log(JSON.stringify({ error: error.message })); }
`;

function run(payload: unknown): { issues?: GazetteIssueKey[]; error?: string; receipt?: Record<string, unknown> } {
  const result = spawnSync(process.env['CIVICSIGNAL_BUN_BINARY'] ?? 'bun', ['--eval', script], {
    cwd: process.cwd(), input: JSON.stringify(payload), encoding: 'utf8', timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(result.stderr.trim() || 'Gazette annual parser returned no JSON.');
  return JSON.parse(result.stdout.trim()) as { issues?: GazetteIssueKey[]; error?: string; receipt?: Record<string, unknown> };
}

function annual(year: number, part: 'I' | 'II', language: 'en' | 'fr', issues: Array<{ date: string; volume: number; number: number; type?: string }>) {
  const eng = language === 'en';
  const label = (item: typeof issues[number]) => eng
    ? `Part ${part}, volume ${item.volume}, number ${item.number}`
    : `Partie ${part}, volume ${item.volume}, numéro ${item.number}`;
  const rows = issues.map((item) => `<tr><td data-order="${item.date}">${item.date}</td><td><a href="/rp-pr/p${part === 'I' ? '1' : '2'}/${year}/${item.date}/html/index-${eng ? 'eng' : 'fra'}.html">${label(item)}</a></td><td>${item.type ?? (eng ? 'Regular edition' : 'Édition régulière')}</td></tr>`).join('');
  const partTitle = eng ? `Part ${part}` : `Partie ${part}`;
  const title = eng ? `Canada Gazette, ${partTitle}: Volume 160` : `La Gazette du Canada, ${partTitle} : volume 160`;
  return `<html lang="${eng ? 'en' : 'fr'}"><head><title>${title}</title></head><body><h1>${title}</h1><table>${rows}</table></body></html>`;
}

function pages(overrides: Record<string, string> = {}) {
  const value: Record<string, string> = {};
  for (const year of [2025, 2026]) for (const part of ['I', 'II'] as const) for (const language of ['en', 'fr'] as const) {
    const early = year === 2025 ? [{ date: '2025-12-20', volume: 159, number: 50 }] : [
      { date: '2026-11-21', volume: 160, number: part === 'I' ? 47 : 21 },
      { date: '2026-11-06', volume: 160, number: 44, type: language === 'en' ? 'Erratum' : 'Erratum' },
      { date: '2026-01-03', volume: 160, number: 1 },
    ];
    const path = `/rp-pr/p${part === 'I' ? '1' : '2'}/${year}/index-${language === 'en' ? 'eng' : 'fra'}.html`;
    value[path] = annual(year, part, language, early);
  }
  return { ...value, ...overrides };
}

function fixtureSyncInputs() {
  const annualPages: Record<string, string> = {};
  const issuePages: Record<string, string> = {};
  const manifest = JSON.parse(readFileSync('test/fixtures/gazette/week.json', 'utf8')) as {
    issues: Array<{ part: 'I' | 'II'; language: 'en' | 'fr'; issueDate: string; volume: number; issueNumber: number; file: string }>;
  };
  for (const part of ['I', 'II'] as const) for (const language of ['en', 'fr'] as const) {
    const issue = manifest.issues.find((item) => item.part === part && item.language === language);
    if (!issue) throw new Error('Missing Gazette fixture issue.');
    for (const year of [2025, 2026]) {
      const path = `/rp-pr/p${part === 'I' ? '1' : '2'}/${year}/index-${language === 'en' ? 'eng' : 'fra'}.html`;
      annualPages[path] = annual(year, part, language, year === 2025
        ? [{ date: '2025-12-20', volume: 159, number: 50 }]
        : [{ date: issue.issueDate, volume: issue.volume, number: issue.issueNumber }]);
    }
    issuePages[`/rp-pr/p${part === 'I' ? '1' : '2'}/${issue.issueDate.slice(0, 4)}/${issue.issueDate}/html/index-${language === 'en' ? 'eng' : 'fra'}.html`]
      = readFileSync(`test/fixtures/gazette/${issue.file}`, 'utf8');
  }
  return { annualPages, issuePages };
}

describe('Canada Gazette rolling current-issue discovery', () => {
  it('selects latest shared regular issues and excludes nonregular rows', () => {
    const parsed = run({ cutoff: '2026-11-24', pages: pages() });
    expect(parsed.error).toBeUndefined();
    expect(parsed.issues).toEqual([
      { part: 'I', language: 'en', issueDate: '2026-11-21', volume: 160, issueNumber: 47 },
      { part: 'I', language: 'fr', issueDate: '2026-11-21', volume: 160, issueNumber: 47 },
      { part: 'II', language: 'en', issueDate: '2026-11-21', volume: 160, issueNumber: 21 },
      { part: 'II', language: 'fr', issueDate: '2026-11-21', volume: 160, issueNumber: 21 },
    ]);
  });

  it('uses the prior annual listing at the calendar boundary', () => {
    const parsed = run({ cutoff: '2026-01-02', pages: pages() });
    expect(parsed.error).toBeUndefined();
    expect(parsed.issues?.every((issue) => issue.issueDate === '2025-12-20')).toBe(true);
  });

  it('fails if the latest English regular issue is missing from the French listing', () => {
    const source = annual(2026, 'I', 'fr', [{ date: '2026-01-03', volume: 160, number: 1 }]);
    const parsed = run({ cutoff: '2026-11-24', pages: pages({ '/rp-pr/p1/2026/index-fra.html': source }) });
    expect(parsed.error).toMatch(/issue mismatch/u);
  });

  it('fails if the latest French regular issue is newer than the English listing', () => {
    const source = annual(2026, 'I', 'fr', [
      { date: '2026-11-22', volume: 160, number: 48 },
      { date: '2026-11-21', volume: 160, number: 47 },
    ]);
    const parsed = run({ cutoff: '2026-11-24', pages: pages({ '/rp-pr/p1/2026/index-fra.html': source }) });
    expect(parsed.error).toMatch(/issue mismatch/u);
  });

  it('parses a single official listing entry and ignores later nonregular rows', () => {
    const html = annual(2026, 'I', 'en', [
      { date: '2026-11-21', volume: 160, number: 47 },
      { date: '2026-11-06', volume: 160, number: 44, type: 'Erratum' },
    ]);
    const parsed = run({ action: 'parse', year: 2026, part: 'I', language: 'en', cutoff: '2026-11-24', html });
    expect(parsed.issues).toEqual([{ part: 'I', language: 'en', issueDate: '2026-11-21', volume: 160, issueNumber: 47 }]);
  });

  it('leaves an existing local database untouched when the fourth fetched issue fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gazette-sync-failure-'));
    const database = join(directory, 'current.sqlite');
    const original = Buffer.from('prior-local-generation');
    writeFileSync(database, original);
    try {
      const { annualPages, issuePages } = fixtureSyncInputs();
      const receipt = join(directory, 'receipt.json');
      const priorReceipt = Buffer.from('prior-receipt');
      writeFileSync(receipt, priorReceipt);
      const result = run({ action: 'sync-fail', database, receipt, cutoff: '2026-04-26', pages: annualPages, issuePages });
      expect(result.error).toMatch(/HTTP 502/u);
      expect(readFileSync(database)).toEqual(original);
      expect(readFileSync(receipt)).toEqual(priorReceipt);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('writes a receipt only after the current editions commit to the local database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gazette-sync-receipt-'));
    const database = join(directory, 'current.sqlite');
    const receipt = join(directory, 'receipt.json');
    try {
      const { annualPages, issuePages } = fixtureSyncInputs();
      const result = run({ action: 'sync', database, receipt, cutoff: '2026-04-26', pages: annualPages, issuePages });
      expect(result.error).toBeUndefined();
      expect(result.receipt).toMatchObject({ schemaVersion: 1, source: 'https://gazette.gc.ca', databasePath: database,
        editions: expect.arrayContaining([
          expect.objectContaining({ part: 'I', language: 'en', issueDate: '2026-04-25', recordCount: expect.any(Number) }),
          expect.objectContaining({ part: 'I', language: 'fr', issueDate: '2026-04-25', recordCount: expect.any(Number) }),
          expect.objectContaining({ part: 'II', language: 'en', issueDate: '2026-04-22', recordCount: expect.any(Number) }),
          expect.objectContaining({ part: 'II', language: 'fr', issueDate: '2026-04-22', recordCount: expect.any(Number) }),
        ]) });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
