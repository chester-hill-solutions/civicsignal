import { XMLParser } from 'fast-xml-parser';

/**
 * Parsing the Justice Laws XML corpus into section rows.
 *
 * The corpus is `justicecanada/laws-lois-xml` — a git clone, no rate limits, no bot
 * wall, published under the Open Government Licence - Canada. That makes it the
 * cleanest and the most reproducible of the corpora, and the right first ingest.
 *
 * This module is pure: XML in, rows out. The CLI in `scripts/ingest-statutes.ts`
 * does the fetching and the writing, so the parsing can be tested without a clone.
 *
 * The XML is machine-generated and regular, but it is not a document format — the
 * structure is walked defensively, and anything unrecognised is skipped rather than
 * guessed at.
 */

export interface StatuteSectionRow {
  id: string;
  corpus_id: 'statutes-canada';
  act: string;
  citation: string;
  section: string;
  heading: string | null;
  text: string;
  source_url: string;
  jurisdiction: 'CA';
  in_force: number;
  language: 'en' | 'fr';
  topics: string | null;
  search_text: string;
}

export interface ParsedStatute {
  shortTitle: string;
  citation: string;
  inForce: boolean;
  sections: {
    label: string;
    marginalNote: string | null;
    text: string;
  }[];
}

const LAWS_BASE = 'https://laws-lois.justice.gc.ca';

/**
 * The path segment for each corpus kind, per language.
 *
 * The English site uses `acts` and `regulations`; the French site uses `lois` and
 * `reglements`. Getting this wrong produces a 404 on every citation.
 */
const CORPUS_PATH: Record<'en' | 'fr', Record<'acts' | 'regulations', string>> = {
  en: { acts: 'acts', regulations: 'regulations' },
  fr: { acts: 'lois', regulations: 'reglements' },
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  // Text nodes are always materialised so that mixed content keeps its order: a
  // provision that reads "cited as the <XRefExternal>Act</XRefExternal>." is three
  // nodes, and without this the cross-reference is silently dropped from the text.
  alwaysCreateTextNode: true,
  isArray: (name) => name === 'Section' || name === 'Subsection' || name === 'Text',
});

/** Pull the text out of a node that may be a string, an object with #text, or an array. */
function textOf(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).filter(Boolean).join(' ').trim();
  if (typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if ('#text' in record) return textOf(record['#text']);
    if ('Text' in record) return textOf(record['Text']);
    // Mixed content: an element whose children are themselves elements, such as a
    // section text containing a cross-reference. The children's text is part of the
    // provision, so it is collected rather than dropped.
    return Object.entries(record)
      .filter(([key, value]) => !key.startsWith('@') && value !== undefined && value !== null)
      .map(([, value]) => textOf(value))
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  return '';
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export interface ParseOptions {
  /**
   * Overrides the citation read from the document. A regulation's citation is its
   * file stem ("SOR-2001-477"), which is not in the document in a usable form; a
   * statute's is the consolidated number ("A-1") and needs no override.
   */
  citation?: string;
}

/**
 * Parse one statute or regulation XML document.
 *
 * `citation` is the last path segment of the citation URL.
 */
export function parseStatuteXml(xml: string, options: ParseOptions = {}): ParsedStatute | null {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }
  const root = (doc as Record<string, unknown>)['Statute'] ?? (doc as Record<string, unknown>)['Regulation'];
  if (!root || typeof root !== 'object') return null;
  const statute = root as Record<string, unknown>;

  const identification = (statute['Identification'] ?? {}) as Record<string, unknown>;
  const chapter = (identification['Chapter'] ?? {}) as Record<string, unknown>;
  // An order carries only a LongTitle; an Act or regulation carries a ShortTitle.
  const shortTitle = textOf(identification['ShortTitle']) || textOf(identification['LongTitle']);
  const citation =
    options.citation ?? textOf(chapter['ConsolidatedNumber']) ?? textOf(identification['ConsolidatedNumber']);
  if (!shortTitle || !citation) return null;

  const inForce = statute['@in-force'] !== 'no';

  // The provision blocks are enumerated from the raw XML rather than the parsed tree.
  // Two reasons: a provision that reads "cited as the <XRefExternal>Act</XRefExternal>."
  // is mixed content, and the parser merges the child into the parent's text node —
  // which silently drops the cross-reference. And an instrument can be a list of
  // `<Section>` elements or a list of `<Provision>` elements (an order), sometimes
  // with a different title element. The raw scan handles both without special cases.
  const blocks = extractProvisionBlocks(xml);

  const sections: ParsedStatute['sections'] = [];
  for (const block of blocks) {
    const label = firstLabelOf(block);
    if (!label) continue;
    const marginalNote = marginalNoteOf(block);
    const text = provisionText(block);
    if (!text) continue;
    sections.push({ label, marginalNote, text });
  }

  return { shortTitle, citation, inForce, sections };
}

/**
 * Every provision block in the document, in document order.
 *
 * `<Section>` is a section of an Act or regulation; `<Provision>` is a numbered
 * provision of an order. Both carry a label and a body, and both are cited the same
 * way.
 */
function extractProvisionBlocks(xml: string): string[] {
  const blocks: string[] = [];
  const re = /<(Section|Provision)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    blocks.push(match[2] ?? '');
  }
  return blocks;
}

function firstLabelOf(block: string): string {
  const match = /<Label\b[^>]*>([\s\S]*?)<\/Label>/.exec(block);
  return match ? decodeEntities(match[1] ?? '').trim() : '';
}

function marginalNoteOf(block: string): string | null {
  const match = /<MarginalNote\b[^>]*>([\s\S]*?)<\/MarginalNote>/.exec(block);
  const value = match ? decodeEntities(match[1] ?? '').trim() : '';
  return value.length ? value : null;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&[a-z]+;/g, (entity) => ENTITIES[entity] ?? entity);
}

/**
 * The provision text of one section, flattened to plain text.
 *
 * Editorial history and the marginal note are not the law, and the section's own
 * label is carried in a separate column, so all three are removed. Subsection labels
 * are kept: "(1) ..." is how the provision reads.
 */
function provisionText(block: string): string {
  let text = block;
  text = text.replace(/<HistoricalNote\b[\s\S]*?<\/HistoricalNote>/g, ' ');
  text = text.replace(/<FootnoteRef\b[\s\S]*?<\/FootnoteRef>/g, ' ');
  text = text.replace(/<Footnote\b[\s\S]*?<\/Footnote>/g, ' ');
  text = text.replace(/<MarginalNote\b[\s\S]*?<\/MarginalNote>/g, ' ');
  // Remove the section's own label — the first one — and keep any subsection labels.
  text = text.replace(/<Label\b[^>]*>[\s\S]*?<\/Label>/, ' ');
  // A subsection label reads "(1) the text follows"; without the space it reads
  // "(1)the text follows". The space belongs after the label, not inside it.
  text = text.replace(/<\/Label>/g, '</Label> ');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  return text.replace(/\s+/g, ' ').trim();
}

export interface BuildRowsOptions {
  /** 'acts' or 'regulations' — decides the citation URL path. */
  kind: 'acts' | 'regulations';
  /** Language of the document. */
  language: 'en' | 'fr';
}

export function buildRows(
  parsed: ParsedStatute,
  options: BuildRowsOptions,
): StatuteSectionRow[] {
  const rows: StatuteSectionRow[] = [];
  const path = CORPUS_PATH[options.language][options.kind];
  // The French site percent-encodes the comma in a regulation's citation
  // ("C.R.C.%2C_ch._870"); the English site does not.
  const citation = options.language === 'fr' ? parsed.citation.replace(/,/g, '%2C') : parsed.citation;

  for (const section of parsed.sections) {
    const id = `${options.kind}-${options.language}-${parsed.citation}-${section.label}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
    // A numeric section has its own page. A lettered provision — the shape an order
    // takes — does not, so it cites the instrument's index page, which the Justice
    // Laws site publishes for every instrument.
    const sectionUrl =
      /^[0-9]+(\.[0-9]+)?$/.test(section.label)
        ? `${LAWS_BASE}/${options.language}/${path}/${citation}/section-${section.label}.html`
        : `${LAWS_BASE}/${options.language}/${path}/${citation}/index.html`;
    const sourceUrl = sectionUrl;
    const searchText = `${parsed.shortTitle} ${section.marginalNote ?? ''} ${section.text}`.toLowerCase();
    rows.push({
      id,
      corpus_id: 'statutes-canada',
      act: parsed.shortTitle,
      citation: parsed.citation,
      section: section.label,
      heading: section.marginalNote,
      text: section.text,
      source_url: sourceUrl,
      jurisdiction: 'CA',
      in_force: parsed.inForce ? 1 : 0,
      language: options.language,
      topics: null,
      search_text: searchText,
    });
  }
  return rows;
}

/** The SQL statements that load the rows into D1. */
export function toInsertStatements(rows: StatuteSectionRow[], batchSize = 200): string[] {
  const statements: string[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values = batch.map((r) => rowTuple(r)).join(',');
    statements.push(
      `INSERT OR REPLACE INTO statute_sections (id, corpus_id, act, citation, section, heading, text, source_url, jurisdiction, in_force, language, topics, search_text) VALUES ${values};`,
    );
  }
  return statements;
}

function quoted(value: string): string {
  return `'${sqlEscape(value)}'`;
}

function nullableQuoted(value: string | null): string {
  return value === null ? 'NULL' : quoted(value);
}

function rowTuple(r: StatuteSectionRow): string {
  return [
    quoted(r.id),
    quoted(r.corpus_id),
    quoted(r.act),
    quoted(r.citation),
    quoted(r.section),
    nullableQuoted(r.heading),
    quoted(r.text),
    quoted(r.source_url),
    quoted(r.jurisdiction),
    String(r.in_force),
    quoted(r.language),
    nullableQuoted(r.topics),
    quoted(r.search_text),
  ].join(',');
}

export function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}
