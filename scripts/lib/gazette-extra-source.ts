import { gazetteExtraRecordId, isGazetteExtraCitationForIssue, type GazetteExtraEdition, type GazetteExtraIssueKey } from '../../src/corpora/gazette-extra';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ORIGIN = 'https://gazette.gc.ca';
const MAX_BYTES = 2 * 1024 * 1024;
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

export interface GazetteExtraPdfEvidence {
  url: string; sha256: string; bytes: number; issueDate: string; volume: number; extraNumber: number;
  part: 'I' | 'II'; englishDate: string; frenchDate: string; validation: 'publisher-bilingual-masthead';
}

function textValue(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (raw, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : raw;
    }
    const values: Record<string, string> = { nbsp: ' ', amp: '&', apos: "'", quot: '"', eacute: 'é', egrave: 'è',
      ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', ccedil: 'ç', oelig: 'œ', rsquo: '’', mdash: '—', ndash: '–' };
    return values[entity.toLowerCase()] ?? raw;
  }).replace(/\s+/gu, ' ').trim();
}

function issueHeading(title: string, key: GazetteExtraIssueKey): boolean {
  const escapedPart = key.part === 'I' ? '(?:I|1)' : '(?:II|2)';
  const pattern = key.language === 'en'
    ? new RegExp(`^Canada Gazette, Part ${escapedPart}, Volume ${key.volume}, Number ${key.extraNumber}(?:\\s|:|$)`, 'iu')
    : new RegExp(`^La Gazette du Canada, Partie ${escapedPart}, volume ${key.volume}, numéro ${key.extraNumber}(?:\\s|:|$)`, 'iu');
  return pattern.test(title);
}

function registration(title: string, key: GazetteExtraIssueKey): { number?: string; token?: string; title: string } {
  if (key.part !== 'II') return { title };
  const match = /\b(SOR|SI|DORS|TR)\s*\/\s*(\d{4})\s*-\s*(\d+)\b/iu.exec(title);
  if (!match || match[2] !== key.issueDate.slice(0, 4)) throw new Error('Gazette Part II extra lacks a registration number for its issue year.');
  const prefix = match[1]?.toUpperCase();
  const suffix = match[3];
  if (!prefix || !suffix) throw new Error('Gazette extra registration identity is incomplete.');
  const number = `${prefix}/${match[2]}-${suffix}`;
  const token = `${prefix === 'SI' || prefix === 'TR' ? 'si' : 'sor'}-${suffix}`;
  return { number, token, title: title.replace(new RegExp(`\\s*[:：]?\\s*${prefix}\\s*\\/\\s*${match[2]}\\s*-\\s*${suffix}\\s*$`, 'iu'), '').trim() };
}

function isVerifiedPdfEvidence(citationUrl: string, expected: GazetteExtraIssueKey,
  evidence?: GazetteExtraPdfEvidence): boolean {
  if (!evidence) return false;
  try {
    const url = new URL(evidence.url);
    return url.origin === ORIGIN && url.pathname ===
      `/rp-pr/p${expected.part === 'I' ? '1' : '2'}/${expected.issueDate.slice(0, 4)}/${expected.issueDate}-x${expected.extraNumber}/pdf/g${expected.part === 'I' ? '1' : '2'}-${expected.volume}x${expected.extraNumber}.pdf` &&
      evidence.part === expected.part && evidence.issueDate === expected.issueDate && evidence.volume === expected.volume &&
      evidence.extraNumber === expected.extraNumber && evidence.validation === 'publisher-bilingual-masthead' &&
      /^[a-f0-9]{64}$/u.test(evidence.sha256) && evidence.bytes > 0 && !!citationUrl;
  } catch { return false; }
}

export function parseGazetteExtraEdition(html: string, expected: GazetteExtraIssueKey, citationUrl: string,
  pdfEvidence?: GazetteExtraPdfEvidence): GazetteExtraEdition {
  const metadata = readExtraPageMetadata(html);
  const url = validateExtraPageMetadata(metadata, expected, citationUrl, pdfEvidence);
  const parsed = registration(metadata.visible, expected);
  const title = expected.part === 'I' ? metadata.visible : (parsed.title || metadata.pageTitle);
  if (!title) throw new Error('Gazette extra page has an empty title.');
  const record = { ...expected, editionType: 'extra' as const,
    id: gazetteExtraRecordId(expected, parsed.token ?? 'extra-issue'),
    kind: expected.part === 'II' ? 'instrument' as const : 'notice' as const,
    title, citationUrl: url.href, ...(parsed.number ? { registrationNumber: parsed.number } : {}) };
  return { ...expected, records: [record] };
}

function readExtraPageMetadata(html: string) {
  let language = '';
  let title = '';
  let heading = '';
  let issued = '';
  const rewriter = new HTMLRewriter() as HTMLRewriter & { transform(input: string): string };
  rewriter.on('html', { element(node) { language = node.getAttribute('lang') ?? ''; } });
  rewriter.on('head title', { text(chunk) { title += chunk.text; } });
  rewriter.on('h1', { text(chunk) { heading += chunk.text; } });
  rewriter.on('meta[name="dcterms.issued"]', { element(node) { issued = node.getAttribute('content') ?? ''; } });
  rewriter.transform(html);
  return { language, pageTitle: textValue(title), visible: textValue(heading), issued };
}

function validateExtraPageMetadata(metadata: ReturnType<typeof readExtraPageMetadata>, expected: GazetteExtraIssueKey,
  citationUrl: string, pdfEvidence?: GazetteExtraPdfEvidence): URL {
  const expectedLanguage = expected.language === 'en' ? /^en(?:-|$)/iu : /^fr(?:-|$)/iu;
  const url = new URL(citationUrl);
  const headingMatches = issueHeading(metadata.pageTitle, expected) || issueHeading(metadata.visible, expected);
  if (!expectedLanguage.test(metadata.language) || (metadata.issued !== expected.issueDate &&
      !isVerifiedPdfEvidence(citationUrl, expected, pdfEvidence)) || !headingMatches ||
      !isGazetteExtraCitationForIssue(citationUrl, expected) || url.origin !== ORIGIN) {
    throw new Error(`Gazette extra page metadata mismatch (lang=${metadata.language || 'missing'}, date=${metadata.issued || 'missing'}, title=${metadata.pageTitle}).`);
  }
  if (expected.part === 'I' && !isPartOneExtra(metadata.pageTitle, citationUrl, expected)) {
    throw new Error('Gazette Part I page does not identify itself as an extra edition.');
  }
  return url;
}

function isPartOneExtra(pageTitle: string, citationUrl: string, expected: GazetteExtraIssueKey): boolean {
  const visibleLabel = expected.language === 'en' ? /\bextra\b/iu.test(pageTitle) : /édition spéciale/iu.test(pageTitle);
  return visibleLabel || isGazetteExtraCitationForIssue(citationUrl, expected);
}

async function readBounded(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Gazette extra response exceeded its byte limit.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function normalizedPdfText(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').replace(/\s+/gu, ' ').toLocaleLowerCase('en-CA');
}

export function validateGazetteExtraPdfText(text: string, key: GazetteExtraIssueKey): { englishDate: string; frenchDate: string } {
  const normalized = normalizedPdfText(text);
  const [year, month, day] = key.issueDate.split('-').map(Number);
  const englishDate = `${MONTHS_EN[(month ?? 1) - 1]} ${day}, ${year}`;
  const frenchDate = `${day} ${MONTHS_FR[(month ?? 1) - 1]} ${year}`;
  const englishPart = key.part === 'I' ? ['part i', 'part 1'] : ['part ii', 'part 2'];
  const frenchPart = key.part === 'I' ? ['partie i', 'partie 1'] : ['partie ii', 'partie 2'];
  const englishMasthead = new RegExp(`extra\\s+vol\\.?\\s*${key.volume}\\s*,\\s*no\\.?\\s*${key.extraNumber}`, 'iu');
  const frenchMasthead = new RegExp(`edition speciale\\s+vol\\.?\\s*${key.volume}\\s*,\\s*no\\s*${key.extraNumber}`, 'iu');
  if (!normalized.includes('canada gazette') || !normalized.includes('gazette du canada') ||
      !englishPart.some((part) => normalized.includes(part)) || !frenchPart.some((part) => normalized.includes(part)) ||
      !englishMasthead.test(normalized) || !frenchMasthead.test(normalized) ||
      !normalized.includes(englishDate.toLocaleLowerCase('en-CA')) ||
      !normalized.includes(frenchDate.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-CA'))) {
    throw new Error('Official Gazette extra PDF does not confirm the bilingual issue date, part, volume and extra number.');
  }
  return { englishDate, frenchDate };
}

export function inspectGazetteExtraPdf(bytes: Uint8Array, key: GazetteExtraIssueKey, pdfUrl: string): GazetteExtraPdfEvidence {
  const url = new URL(pdfUrl);
  const expectedPath = `/rp-pr/p${key.part === 'I' ? '1' : '2'}/${key.issueDate.slice(0, 4)}/${key.issueDate}-x${key.extraNumber}/pdf/g${key.part === 'I' ? '1' : '2'}-${key.volume}x${key.extraNumber}.pdf`;
  if (url.origin !== ORIGIN || url.pathname !== expectedPath || url.search || url.hash || bytes.byteLength > MAX_BYTES) {
    throw new Error('Gazette extra PDF was not the exact publisher-listed issue file or exceeded the byte limit.');
  }
  const text = execFileSync('pdftotext', ['-f', '1', '-l', '1', '-layout', '-', '-'], {
    input: Buffer.from(bytes), encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  const dates = validateGazetteExtraPdfText(text, key);
  return { url: url.href, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength,
    ...key, ...dates, validation: 'publisher-bilingual-masthead' };
}

async function fetchPdfEvidence(key: GazetteExtraIssueKey, pdfUrl: string, send: typeof fetch): Promise<GazetteExtraPdfEvidence> {
  const url = new URL(pdfUrl);
  const expectedPath = `/rp-pr/p${key.part === 'I' ? '1' : '2'}/${key.issueDate.slice(0, 4)}/${key.issueDate}-x${key.extraNumber}/pdf/g${key.part === 'I' ? '1' : '2'}-${key.volume}x${key.extraNumber}.pdf`;
  if (url.origin !== ORIGIN || url.pathname !== expectedPath || url.search || url.hash) throw new Error('Gazette extra PDF was not the exact publisher-listed issue file.');
  const response = await send(url, { headers: { Accept: 'application/pdf' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const media = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!response.ok || media !== 'application/pdf' || !response.body) {
    await response.body?.cancel();
    throw new Error(`Unexpected Gazette extra PDF response (HTTP ${response.status}, ${media ?? 'missing content type'}).`);
  }
  const bytes = await readBounded(response.body);
  return inspectGazetteExtraPdf(bytes, key, url.href);
}

/** Fetch the publisher-listed extra HTML page and use its annual-listed PDF only to resolve a conflicting issue date. */
export async function fetchGazetteExtraEdition(expected: GazetteExtraIssueKey, officialListingUrl: string,
  send: typeof fetch = fetch, officialPdfUrl?: string): Promise<{ edition: GazetteExtraEdition; htmlIssuedAt: string; pdfEvidence?: GazetteExtraPdfEvidence }> {
  const url = validateExtraHtmlUrl(officialListingUrl, expected);
  const html = await fetchExtraHtml(url, send);
  const issued = issuedDateFromHtml(html);
  if (issued === expected.issueDate) return { edition: parseGazetteExtraEdition(html, expected, url.href), htmlIssuedAt: issued };
  const pdfEvidence = await resolveExtraDateConflict(expected, issued, officialPdfUrl, send);
  return { edition: parseGazetteExtraEdition(html, expected, url.href, pdfEvidence), htmlIssuedAt: issued, pdfEvidence };
}

function validateExtraHtmlUrl(rawUrl: string, expected: GazetteExtraIssueKey): URL {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('Gazette extra listing URL is invalid.'); }
  const code = expected.language === 'en' ? 'eng' : 'fra';
  const prefix = `/rp-pr/p${expected.part === 'I' ? '1' : '2'}/${expected.issueDate.slice(0, 4)}/${expected.issueDate}-x${expected.extraNumber}/html/`;
  if (url.origin !== ORIGIN || url.search || !url.pathname.startsWith(prefix) || !url.pathname.endsWith(`-${code}.html`) ||
      /\/index-(?:eng|fra)\.html$/u.test(url.pathname)) throw new Error('Gazette extra URL is not the publisher-listed issue/language target.');
  return url;
}

async function fetchExtraHtml(url: URL, send: typeof fetch): Promise<string> {
  const response = await send(url, { headers: { Accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const media = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!response.ok || media !== 'text/html' || !response.body) {
    await response.body?.cancel();
    throw new Error(`Unexpected Gazette extra response (HTTP ${response.status}, ${media ?? 'missing content type'}).`);
  }
  const bytes = await readBounded(response.body);
  if (!bytes.length) throw new Error('Gazette extra response was empty.');
  return new TextDecoder('utf-8').decode(bytes);
}

function issuedDateFromHtml(html: string): string {
  let issued = '';
  const metadata = new HTMLRewriter() as HTMLRewriter & { transform(input: string): string };
  metadata.on('meta[name="dcterms.issued"]', { element(node) { issued = node.getAttribute('content') ?? ''; } });
  metadata.transform(html);
  return issued;
}

async function resolveExtraDateConflict(expected: GazetteExtraIssueKey, issued: string,
  officialPdfUrl: string | undefined, send: typeof fetch): Promise<GazetteExtraPdfEvidence> {
  if (!officialPdfUrl) throw new Error(`Gazette extra HTML date ${issued || 'missing'} disagrees with annual listing date ${expected.issueDate}; no official issue PDF link is listed.`);
  return fetchPdfEvidence(expected, officialPdfUrl, send);
}
