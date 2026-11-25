import type { GazetteIssueKey } from '../../src/corpora/gazette';

const ORIGIN = 'https://gazette.gc.ca';
const MAX_BYTES = 2 * 1024 * 1024;
const PUBLISHED_PATH = /^\/rp-pr\/p([12])\/(\d{4})\/(\d{4}-\d{2}-\d{2})\/html\/index-(eng|fra)\.html$/u;

type ListingIssue = GazetteIssueKey;

function boundedYear(year: number): void {
  if (!Number.isInteger(year) || year < 1990 || year > 2200) throw new Error('Invalid Gazette listing year.');
}

export function gazetteAnnualIndexUrl(year: number, part: GazetteIssueKey['part'], language: GazetteIssueKey['language']): URL {
  boundedYear(year);
  return new URL(`/rp-pr/p${part === 'I' ? '1' : '2'}/${year}/index-${language === 'en' ? 'eng' : 'fra'}.html`, ORIGIN);
}

function languageCode(language: GazetteIssueKey['language']): string { return language === 'en' ? 'eng' : 'fra'; }

/** Parse only regular editions from the publisher's annual listing; dates come from its data-order field. */
export function parseGazetteAnnualListing(html: string, year: number, part: GazetteIssueKey['part'], language: GazetteIssueKey['language'], cutoff: string): ListingIssue[] {
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
        if (!isRegular) return;
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

async function fetchHtml(url: URL, send: typeof fetch): Promise<string> {
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
  return new TextDecoder('utf-8').decode(body);
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
        issues.push(...parseGazetteAnnualListing(html, listingYear, part, language, cutoff));
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
