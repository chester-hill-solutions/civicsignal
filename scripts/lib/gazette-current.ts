import type { GazetteIssueKey } from '../../src/corpora/gazette';

const ORIGIN = 'https://gazette.gc.ca';
const MAX_BYTES = 2 * 1024 * 1024;
const PUBLISHED_PATH = /^\/rp-pr\/p([12])\/(\d{4})\/(\d{4}-\d{2}-\d{2})\/html\/index-(eng|fra)\.html$/u;

type ListingIssue = GazetteIssueKey;
type ListingExtra = { part: GazetteIssueKey['part']; issueDate: string; volume: number; extraNumber: number; language: GazetteIssueKey['language']; htmlUrl: string; label: string; pdfUrl?: string };
type DiscoveredExtra = { part: GazetteIssueKey['part']; issueDate: string; volume: number; extraNumber: number;
  languages: Partial<Record<GazetteIssueKey['language'], { htmlUrl: string; label: string; pdfUrl?: string }>>; identityMismatch?: boolean };

export interface AnnualListingCoverage {
  regularRows: Array<{ date: string; text: string }>;
  extraRows: Array<{ date: string; text: string; extraNumber?: number; volume?: number; htmlUrl?: string; pdfUrl?: string }>;
  unsupportedExtraRows: Array<{ date: string; text: string }>;
}
export interface AnnualListingParseOptions {
  language: GazetteIssueKey['language'];
  cutoff: string;
  coverage?: AnnualListingCoverage;
}

export interface GazettedYearDiscovery {
  year: number;
  cutoff: string;
  issues: Array<{ issueDate: string; volume: number; issueNumber: number; part: GazetteIssueKey['part']; languages: Partial<Record<GazetteIssueKey['language'], ListingIssue>>; identityMismatch?: boolean }>;
  extraIssues: DiscoveredExtra[];
  annualListings: Array<{
    part: GazetteIssueKey['part'];
    language: GazetteIssueKey['language'];
    url: string;
    sha256?: string;
    bytes?: number;
    regularRows?: number;
    recognizedIssues?: number;
    unsupportedRows?: Array<{ date: string; text: string }>;
    extraRows?: Array<{ date: string; text: string; extraNumber?: number; volume?: number; htmlUrl?: string; pdfUrl?: string }>;
    unsupportedExtraRows?: Array<{ date: string; text: string }>;
    error?: string;
  }>;
}

function boundedYear(year: number): void {
  if (!Number.isInteger(year) || year < 1990 || year > 2200) throw new Error('Invalid Gazette listing year.');
}

export function gazetteAnnualIndexUrl(year: number, part: GazetteIssueKey['part'], language: GazetteIssueKey['language']): URL {
  boundedYear(year);
  return new URL(`/rp-pr/p${part === 'I' ? '1' : '2'}/${year}/index-${language === 'en' ? 'eng' : 'fra'}.html`, ORIGIN);
}

function languageCode(language: GazetteIssueKey['language']): string { return language === 'en' ? 'eng' : 'fra'; }

type AnnualRow = { date: string; text: string; links: { href: string; label: string }[] };
type AnnualParserContext = { year: number; part: GazetteIssueKey['part']; language: GazetteIssueKey['language']; cutoff: string;
  coverage?: AnnualListingCoverage; candidates: ListingIssue[] };
function processAnnualRow(current: AnnualRow, context: AnnualParserContext): void {
  const { year, part, language, cutoff, coverage, candidates } = context;
  if (!current.date || current.date.slice(0, 4) !== String(year) || current.date > cutoff) return;
  const isRegular = language === 'en' ? /regular\s+edition/iu.test(current.text) : /édition\s+régulière/iu.test(current.text);
  if (isRegular) {
    coverage?.regularRows.push({ date: current.date, text: current.text.replace(/\s+/gu, ' ').trim() });
    candidates.push(...parseRegularRowLinks(current, year, part, language));
    return;
  }
  const isExtra = language === 'en' ? /\bextra(?:\s+edition)?\b/iu.test(current.text) : /édition\s+(?:extra|spéciale)/iu.test(current.text);
  if (isExtra) parseExtraRow(current, context);
}

function parseRegularRowLinks(row: AnnualRow, year: number, part: GazetteIssueKey['part'],
  language: GazetteIssueKey['language']): ListingIssue[] {
  const output: ListingIssue[] = [];
  for (const link of row.links) {
    let url: URL;
    try { url = new URL(link.href, gazetteAnnualIndexUrl(year, part, language)); } catch { continue; }
    const match = PUBLISHED_PATH.exec(url.pathname);
    if (!match || Number(match[1]) !== (part === 'I' ? 1 : 2) || Number(match[2]) !== year || match[3] !== row.date || match[4] !== languageCode(language)) continue;
    const titlePattern = language === 'en'
      ? new RegExp(`^Part\\s+${part},\\s*volume\\s+(\\d+),\\s*number\\s+(\\d+)(?:\\s+\\(\\d+(?:[.,]\\d+)?\\s*(?:KB|MB)\\))?$`, 'iu')
      : new RegExp(`^Partie\\s+${part},\\s*volume\\s+(\\d+),\\s*numéro\\s+(\\d+)(?:\\s+\\(\\d+(?:[.,]\\d+)?\\s*(?:Ko|Mo)\\))?$`, 'iu');
    const title = link.label.replace(/\s+/gu, ' ').trim().replace(/&nbsp;/giu, ' ');
    const parsed = titlePattern.exec(title);
    if (!parsed) throw new Error(`Unrecognized regular Gazette issue label: ${title}`);
    output.push({ part, language, issueDate: row.date, volume: Number(parsed[1]), issueNumber: Number(parsed[2]) });
  }
  return output;
}

function parseExtraRow(row: AnnualRow, context: AnnualParserContext): void {
  const { coverage } = context;
  const summary = row.text.replace(/\s+/gu, ' ').trim();
  const found = row.links.flatMap((link) => {
    const extra = parseListedExtraLink(link, row.links, row, context);
    return extra ? [extra] : [];
  });
  if (found.length !== 1) coverage?.unsupportedExtraRows.push({ date: row.date,
    text: `${summary} (expected one language-matched HTML link, found ${found.length})` });
  for (const extra of found) coverage?.extraRows.push({ date: extra.issueDate, text: summary,
    extraNumber: extra.extraNumber, volume: extra.volume, htmlUrl: extra.htmlUrl, ...(extra.pdfUrl ? { pdfUrl: extra.pdfUrl } : {}) });
}

function parseListedExtraLink(link: { href: string; label: string }, allLinks: Array<{ href: string; label: string }>,
  row: AnnualRow, context: AnnualParserContext): ListingExtra | undefined {
  const { year, part, language } = context;
  const date = row.date;
  let url: URL;
  try { url = new URL(link.href, gazetteAnnualIndexUrl(year, part, language)); } catch { return undefined; }
  const path = /^\/rp-pr\/p([12])\/(\d{4})\/(\d{4}-\d{2}-\d{2})-x([1-9]\d*)\/html\/([a-z0-9][a-z0-9-]*-(eng|fra)\.html)$/iu.exec(url.pathname);
  if (!path || Number(path[1]) !== (part === 'I' ? 1 : 2) || Number(path[2]) !== year || path[3] !== date || path[6] !== languageCode(language)) return undefined;
  const label = link.label.replace(/&nbsp;/giu, ' ').replace(/\s+/gu, ' ').trim();
  const numberLabel = language === 'en' ? /\bextra\s+number\s*([1-9]\d*)\b/iu.exec(label) : /édition\s+spéciale\s+numéro\s*([1-9]\d*)/iu.exec(label);
  const volumeLabel = /\bvolume\s+(\d+)\b/iu.exec(label);
  if (!numberLabel || !volumeLabel || Number(numberLabel[1]) !== Number(path[4])) return undefined;
  const pdfUrl = findListedExtraPdf(allLinks, { date, year, volume: Number(volumeLabel[1]), extraNumber: Number(path[4]), part, language });
  return { part, language, issueDate: date, volume: Number(volumeLabel[1]), extraNumber: Number(path[4]),
    htmlUrl: url.href, label, ...(pdfUrl ? { pdfUrl } : {}) };
}

function findListedExtraPdf(links: Array<{ href: string; label: string }>, key: { date: string; year: number; volume: number;
  extraNumber: number; part: GazetteIssueKey['part']; language: GazetteIssueKey['language'] }): string | undefined {
  const { date, year, volume, extraNumber, part, language } = key;
  const listingUrl = gazetteAnnualIndexUrl(year, part, language);
  const pdfPath = `/rp-pr/p${part === 'I' ? '1' : '2'}/${year}/${date}-x${extraNumber}/pdf/g${part === 'I' ? '1' : '2'}-${volume}x${extraNumber}.pdf`;
  for (const link of links) {
    try {
      const url = new URL(link.href, listingUrl);
      if (url.origin === ORIGIN && url.pathname === pdfPath && !url.search && !url.hash) return url.href;
    } catch { /* Ignore links that cannot be resolved against the official annual index. */ }
  }
  return undefined;
}

/** Parse only regular editions from the publisher's annual listing; dates come from its data-order field. */
export function parseGazetteAnnualListing(html: string, year: number, part: GazetteIssueKey['part'], options: AnnualListingParseOptions): ListingIssue[] {
  const { language, cutoff, coverage } = options;
  boundedYear(year);
  const parser = new HTMLRewriter() as HTMLRewriter & { transform(input: string): string };
  let documentLanguage = '';
  let documentTitle = '';
  let h1 = '';
  let row: { date: string; text: string; links: { href: string; label: string }[] } | undefined;
  let activeLink: { href: string; label: string } | undefined;
  const candidates: ListingIssue[] = [];
  parser.on('html', { element(node) { documentLanguage = node.getAttribute('lang') ?? ''; } });
  parser.on('head title', { text(chunk) { documentTitle += chunk.text; } });
  parser.on('h1', { text(chunk) { h1 += chunk.text; } });
  parser.on('tr', {
    element(node) {
      const previous = row;
      const current = { date: '', text: '', links: [] as { href: string; label: string }[] };
      row = current;
      node.onEndTag(() => {
        row = previous;
        processAnnualRow(current, { year, part, language, cutoff, coverage, candidates });
      });
    },
    text(chunk) { if (row) row.text += chunk.text; },
  });
  parser.on('td[data-order]', { element(node) { if (row) row.date = node.getAttribute('data-order') ?? ''; } });
  parser.on('a[href]', {
    element(node) {
      if (!row) return;
      const href = node.getAttribute('href') ?? '';
      const previous = activeLink;
      const link = { href, label: '' };
      activeLink = link;
      const currentRow = row;
      node.onEndTag(() => { currentRow.links.push(link); activeLink = previous; });
    },
    text(chunk) { if (activeLink) activeLink.label += chunk.text; },
  });
  parser.transform(html);
  const text = `${documentTitle} ${h1}`.toLocaleLowerCase(language === 'fr' ? 'fr-CA' : 'en-CA');
  const expectedLang = language === 'fr' ? /^fr(?:-|$)/iu : /^en(?:-|$)/iu;
  if (!expectedLang.test(documentLanguage) || !/gazette/u.test(text) || !text.includes(part === 'I' ? (language === 'fr' ? 'partie i' : 'part i') : (language === 'fr' ? 'partie ii' : 'part ii'))) {
    throw new Error(`Gazette annual listing metadata mismatch (year=${year}, part=${part}, language=${language}).`);
  }
  const unique = new Map(candidates.map((key) => [`${key.issueDate}:${key.volume}:${key.issueNumber}`, key]));
  return [...unique.values()].sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.issueNumber - a.issueNumber);
}

async function fetchHtmlSource(url: URL, send: typeof fetch): Promise<{ html: string; bytes: Uint8Array }> {
  const response = await send(url, { headers: { Accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const media = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!response.ok || media !== 'text/html' || !response.body) {
    await response.body?.cancel();
    throw new Error(`Unexpected Gazette listing response at ${url.href} (HTTP ${response.status}, ${media ?? 'missing content type'}).`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error(`Gazette listing exceeded byte limit: ${url.href}`);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return { html: new TextDecoder('utf-8').decode(body), bytes: body };
}

async function fetchHtml(url: URL, send: typeof fetch): Promise<string> {
  return (await fetchHtmlSource(url, send)).html;
}

function dateAtToronto(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Resolve the latest shared regular issue for each part from current and prior annual listings. */
export async function discoverCurrentGazetteIssues(cutoff = dateAtToronto(), send: typeof fetch = fetch): Promise<GazetteIssueKey[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(cutoff) || Number.isNaN(Date.parse(`${cutoff}T00:00:00Z`))) throw new Error('Invalid Gazette cutoff date.');
  const year = Number(cutoff.slice(0, 4));
  const byPart = new Map<GazetteIssueKey['part'], Map<string, ListingIssue[]>>();
  for (const part of ['I', 'II'] as const) {
    const languages = new Map<string, ListingIssue[]>();
    for (const language of ['en', 'fr'] as const) {
      const issues: ListingIssue[] = [];
      for (const listingYear of [year, year - 1]) {
        const html = await fetchHtml(gazetteAnnualIndexUrl(listingYear, part, language), send);
        issues.push(...parseGazetteAnnualListing(html, listingYear, part, { language, cutoff }));
      }
      languages.set(language, issues.sort((a, b) => b.issueDate.localeCompare(a.issueDate)));
    }
    byPart.set(part, languages);
  }
  const selected: GazetteIssueKey[] = [];
  for (const part of ['I', 'II'] as const) {
    const languages = byPart.get(part);
    const en = languages?.get('en') ?? [];
    const fr = languages?.get('fr') ?? [];
    const latest = en[0];
    const latestFrench = fr[0];
    if (!latest) throw new Error(`No published regular Part ${part} issue found by ${cutoff}.`);
    if (!latestFrench) throw new Error(`No published French regular Part ${part} issue found by ${cutoff}.`);
    if (latest.issueDate !== latestFrench.issueDate || latest.volume !== latestFrench.volume || latest.issueNumber !== latestFrench.issueNumber) {
      throw new Error(`Latest Part ${part} issue mismatch (en=${latest.issueDate} v${latest.volume} n${latest.issueNumber}; fr=${latestFrench.issueDate} v${latestFrench.volume} n${latestFrench.issueNumber}).`);
    }
    selected.push(latest, latestFrench);
  }
  return selected;
}

/** Discover every regular issue listed for one calendar year through an explicit cutoff. */
export async function discoverGazetteYearThrough(year: number, cutoff: string, send: typeof fetch = fetch): Promise<GazettedYearDiscovery> {
  boundedYear(year);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(cutoff) || cutoff.slice(0, 4) !== String(year) ||
      Number.isNaN(Date.parse(`${cutoff}T00:00:00Z`))) {
    throw new Error('Gazette year backfill cutoff must be a valid date in the requested year.');
  }
  const discovered = new Map<string, GazettedYearDiscovery['issues'][number]>();
  const discoveredExtras = new Map<string, DiscoveredExtra>();
  const annualListings: GazettedYearDiscovery['annualListings'] = [];
  for (const part of ['I', 'II'] as const) {
    for (const language of ['en', 'fr'] as const) {
      const listing = await discoverAnnualListing(year, cutoff, part, language, send);
      annualListings.push(listing.summary);
      addDiscoveredIssues(discovered, listing.issues, part, language);
      addDiscoveredExtras(discoveredExtras, listing.extras, part, language);
    }
  }
  return { year, cutoff, issues: [...discovered.values()].sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.part.localeCompare(b.part) || a.issueNumber - b.issueNumber),
    extraIssues: [...discoveredExtras.values()].sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.part.localeCompare(b.part) || a.extraNumber - b.extraNumber), annualListings };
}

async function discoverAnnualListing(year: number, cutoff: string, part: GazetteIssueKey['part'],
  language: GazetteIssueKey['language'], send: typeof fetch): Promise<{
    summary: GazettedYearDiscovery['annualListings'][number]; issues: ListingIssue[]; extras: ListingExtra[];
  }> {
  const url = gazetteAnnualIndexUrl(year, part, language);
  try {
    const { html, bytes } = await fetchHtmlSource(url, send);
    const coverage: AnnualListingCoverage = { regularRows: [], extraRows: [], unsupportedExtraRows: [] };
    const issues = parseGazetteAnnualListing(html, year, part, { language, cutoff, coverage });
    const unsupportedRows = findUnsupportedListingRows(issues, coverage.regularRows);
    const extras: ListingExtra[] = coverage.extraRows.filter((row): row is typeof row & { extraNumber: number; volume: number; htmlUrl: string } =>
      row.extraNumber !== undefined && row.volume !== undefined && row.htmlUrl !== undefined).map((row) => ({
      part, language, issueDate: row.date, extraNumber: row.extraNumber, volume: row.volume, htmlUrl: row.htmlUrl,
      label: row.text, ...(row.pdfUrl ? { pdfUrl: row.pdfUrl } : {}),
    }));
    const emptyIssueList = coverage.regularRows.length === 0;
    return { issues, extras, summary: { part, language, url: url.href, bytes: bytes.byteLength, sha256: await sha256(bytes),
      regularRows: coverage.regularRows.length, recognizedIssues: issues.length, unsupportedRows, extraRows: coverage.extraRows,
      unsupportedExtraRows: coverage.unsupportedExtraRows,
      ...(emptyIssueList ? { error: `No regular editions are listed for Part ${part} ${language} through ${cutoff}.` } : {}) } };
  } catch (error) {
    return { issues: [], extras: [], summary: { part, language, url: url.href, error: error instanceof Error ? error.message : String(error) } };
  }
}

function findUnsupportedListingRows(issues: ListingIssue[], regularRows: AnnualListingCoverage['regularRows']) {
  const recognizedByDate = new Map<string, number>();
  for (const issue of issues) recognizedByDate.set(issue.issueDate, (recognizedByDate.get(issue.issueDate) ?? 0) + 1);
  const unsupportedRows = regularRows.filter((row) => {
    const remaining = recognizedByDate.get(row.date) ?? 0;
    if (remaining <= 0) return true;
    recognizedByDate.set(row.date, remaining - 1);
    return false;
  });
  for (const [issueDate, remaining] of recognizedByDate) {
    if (remaining > 0) unsupportedRows.push({ date: issueDate, text: `Annual listing parsed ${remaining} issue link(s) with no matching regular row.` });
  }
  return unsupportedRows;
}

function addDiscoveredIssues(discovered: Map<string, GazettedYearDiscovery['issues'][number]>, issues: ListingIssue[],
  part: GazetteIssueKey['part'], language: GazetteIssueKey['language']): void {
  for (const issue of issues) {
    const identity = `${part}:${issue.issueDate}`;
    const item = discovered.get(identity) ?? { issueDate: issue.issueDate, volume: issue.volume,
      issueNumber: issue.issueNumber, part, languages: {} };
    if (item.volume !== issue.volume || item.issueNumber !== issue.issueNumber) item.identityMismatch = true;
    item.languages[language] = issue;
    discovered.set(identity, item);
  }
}

function addDiscoveredExtras(discovered: Map<string, DiscoveredExtra>, extras: ListingExtra[],
  part: GazetteIssueKey['part'], language: GazetteIssueKey['language']): void {
  for (const extra of extras) {
    const identity = `${part}:${extra.issueDate}:x${extra.extraNumber}`;
    const item = discovered.get(identity) ?? { issueDate: extra.issueDate, volume: extra.volume,
      extraNumber: extra.extraNumber, part, languages: {} };
    if (item.volume !== extra.volume) item.identityMismatch = true;
    item.languages[language] = { htmlUrl: extra.htmlUrl, label: extra.label, ...(extra.pdfUrl ? { pdfUrl: extra.pdfUrl } : {}) };
    discovered.set(identity, item);
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
