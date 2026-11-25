import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { validateGazetteExtraPdfText } from '../scripts/lib/gazette-extra-source';

const script = `
  import { Database } from 'bun:sqlite';
  import { readFileSync } from 'node:fs';
  import { parseGazetteExtraEdition } from './scripts/lib/gazette-extra-source.ts';
  import { importGazetteExtraEditionBatch } from './scripts/lib/gazette-extra-store.ts';
  import { importGazetteEdition } from './scripts/lib/gazette-store.ts';
  import { gazetteExtraIssueId, gazetteExtraRecordId } from './src/corpora/gazette-extra.ts';
  import { gazetteRecordId } from './src/corpora/gazette.ts';
  const db = new Database(':memory:');
  db.exec(readFileSync('./preview/gazette/migrations/0001_gazette.sql', 'utf8'));
  db.exec(readFileSync('./preview/gazette/migrations/0002_gazette_extras.sql', 'utf8'));
  const key = { part: 'II', language: 'en', issueDate: '2026-06-08', volume: 160, extraNumber: 1 };
  const html = '<html lang="en"><head><title>Canada Gazette, Part II, Volume 160, Number 1: SI/2026-29</title><meta name="dcterms.issued" content="2026-06-08"></head><body><h1>SI/2026-29</h1></body></html>';
  const extra = parseGazetteExtraEdition(html, key, 'https://gazette.gc.ca/rp-pr/p2/2026/2026-06-08-x1/html/si-tr29-eng.html');
  const frKey = { ...key, language: 'fr' };
  const frHtml = '<html lang="fr"><head><title>La Gazette du Canada, Partie II, volume 160, numéro 1 : TR/2026-29</title><meta name="dcterms.issued" content="2026-06-08"></head><body><h1>TR/2026-29</h1></body></html>';
  const frExtra = parseGazetteExtraEdition(frHtml, frKey, 'https://gazette.gc.ca/rp-pr/p2/2026/2026-06-08-x1/html/si-tr29-fra.html');
  const regularKey = { part: 'II', language: 'en', issueDate: '2026-06-08', volume: 160, issueNumber: 1 };
  importGazetteEdition(db, { ...regularKey, records: [{ ...regularKey,
    id: gazetteRecordId(regularKey, 'sor-1'), kind: 'instrument', title: 'Regular issue record',
    citationUrl: 'https://gazette.gc.ca/rp-pr/p2/2026/2026-06-08/html/sor-dors1-eng.html' }] });
  const imported = importGazetteExtraEditionBatch(db, [extra]);
  const rows = db.prepare('SELECT edition_type,issue_date,volume,extra_number,id FROM gazette_extra_records').all();
  const regularRows = db.prepare('SELECT issue_date,volume,issue_number,id FROM gazette_records').all();
  db.close();
  console.log(JSON.stringify({ extra, frExtra, imported, rows, regularRows, extraEditionId: gazetteExtraIssueId(key), extraRecordId: gazetteExtraRecordId(key, 'si-29') }));
`;

function run(): Record<string, unknown> {
  const result = spawnSync(process.env['CIVICSIGNAL_BUN_BINARY'] ?? 'bun', ['--eval', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(result.stderr.trim() || 'Gazette extra check returned no JSON.');
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

describe('Gazette extra edition identity and materialization', () => {
  it('uses an official bilingual masthead only when both date and extra identity match', () => {
    const key = { part: 'I', language: 'en', issueDate: '2026-04-03', volume: 160, extraNumber: 4 } as const;
    const text = 'EXTRA Vol. 160, No. 4 ÉDITION SPÉCIALE Vol. 160, no 4 Canada Gazette Part I Gazette du Canada Partie I OTTAWA Friday, April 3, 2026 OTTAWA LE vendredi 3 avril 2026';
    expect(validateGazetteExtraPdfText(text, key)).toMatchObject({ englishDate: 'April 3, 2026', frenchDate: '3 avril 2026' });
    expect(() => validateGazetteExtraPdfText(text.replace('Friday, April 3', 'Friday, April 6'), key)).toThrow(/does not confirm/u);
    expect(() => validateGazetteExtraPdfText(text.replace('No. 4', 'No. 5'), key)).toThrow(/does not confirm/u);
  });

  it('keeps an extra distinct from a regular issue with the same part, language, date and volume', () => {
    const result = run();
    const key = { part: 'II', language: 'en', issueDate: '2026-06-08', volume: 160, extraNumber: 1 };
    const extraId = result['extraEditionId'] as string;
    const recordId = result['extraRecordId'] as string;
    expect(extraId).toBe('gazette:extra:pii:en:2026-06-08:v160:x1');
    expect(recordId).toBe(`${extraId}:si-29`);
    expect(result['rows']).toMatchObject([{ edition_type: 'extra', issue_date: key.issueDate, volume: key.volume, extra_number: 1, id: recordId }]);
    expect(result['regularRows']).toMatchObject([{ issue_date: key.issueDate, volume: key.volume, issue_number: 1 }]);
  });

  it('retains separate English and French official registration forms under a shared extra identity', () => {
    const result = run() as { extra: { records: Array<{ id: string; registrationNumber?: string; editionType: string; citationUrl: string }> };
      frExtra: { records: Array<{ registrationNumber?: string; citationUrl: string }> } };
    expect(result.extra.records[0]).toMatchObject({ editionType: 'extra', registrationNumber: 'SI/2026-29',
      citationUrl: 'https://gazette.gc.ca/rp-pr/p2/2026/2026-06-08-x1/html/si-tr29-eng.html' });
    expect(result.frExtra.records[0]).toMatchObject({ registrationNumber: 'TR/2026-29',
      citationUrl: 'https://gazette.gc.ca/rp-pr/p2/2026/2026-06-08-x1/html/si-tr29-fra.html' });
  });
});
