import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { GazetteEdition, GazetteIssueKey } from '../src/corpora/gazette';

const fixtureRoot = new URL('./fixtures/gazette/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('week.json', fixtureRoot), 'utf8')) as {
  issues: (GazetteIssueKey & { file: string })[];
};
const bunScript = `
  import { fetchGazetteIssue, parseGazetteIssue } from './scripts/lib/gazette-source.ts';
  const input = JSON.parse(await Bun.stdin.text());
  try {
    if (input.action === 'parse') {
      console.log(JSON.stringify({ value: await parseGazetteIssue(input.html, input.key) }));
    } else {
      const body = input.oversize ? 'x'.repeat(2 * 1024 * 1024 + 1) : input.html;
      const send = async (_url, init) => new Response(body, {
        status: input.status ?? 200,
        headers: { 'Content-Type': input.contentType ?? 'text/html; charset=utf-8' },
      });
      const value = await fetchGazetteIssue(input.key, send);
      console.log(JSON.stringify({ value }));
    }
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
  }
`;

function runBun(payload: unknown): { value?: GazetteEdition; error?: string } {
  const command = process.env['CIVICSIGNAL_BUN_BINARY'] ?? 'bun';
  const result = spawnSync(command, ['--eval', bunScript], {
    cwd: process.cwd(), input: JSON.stringify(payload), encoding: 'utf8', timeout: 10_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(result.stderr.trim() || 'Gazette parser did not return JSON.');
  return JSON.parse(result.stdout.trim()) as { value?: GazetteEdition; error?: string };
}

function editionFrom(result: { value?: GazetteEdition; error?: string }): GazetteEdition {
  if (!result.value) throw new Error(result.error ?? 'Gazette parser returned no edition.');
  return result.value;
}

async function fixture(key: GazetteIssueKey): Promise<string> {
  const item = manifest.issues.find((issue) => issue.part === key.part && issue.language === key.language);
  if (!item) throw new Error('Missing Gazette fixture manifest entry.');
  return readFile(new URL(item.file, fixtureRoot), 'utf8');
}

const key = (part: 'I' | 'II', language: 'en' | 'fr'): GazetteIssueKey => part === 'I'
  ? { part, language, issueDate: '2026-04-25', volume: 160, issueNumber: 17 }
  : { part, language, issueDate: '2026-04-22', volume: 160, issueNumber: 8 };

async function parse(expected: GazetteIssueKey) {
  return runBun({ action: 'parse', key: expected, html: await fixture(expected) });
}

describe('Canada Gazette metadata-only source', () => {
  it('parses all four compact replay fixtures with exact counts and kinds', async () => {
    for (const item of manifest.issues) {
      const result = await parse(item);
      expect(result.error).toBeUndefined();
      const edition = editionFrom(result);
      expect(edition).toMatchObject(item);
      expect(edition.records).toHaveLength(item.part === 'I' ? 5 : 2);
      if (item.part === 'I') {
        expect(edition.records.filter((record) => record.kind === 'proposal')).toHaveLength(2);
        expect(edition.records.filter((record) => record.kind === 'notice')).toHaveLength(3);
      } else {
        expect(edition.records.every((record) => record.kind === 'instrument')).toBe(true);
      }
    }
  });

  it('preserves source identity and section citations across reordered bilingual links', async () => {
    for (const part of ['I', 'II'] as const) {
      const en = editionFrom(await parse(key(part, 'en')));
      const fr = editionFrom(await parse(key(part, 'fr')));
      const sourceIds = (edition: GazetteEdition) => edition.records.map((record) => record.id.split(':').at(-1)).sort();
      expect(sourceIds(en)).toEqual(sourceIds(fr));
      expect(new Set(en.records.map((record) => record.id)).size).toBe(en.records.length);
      expect(new Set(fr.records.map((record) => record.id)).size).toBe(fr.records.length);
      expect(en.records.some((record) => record.citationUrl.includes('#cs'))).toBe(part === 'I');
      expect(en.records.every((record) => record.citationUrl.startsWith('https://gazette.gc.ca/rp-pr/'))).toBe(true);
    }
  });

  it('keeps Part II registration distinct and excludes the linked statute from titles', async () => {
    for (const language of ['en', 'fr'] as const) {
      const edition = editionFrom(await parse(key('II', language)));
      const turkey = edition.records.find((record) => record.registrationNumber?.endsWith('65'));
      if (!turkey) throw new Error('Missing Turkey regulation fixture.');
      expect(turkey.title).not.toMatch(/Farm Products Agencies Act|Offices des produits agricoles/u);
      expect(turkey.title.endsWith(language === 'en' ? 'the' : 'sur le')).toBe(true);
      expect(edition.records.map((record) => record.registrationNumber).sort()).toEqual(
        language === 'en' ? ['SOR/2026-65', 'SOR/2026-66'] : ['DORS/2026-65', 'DORS/2026-66'],
      );
      expect(turkey.registrationDate).toBe('2026-03-31');
      const noDate = edition.records.find((record) => record.registrationNumber?.endsWith('66'));
      expect(noDate?.registrationDate).toBeUndefined();
      expect(edition.records.every((record) => !record.consultationDeadline && !record.effectiveDate)).toBe(true);
    }
  });

  it('rejects mismatched and unsupported editions instead of returning empty data', async () => {
    const html = await fixture(key('I', 'en'));
    expect(runBun({ action: 'parse', key: key('I', 'fr'), html }).error).toMatch(/metadata mismatch/u);
    expect(runBun({ action: 'parse', key: { ...key('I', 'en'), issueDate: '2026-04-18' }, html }).error).toMatch(/bounded/u);
    expect(runBun({ action: 'parse', key: { ...key('I', 'en'), issueNumber: 16 }, html }).error).toMatch(/bounded/u);
    expect(runBun({ action: 'parse', key: key('II', 'en'), html: '<html></html>' }).error).toMatch(/metadata mismatch/u);
  });

  it('fetches the configured index and rejects HTTP or media type errors', async () => {
    const expected = key('II', 'fr');
    const html = await fixture(expected);
    const parsed = runBun({ action: 'fetch', key: expected, html });
    expect(parsed.value?.records).toHaveLength(2);
    expect(runBun({ action: 'fetch', key: expected, html, status: 404 }).error).toMatch(/HTTP 404/u);
    expect(runBun({ action: 'fetch', key: expected, html, contentType: 'text/plain' }).error).toMatch(/text\/plain/u);
    expect(runBun({ action: 'fetch', key: { ...expected, issueDate: '2026-04-15' }, html }).error).toMatch(/bounded/u);
    expect(runBun({ action: 'fetch', key: expected, html, oversize: true }).error).toMatch(/byte limit/u);
  });
});
