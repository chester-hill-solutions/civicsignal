import type { GazetteIssueKey } from '../../src/corpora/gazette';

const ORIGIN = 'https://gazette.gc.ca';
const MAX_BYTES = 2 * 1024 * 1024;
const PUBLISHED_PATH = /^\/rp-pr\/p([12])\/(\d{4})\/(\d{4}-\d{2}-\d{2})\/html\/index-(eng|fra)\.html$/u;

type ListingIssue = GazetteIssueKey;

export interface AnnualListingCoverage {
  regularRows: Array<{ date: string; text: string }>;
  extraRows: Array<{ date: string; text: string }>;
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
  annualListings: Array<{
    part: GazetteIssueKey['part'];
    language: GazetteIssueKey['language'];
    url: string;
    sha256?: string;
    bytes?: number;
    regularRows?: number;
    recognizedIssues?: number;
    unsupportedRows?: Array<{ date: string; text: string }>;
    extraRows?: Array<{ date: string; text: string }>;
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
        if (!current.date || current.date.slice(0, 4) !== String(year) || current.date > cutoff) return;
        const isRegular = language === 'en' ? /regular\s+edition/iu.test(current.text) : /édition\s+régulière/iu.test(current.text);
        if (!isRegular) {
          const isExtra = language === 'en'
            ? /\bextra(?:\s+edition)?\b/iu.test(current.text)
            : /édition\s+(?:extra|spéciale)/iu.test(current.text);
          if (isExtra) coverage?.extraRows.push({ date: current.date, text: current.text.replace(/\s+/gu, ' ').trim() });
          return;
        }
        coverage?.regularRows.push({ date: current.date, text: current.text.replace(/\s+/gu, ' ').trim() });
        for (const link of current.links) {
          let url: URL;
          try { url = new URL(link.href, gazetteAnnualIndexUrl(year, part, language)); } catch { continue; }
          const match = PUBLISHED_PATH.exec(url.pathname);
          if (!match || Number(match[1]) !== (part === 'I' ? 1 : 2) || Number(match[2]) !== year || match[3] !== current.date || match[4] !== languageCode(language)) continue;
          const titlePattern = language === 'en'
            ? new RegExp(`^Part\\s+${part},\\s*volume\\s+(\\d+),\\s*number\\s+(\\d+)(?:\\s+\\(\\d+(?:[.,]\\d+)?\\s*(?:KB|MB)\\))?$`, 'iu')
            : new RegExp(`^Partie\\s+${part},\\s*volume\\s+(\\d+),\\s*numéro\\s+(\\d+)(?:\\s+\\(\\d+(?:[.,]\\d+)?\\s*(?:Ko|Mo)\\))?$`, 'iu');
          const title = link.label.replace(/\s+/gu, ' ').trim().replace(/&nbsp;/giu, ' ');
          const titleMatch = titlePattern.exec(title);
          if (!titleMatch) throw new Error(`Unrecognized regular Gazette issue label: ${title}`);
          candidates.push({ part, language, issueDate: current.date, volume: Number(titleMatch[1]), issueNumber: Number(titleMatch[2]) });
        }
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
  const annualListings: GazettedYearDiscovery['annualListings'] = [];
  for (const part of ['I', 'II'] as const) {
    for (const language of ['en', 'fr'] as const) {
      const listing = await discoverAnnualListing(year, cutoff, part, language, send);
      annualListings.push(listing.summary);
      addDiscoveredIssues(discovered, listing.issues, part, language);
    }
  }
  return { year, cutoff, issues: [...discovered.values()].sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.part.localeCompare(b.part) || a.issueNumber - b.issueNumber), annualListings };
}

async function discoverAnnualListing(year: number, cutoff: string, part: GazetteIssueKey['part'],
  language: GazetteIssueKey['language'], send: typeof fetch): Promise<{
    summary: GazettedYearDiscovery['annualListings'][number]; issues: ListingIssue[];
  }> {
  const url = gazetteAnnualIndexUrl(year, part, language);
  try {
    const { html, bytes } = await fetchHtmlSource(url, send);
    const coverage: AnnualListingCoverage = { regularRows: [], extraRows: [] };
    const issues = parseGazetteAnnualListing(html, year, part, { language, cutoff, coverage });
    const unsupportedRows = findUnsupportedListingRows(issues, coverage.regularRows);
    const emptyIssueList = coverage.regularRows.length === 0;
    return { issues, summary: { part, language, url: url.href, bytes: bytes.byteLength, sha256: await sha256(bytes),
      regularRows: coverage.regularRows.length, recognizedIssues: issues.length, unsupportedRows, extraRows: coverage.extraRows,
      ...(emptyIssueList ? { error: `No regular editions are listed for Part ${part} ${language} through ${cutoff}.` } : {}) } };
  } catch (error) {
    return { issues: [], summary: { part, language, url: url.href, error: error instanceof Error ? error.message : String(error) } };
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

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
