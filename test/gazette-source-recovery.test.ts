import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = `
  import { fetchGazetteIssue } from './scripts/lib/gazette-source.ts';
  import { parseGazetteAnnualListing } from './scripts/lib/gazette-current.ts';
  const input = JSON.parse(await Bun.stdin.text());
  try {
    if (input.action === 'annual') {
      const coverage = { regularRows: [], extraRows: [], unsupportedExtraRows: [] };
      parseGazetteAnnualListing(input.html, 2026, input.part, { language: input.language, cutoff: '2026-12-31', coverage });
      console.log(JSON.stringify(coverage));
    } else {
      const key = { part: 'II', language: 'en', issueDate: '2026-06-03', volume: 160, issueNumber: 11 };
      const send = async (url) => {
        if (url.pathname.endsWith('/index-eng.html')) return new Response(input.index, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        if (url.pathname.endsWith('/index-fra.html')) return new Response(input.frIndex, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        const number = /sor-dors(\\d+)-eng\\.html/u.exec(url.pathname)?.[1];
        const article = number ? input.articles[number] : undefined;
        return new Response(article ?? '', { status: article ? 200 : 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      };
      const edition = await fetchGazetteIssue(key, send, true);
      console.log(JSON.stringify({ edition }));
    }
  } catch (error) { console.log(JSON.stringify({ error: error.message })); }
`;

function run(payload: unknown): Record<string, unknown> {
  const result = spawnSync(process.env['CIVICSIGNAL_BUN_BINARY'] ?? 'bun', ['--eval', script], {
    cwd: process.cwd(), input: JSON.stringify(payload), encoding: 'utf8', timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(result.stderr.trim() || 'Gazette source check returned no JSON.');
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

const numbers = [82, 83, 84, 85, 86, 87, 88];
function issueIndex() {
  const records = numbers.map((number) => `<li><a href="/rp-pr/p2/2026/2026-06-03/html/sor-dors${number}-fra.html">English label ${number}</a><br>SOR/2026-${number}<br>13/05/26</li>`).join('');
  return `<html lang="en"><head><title>Canada Gazette, Part II, Volume 160, Number 11: Index</title></head><body><h1>Canada Gazette, Part II, Volume 160, Number 11: Index</h1><p>June 3, 2026</p><h2>SOR: Statutory Instruments (Regulations)</h2><ul>${records}</ul></body></html>`;
}

function frenchIssueIndex() {
  const records = numbers.map((number) => `<li><a href="/rp-pr/p2/2026/2026-06-03/html/sor-dors${number}-fra.html">Avis français ${number}</a><br>DORS/2026-${number}<br>13/05/26</li>`).join('');
  return `<html lang="fr"><head><title>La Gazette du Canada, Partie II, volume 160, numéro 11 : Index</title></head><body><h1>La Gazette du Canada, Partie II, volume 160, numéro 11 : Index</h1><p>Le 3 juin 2026</p><h2>DORS : Textes réglementaires (Règlements)</h2><ul>${records}</ul></body></html>`;
}

function frenchIssueIndexWithout(numberToOmit: number) {
  const records = numbers.filter((number) => number !== numberToOmit).map((number) => `<li><a href="/rp-pr/p2/2026/2026-06-03/html/sor-dors${number}-fra.html">Avis français ${number}</a><br>DORS/2026-${number}<br>13/05/26</li>`).join('');
  return `<html lang="fr"><head><title>La Gazette du Canada, Partie II, volume 160, numéro 11 : Index</title></head><body><h1>La Gazette du Canada, Partie II, volume 160, numéro 11 : Index</h1><p>Le 3 juin 2026</p><h2>DORS : Textes réglementaires (Règlements)</h2><ul>${records}</ul></body></html>`;
}

function articles(badNumber?: number) {
  return Object.fromEntries(numbers.map((number) => [number, `<html lang="${badNumber === number ? 'fr' : 'en'}"><head><meta name="dcterms.issued" content="2026-06-03"><title>Canada Gazette, Part II, Volume 160, Number 11: SOR/2026-${number}</title></head><body><h1>SOR/2026-${number}</h1><p>Canada Gazette, Part II, Volume 160, Number 11</p></body></html>`]));
}

describe('Gazette recovery for the June 3, 2026 English index', () => {
  it('replaces only the seven publisher-mismatched French targets after validating each official English article', () => {
    const result = run({ index: issueIndex(), frIndex: frenchIssueIndex(), articles: articles(), url: 'https://gazette.gc.ca/rp-pr/p2/2026/2026-06-03/html/index-eng.html' });
    expect(result.error).toBeUndefined();
    const edition = result['edition'] as { records: Array<{ id: string; citationUrl: string }> };
    expect(edition.records).toHaveLength(7);
    expect(edition.records.map((record) => record.id.split(':').at(-1)).sort()).toEqual(numbers.map((number) => `sor-${number}`).sort());
    expect(edition.records.every((record) => record.citationUrl.endsWith('-eng.html'))).toBe(true);
  });

  it('fails closed when any recovered article is not the English matching instrument', () => {
    const result = run({ index: issueIndex(), frIndex: frenchIssueIndex(), articles: articles(86), url: 'https://gazette.gc.ca/rp-pr/p2/2026/2026-06-03/html/index-eng.html' });
    expect(result.error).toMatch(/failed English issue\/registration validation/u);
  });

  it('fails closed when the French partner index does not contain all recovered instrument IDs', () => {
    const result = run({ index: issueIndex(), frIndex: frenchIssueIndexWithout(88), articles: articles(), url: 'https://gazette.gc.ca/rp-pr/p2/2026/2026-06-03/html/index-eng.html' });
    expect(result.error).toMatch(/do not match the French partner issue records/u);
  });

  it('counts English Extra and French Édition spéciale rows separately from regular issues', () => {
    const rows = `<tr><td data-order="2026-06-08">June&nbsp;8,&nbsp;2026</td><td>Extra</td><td><abbr title="not applicable">n/a</abbr></td><td>SI/2026-29</td><td><a href="/rp-pr/p2/2026/2026-06-08-x1/html/si-tr29-eng.html">Part&nbsp;II, volume&nbsp;160, Extra number&nbsp;1</a></td><td><a href="/rp-pr/p2/2026/2026-06-08-x1/pdf/g2-160x1.pdf">Part II, volume 160, Extra number 1 (12KB)</a></td></tr><tr><td data-order="2026-06-03">June&nbsp;3,&nbsp;2026</td><td>Regular edition</td><td>SOR/2026-82 to 88</td><td>n/a</td><td><a href="/rp-pr/p2/2026/2026-06-03/html/index-eng.html">Part&nbsp;II, volume&nbsp;160, number&nbsp;11</a></td><td>PDF</td></tr>`;
    const en = `<html lang="en"><head><title>Canada Gazette, Part II: Volume 160</title></head><body><h1>Canada Gazette, Part II: Volume 160</h1><table id="a01"><tbody>${rows}</tbody></table></body></html>`;
    const frRows = `<tr><td data-order="2026-06-08">8&nbsp;juin&nbsp;2026</td><td>Édition spéciale</td><td><abbr title="sans objet">s/o</abbr></td><td>TR/2026-29</td><td><a href="/rp-pr/p2/2026/2026-06-08-x1/html/si-tr29-fra.html">Partie&nbsp;II, volume&nbsp;160, édition spéciale numéro&nbsp;1</a></td><td><a href="/rp-pr/p2/2026/2026-06-08-x1/pdf/g2-160x1.pdf">Partie II, volume 160, numéro hors série 1 (12Ko)</a></td></tr>`;
    const fr = `<html lang="fr"><head><title>La Gazette du Canada, Partie II : volume 160</title></head><body><h1>La Gazette du Canada, Partie II : volume 160</h1><table id="a01"><tbody>${frRows}</tbody></table></body></html>`;
    expect(run({ action: 'annual', html: en, part: 'II', language: 'en' })).toMatchObject({ extraRows: [{ date: '2026-06-08', extraNumber: 1, volume: 160,
      pdfUrl: 'https://gazette.gc.ca/rp-pr/p2/2026/2026-06-08-x1/pdf/g2-160x1.pdf' }], regularRows: [{ date: '2026-06-03' }], unsupportedExtraRows: [] });
    expect(run({ action: 'annual', html: fr, part: 'II', language: 'fr' })).toMatchObject({ extraRows: [{ date: '2026-06-08', extraNumber: 1, volume: 160,
      pdfUrl: 'https://gazette.gc.ca/rp-pr/p2/2026/2026-06-08-x1/pdf/g2-160x1.pdf' }], regularRows: [], unsupportedExtraRows: [] });
  });
});
