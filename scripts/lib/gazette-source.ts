import type { GazetteEdition, GazetteIssueKey, GazetteRecord } from '../../src/corpora/gazette';
import { GazetteIssueSchema, gazetteRecordId, isGazetteIssueSupported } from '../../src/corpora/gazette';

const GAZETTE = 'https://gazette.gc.ca';
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_ARTICLE_BYTES = 2 * 1024 * 1024;
// These first-party English article pages were directly checked for their
// published language, issue identity, date, and registration number after the
// June 3, 2026 English index linked its English labels to French pages.
const VERIFIED_ENGLISH_ARTICLES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  [82, 83, 84, 85, 86, 87, 88].map((number) => [
    `sor-${number}`, `/rp-pr/p2/2026/2026-06-03/html/sor-dors${number}-eng.html`,
  ]),
));
function assertSupportedIssue(key: GazetteIssueKey, allowDynamic = false): void {
  GazetteIssueSchema.parse({ part: key.part, language: key.language, issueDate: key.issueDate,
    volume: key.volume, issueNumber: key.issueNumber });
  if (!allowDynamic && !isGazetteIssueSupported(key)) throw new Error('Gazette source is bounded to the configured April 2026 issues.');
}

export function gazetteIssueUrl(key: GazetteIssueKey, allowDynamic = false): URL {
  assertSupportedIssue(key, allowDynamic);
  const language = key.language === 'en' ? 'eng' : 'fra';
  return new URL(`/rp-pr/p${key.part === 'I' ? '1' : '2'}/${key.issueDate.slice(0, 4)}/${key.issueDate}/html/index-${language}.html`, GAZETTE);
}

function normalizedText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (raw, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : raw;
    }
    const named: Record<string, string> = {
      amp: '&', apos: "'", gt: '>', lt: '<', quot: '"', nbsp: ' ', mdash: '—', ndash: '–',
      lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
      eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', ccedil: 'ç',
      icirc: 'î', iuml: 'ï', ocirc: 'ô', ugrave: 'ù', ucirc: 'û', uuml: 'ü', oelig: 'œ',
    };
    return named[entity.toLowerCase()] ?? raw;
  }).replace(/\s+/gu, ' ').trim();
}

function matchesPublishedDate(value: string, key: GazetteIssueKey): boolean {
  const locale = key.language === 'fr' ? 'fr-CA' : 'en-CA';
  const [year, month, day] = key.issueDate.split('-').map(Number);
  if (!year || !month || !day) return false;
  const expected = new Intl.DateTimeFormat(locale, {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day))).toLocaleLowerCase(locale);
  let actual = normalizedText(value).toLocaleLowerCase(locale).replace(/^le\s+/u, '');
  if (key.language === 'fr') actual = actual.replace(/^(\d{1,2})er\s/u, '$1 ');
  return actual === normalizedText(expected);
}

function parseIssueHeading(value: string, key: GazetteIssueKey): boolean {
  const text = normalizedText(value);
  if (key.language === 'en') {
    const pattern = key.part === 'I'
      ? /^Canada Gazette, Part I, Volume (\d+), Number (\d+):\s*Index$/u
      : /^Canada Gazette, Part II, Volume (\d+), Number (\d+):\s*Index$/u;
    const match = pattern.exec(text);
    return !!match && Number(match[1]) === key.volume && Number(match[2]) === key.issueNumber;
  }
  const part = key.part === 'I' ? '(?:I|1)' : '(?:II|2)';
  const pattern = new RegExp(`^La Gazette du Canada, Partie ${part}, volume (\\d+), numéro (\\d+)\\s*:\\s*Index$`, 'iu');
  const match = pattern.exec(text);
  return !!match && Number(match[1]) === key.volume && Number(match[2]) === key.issueNumber;
}

function citationPath(href: string, key: GazetteIssueKey, base: URL): URL | undefined {
  let url: URL;
  try { url = new URL(href, base); } catch { return undefined; }
  if (url.origin !== GAZETTE || url.search) return undefined;
  const prefix = `/rp-pr/p${key.part === 'I' ? '1' : '2'}/${key.issueDate.slice(0, 4)}/${key.issueDate}/html/`;
  if (!url.pathname.startsWith(prefix) || /\/index-(?:eng|fra)\.html$/u.test(url.pathname)) return undefined;
  const file = url.pathname.slice(prefix.length);
  if (!/^[a-z0-9][a-z0-9-]*-(?:eng|fra)\.html$/iu.test(file) ||
      !file.endsWith(`-${key.language === 'en' ? 'eng' : 'fra'}.html`) ||
      (key.part === 'I' ? !url.hash && !/^reg\d+-(?:eng|fra)\.html$/iu.test(file) : !!url.hash)) return undefined;
  return url;
}

function sourceToken(url: URL): string {
  const file = (url.pathname.split('/').pop() ?? '').replace(/-(?:eng|fra)(?=\.html$)/u, '').replace(/\.html$/u, '');
  const registration = /^(?:sor|si)-dors?(\d+)$|^(?:sor|si)-(\d+)-/iu.exec(file);
  return registration
    ? `sor-${registration[1] ?? registration[2]}`
    : `${file}${url.hash ? `-${url.hash.slice(1)}` : ''}`;
}

function recoveredEnglishArticle(key: GazetteIssueKey, token: string): URL | undefined {
  if (key.part !== 'II' || key.language !== 'en' || key.issueDate !== '2026-06-03' ||
      key.volume !== 160 || key.issueNumber !== 11) return undefined;
  const path = VERIFIED_ENGLISH_ARTICLES[token];
  return path ? new URL(path, GAZETTE) : undefined;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new Error('Gazette article response had no body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('Gazette article response exceeded its byte limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8').decode(bytes);
}

async function validateRecoveredEnglishArticle(url: URL, expected: GazetteIssueKey, token: string,
  send: typeof fetch): Promise<void> {
  const response = await send(url, {
    headers: { Accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(15_000),
  });
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!response.ok || contentType !== 'text/html') {
    await response.body?.cancel();
    throw new Error(`Unexpected recovered Gazette article response (HTTP ${response.status}, ${contentType || 'missing content type'}).`);
  }
  const html = await readBoundedText(response, MAX_ARTICLE_BYTES);
  let language = '';
  let title = '';
  let issueHeading = '';
  let issued = '';
  const rewriter = new HTMLRewriter() as HTMLRewriter & { transform(input: string): string };
  rewriter.on('html', { element(node) { language = node.getAttribute('lang') ?? ''; } });
  rewriter.on('head title', { text(chunk) { title += chunk.text; } });
  rewriter.on('h1', { text(chunk) { title += ` ${chunk.text}`; } });
  rewriter.on('p', { text(chunk) { issueHeading += ` ${chunk.text}`; } });
  rewriter.on('meta[name="dcterms.issued"]', { element(node) { issued = node.getAttribute('content') ?? ''; } });
  rewriter.transform(html);
  const number = token.slice('sor-'.length);
  const registrationNumber = new RegExp(`\\bSOR\\s*\\/\\s*2026\\s*-\\s*${number}\\b`, 'iu');
  if (!/^en(?:-|$)/iu.test(language) || !registrationNumber.test(title) ||
      !issueHeading.toLocaleLowerCase('en-CA').includes('canada gazette, part ii, volume 160, number 11') ||
      issued !== expected.issueDate) {
    throw new Error(`Recovered Gazette article failed English issue/registration validation (${url.href}; lang=${language || 'missing'}, date=${issued || 'missing'}).`);
  }
}

function partTwoMetadata(text: string) {
  const registrationNumber = /\b(SOR|SI|DORS|TR)\s*\/\s*(?:2026|\d{4})\s*-\s*\d+\b/iu.exec(text)?.[0]?.replace(/\s+/gu, '').toUpperCase();
  const date = /\b(\d{2})\/(\d{2})\/(\d{2}|\d{4})\b/u.exec(text);
  const registrationYear = date?.[3];
  const registrationDate = date && registrationYear
    ? `${registrationYear.length === 2 ? `20${registrationYear}` : registrationYear}-${date[2]}-${date[1]}`
    : undefined;
  return { ...(registrationNumber ? { registrationNumber } : {}), ...(registrationDate ? { registrationDate } : {}) };
}

/** Parse only the published issue index; linked notice and instrument bodies are never fetched. */
export async function parseGazetteIssue(html: string, expected: GazetteIssueKey, allowDynamic = false): Promise<GazetteEdition> {
  assertSupportedIssue(expected, allowDynamic);
  const expectedUrl = gazetteIssueUrl(expected, allowDynamic);
  let language = '';
  let title = '';
  let h1 = '';
  let dateText = '';
  let dateCapturePending = false;
  let collectingDate = false;
  let activeTitle = '';
  let activeHref = '';
  let activeTitleHasBreak = false;
  let currentSection = '';
  let activeHeading = '';
  let activeListItem: { afterAnchor: boolean; metadataText: string } | undefined;
  const links: { href: string; title: string; section: string; listItem?: { afterAnchor: boolean; metadataText: string } }[] = [];

  const rewriter = new HTMLRewriter() as HTMLRewriter & { transform(input: string): string };
  rewriter
    .on('html', { element(node) { language = node.getAttribute('lang') ?? ''; } })
    .on('head title', { text(chunk) { title += chunk.text; } })
    .on('h1', {
      element(node) { node.onEndTag(() => { dateCapturePending = true; }); },
      text(chunk) { h1 += chunk.text; },
    })
    .on('p', {
      element(node) {
        if (!dateCapturePending) return;
        dateCapturePending = false;
        collectingDate = true;
        node.onEndTag(() => { collectingDate = false; });
      },
      text(chunk) { if (collectingDate) dateText += chunk.text; },
    })
    .on('h2', {
      element(node) {
        activeHeading = '';
        node.onEndTag(() => { currentSection = normalizedText(activeHeading); });
      },
      text(chunk) { activeHeading += chunk.text; },
    })
    .on('li', {
      element(node) {
        const previous = activeListItem;
        const item = { afterAnchor: false, metadataText: '' };
        activeListItem = item;
        node.onEndTag(() => { activeListItem = previous; });
      },
      text(chunk) { if (activeListItem?.afterAnchor) activeListItem.metadataText += ` ${chunk.text} `; },
    })
    .on('a[href]', {
      element(node) {
        activeTitle = '';
        activeTitleHasBreak = false;
        activeHref = node.getAttribute('href') ?? '';
        const citation = citationPath(activeHref, expected, expectedUrl);
        if (citation) node.onEndTag(() => {
          const recordTitle = normalizedText(activeTitle);
          if (recordTitle) {
            links.push({ href: citation.href, title: recordTitle, section: currentSection, listItem: activeListItem });
            if (expected.part === 'II' && activeListItem) activeListItem.afterAnchor = true;
          }
        });
      },
      text(chunk) { if (activeHref && !activeTitleHasBreak) activeTitle += chunk.text; },
    });
  rewriter.on('a[href] br', { element() { if (activeHref) activeTitleHasBreak = true; } });
  rewriter.transform(html);

  const visibleHeading = normalizedText(h1 || title.replace(/\s*[-–|].*$/u, ''));
  const issueHeading = [title, h1].some((value) => parseIssueHeading(normalizedText(value), expected));
  if ((language && !language.toLowerCase().startsWith(expected.language)) || !issueHeading ||
      !matchesPublishedDate(dateText, expected) || !visibleHeading) {
    throw new Error(`Gazette index metadata mismatch (lang=${language || 'missing'}, heading=${normalizedText(h1)}, date=${normalizedText(dateText)}).`);
  }

  const seen = new Set<string>();
  const records: GazetteRecord[] = [];
  for (const link of links) {
    const url = new URL(link.href);
    const token = sourceToken(url);
    const id = gazetteRecordId(expected, token);
    if (seen.has(id)) continue;
    seen.add(id);
    const isProposal = expected.part === 'I' && /^(?:proposed regulations|règlements projetés)$/iu.test(link.section);
    const kind = expected.part === 'II' ? 'instrument' : isProposal ? 'proposal' : 'notice';
    records.push({
      ...expected,
      id,
      kind,
      title: link.title,
      citationUrl: url.href,
      ...(expected.part === 'II' ? partTwoMetadata(link.listItem?.metadataText ?? '') : {}),
    });
  }
  if (!records.length) throw new Error(`Gazette issue index contained no recognized records (${links.length} candidate links).`);
  return { ...expected, records };
}

/** Fetch and parse a single configured official issue index, with an optional fetch mock for replay. */
export async function fetchGazetteIssue(expected: GazetteIssueKey, send: typeof fetch = fetch, allowDynamic = false): Promise<GazetteEdition> {
  const url = gazetteIssueUrl(expected, allowDynamic);
  const response = await send(url, {
    headers: { Accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(15_000),
  });
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!response.ok || contentType !== 'text/html' || !response.body) {
    await response.body?.cancel();
    throw new Error(`Unexpected Gazette response (HTTP ${response.status}, ${contentType || 'missing content type'}).`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_INDEX_BYTES) throw new Error('Gazette index response exceeded its byte limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!total) throw new Error('Gazette index response was empty.');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  // The Gazette declares UTF-8 but a small number of legacy typography bytes
  // are not valid UTF-8; replacement decoding preserves the surrounding index.
  let html = new TextDecoder('utf-8').decode(bytes);
  let recoveredCount = 0;
  if (expected.part === 'II' && expected.language === 'en' && expected.issueDate === '2026-06-03' &&
      expected.volume === 160 && expected.issueNumber === 11) {
    const observed = new Set<string>();
    const hrefPattern = /\bhref\s*=\s*(["'])([^"']+)\1/giu;
    for (const match of html.matchAll(hrefPattern)) {
      const href = match[2];
      if (!href) continue;
      const observedUrl = new URL(href, url);
      if (!observedUrl.pathname.endsWith('-fra.html')) continue;
      const token = sourceToken(observedUrl);
      const canonical = recoveredEnglishArticle(expected, token);
      if (!canonical || observed.has(token)) continue;
      await validateRecoveredEnglishArticle(canonical, expected, token, send);
      observed.add(token);
      recoveredCount += 1;
      html = html.replace(match[0], match[0].replace(href, canonical.pathname));
    }
    const missing = Object.keys(VERIFIED_ENGLISH_ARTICLES).filter((token) => !observed.has(token));
    if (missing.length) throw new Error(`Gazette English issue index did not expose all seven recoverable SOR links: ${missing.join(', ')}.`);
  }
  const edition = await parseGazetteIssue(html, expected, allowDynamic);
  if (recoveredCount) {
    const partner = await fetchGazetteIssue({ ...expected, language: 'fr' }, send, allowDynamic);
    const englishIds = edition.records.map((record) => record.id).sort();
    const frenchIds = partner.records.map((record) => record.id.replace(':fr:', ':en:')).sort();
    if (JSON.stringify(englishIds) !== JSON.stringify(frenchIds)) {
      throw new Error('Recovered English Gazette articles do not match the French partner issue records.');
    }
  }
  return edition;
}
