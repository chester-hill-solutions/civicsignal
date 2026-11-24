import type { HansardLanguage } from '../../src/corpora/hansard';
import { HANSARD_SENATE } from '../../src/corpora/policies';
import { parseHansardSittingDate } from '../../src/ingest/hansard';
import { normalizeForSearch } from '../../src/text';

export interface SenateEditionRef {
  sittingId: string;
  sittingDate: string;
  edition: HansardLanguage;
}

const sittingId = /^([1-9][0-9]*)-([1-9][0-9]*)-([1-9][0-9]*)$/u;
const transcriptRoot = '#content-viewer-document';
const entities: Record<string, string> = {
  amp: '&', apos: "'", gt: '>', lt: '<', quot: '"', nbsp: '\u00a0',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
};

function renderText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (raw, key: string) => {
    if (key.startsWith('#')) {
      const hex = key[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)) return String.fromCodePoint(code);
      return raw;
    }
    return Object.hasOwn(entities, key) ? entities[key]! : raw;
  }).replace(/\s+/gu, ' ').trim();
}

export function senateEditionUrl(ref: SenateEditionRef): URL {
  const id = sittingId.exec(ref.sittingId);
  if (!id || !/^\d{4}-\d{2}-\d{2}$/u.test(ref.sittingDate)) throw new Error('Invalid Senate sitting identity.');
  const issue = id[3]!.padStart(3, '0');
  const suffix = ref.edition === 'en' ? 'e' : 'f';
  return new URL(`https://sencanada.ca/${ref.edition}/content/sen/chamber/${id[1]}${id[2]}/debates/${issue}db_${ref.sittingDate}-${suffix}`);
}

export function parseSenateHansard(html: string, expected: SenateEditionRef) {
  const citation = senateEditionUrl(expected);
  const sectionIds = new Set<string>();
  const speeches: { interventionId: string; language: HansardLanguage; speaker: string; excerpt: string; citationUrl: string }[] = [];
  let edition = '', title = '', sessionHeading = '', section = '', turn = 0;
  let paragraph: { full: string; label: string } | undefined;

  function finishParagraph() {
    const current = paragraph;
    paragraph = undefined;
    if (!section || !current) return;
    const label = renderText(current.label);
    const full = renderText(current.full);
    if (!label.endsWith(':') || !full.startsWith(label)) return;
    turn++;
    const speaker = label.slice(0, -1).trim();
    const excerpt = full.slice(label.length).trimStart().slice(0, HANSARD_SENATE.excerptMaxChars)
      .replace(/[\uD800-\uDBFF]$/u, '').trimEnd();
    if (!speaker || !excerpt) return;
    speeches.push({ interventionId: `${section}-${turn}`, language: expected.edition, speaker, excerpt,
      citationUrl: `${citation.href}#${section}` });
  }

  // Bun's synchronous string overload drives the streaming callbacks without
  // yielding inside the edition's SQLite transaction.
  const rewriter = new HTMLRewriter() as HTMLRewriter & { transform(input: string): string };
  rewriter
    .on('html', { element(node) { edition = node.getAttribute('lang') ?? ''; } })
    .on('head title', { text(chunk) { title += chunk.text; } })
    .on(`${transcriptRoot} #grey-box h2.georgia-18`, { text(chunk) { sessionHeading += chunk.text; } })
    .on(['h1', 'h2', 'h3'].map((tag) => `${transcriptRoot} ${tag}[id]`).join(', '), {
      element(node) {
        finishParagraph();
        const id = node.getAttribute('id') ?? '';
        if (!/^[0-9]+$/u.test(id) || sectionIds.has(id)) throw new Error('Invalid or duplicate Senate section anchor.');
        sectionIds.add(id);
        section = id;
        turn = 0;
      },
    })
    .on(`${transcriptRoot} p`, {
      element(node) {
        finishParagraph();
        paragraph = { full: '', label: '' };
        node.onEndTag(finishParagraph);
      },
      text(chunk) { if (paragraph) paragraph.full += chunk.text; },
    })
    .on(`${transcriptRoot} p > b:first-child, ${transcriptRoot} p > strong:first-child`, {
      text(chunk) { if (paragraph) paragraph.label += chunk.text; },
    });
  rewriter.transform(html);

  const issue = /(?:Issue|No\.)\s+([0-9]+)\s+\(([^)]+)\)$/u.exec(renderText(title));
  const header = normalizeForSearch(renderText(sessionHeading));
  const session = expected.edition === 'en'
    ? /^(\d+)[a-z]* session,\s*(\d+)[a-z]* parliament/u.exec(header)
    : /^(\d+)[a-z]* session,\s*(\d+)[a-z]* legislature/u.exec(header);
  if (edition !== expected.edition || !issue || !session ||
      `${session[2]}-${session[1]}-${Number(issue[1])}` !== expected.sittingId ||
      parseHansardSittingDate(issue[2]!, expected.edition) !== expected.sittingDate) {
    throw new Error('Senate transcript metadata does not match the requested sitting and edition.');
  }
  if (!speeches.length) throw new Error('No attributed Senate interventions found.');
  return { edition: expected.edition, sitting: { sittingId: expected.sittingId, sittingDate: expected.sittingDate, speeches } };
}
