import { XMLParser } from 'fast-xml-parser';

/**
 * Parsing the Justice Laws XML corpus into citable units.
 *
 * The corpus is `justicecanada/laws-lois-xml` — a git clone, no rate limits, no bot
 * wall, published under the Open Government Licence - Canada. That makes it the
 * cleanest and the most reproducible of the corpora, and the right first ingest.
 *
 * This module is pure: XML in, units out. The CLI in `scripts/ingest-statutes.ts`
 * does the fetching and the writing, so the parsing can be tested without a clone.
 *
 * ## Structure comes from the tree; text comes from the raw XML
 *
 * Two passes, because the corpus needs both and neither parser does both well.
 *
 * The **tree** decides what a unit *is*. The corpus is machine-generated and deeply
 * regular, and its structure is the whole meaning of it:
 *
 * - `Body/Section` is a section — "section 210 of the Canada Labour Code". This is
 *   what people cite, and what the product indexes.
 * - `Order/Provision` is a provision of an *order*. An order has no numbered
 *   sections; its provisions are what it has.
 * - `Introduction/Preamble/Provision` is a preamble clause.
 * - everything under a `Schedule` is the schedule's *content*, not a section.
 * - `Schedule/BillPiece/RelatedOrNotInForce/Section` and its `RegulationPiece`
 *   sibling are **not law at all**: they are the amending bill's own sections,
 *   recorded so the site can say which provisions are not in force. Indexing them
 *   put a hundred copies of "s. 2" — the *bill's* section 2 — into the Act's
 *   section 2, and the collision was invisible.
 *
 * The **raw XML** decides what the text *is*. A provision that reads "cited as the
 * `<XRefExternal>`Act`</XRefExternal>`." is mixed content, and a DOM parser merges
 * the child into the parent's text node, silently dropping the cross-reference. So
 * the text is sliced out of the raw source by span, and only the *structure* is
 * taken from the tree.
 *
 * ## What a unit is
 *
 * The corpus uses three kinds of block, and treating them the same is the mistake
 * this module exists to avoid:
 *
 * - a **section** is a numbered section of an Act or regulation;
 * - a **provision** is a provision of an order, or a clause of a preamble;
 * - a **schedule** is a schedule, and its list items are not separately citable
 *   and do not have labels that mean anything outside it — a regulation can have
 *   hundreds of items labelled "(a)".
 *
 * Treating schedule items as sections produced a corpus where a fifth of the rows
 * were list items wearing a section's label, several thousand rows collided on
 * their id, and a citation like "s. (a)" resolved to nothing in particular.
 */

export type UnitKind = 'section' | 'provision' | 'schedule';

export interface ParsedUnit {
  /** The label as it is cited: "210", "SCHEDULE I", "1". */
  label: string;
  marginalNote: string | null;
  text: string;
  kind: UnitKind;
  /**
   * For a schedule: its items, kept separate so that a chunk boundary can fall
   * between two items rather than through the middle of one.
   */
  items?: { label: string; text: string }[];
  /** The Lims id, used to anchor a citation into the instrument's full-text page. */
  anchor: string | null;
}

export interface ParsedStatute {
  shortTitle: string;
  citation: string;
  inForce: boolean;
  units: ParsedUnit[];
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
    return Object.entries(record)
      .filter(([key, value]) => !key.startsWith('@') && value !== undefined && value !== null)
      .map(([, value]) => textOf(value))
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  return '';
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
  // The span scan already supplies every provision. Building a second DOM for
  // the entire instrument consumed >200 MB for the largest source file, though
  // only root attributes and Identification were ever read from that DOM.
  const spans = scanElements(xml);
  const rootSpan = spans.find((span) => span.path.length === 0 && (span.tag === 'Statute' || span.tag === 'Regulation'));
  if (!rootSpan) return null;
  const identificationSpan = childrenOf(spans, rootSpan).find((span) => span.tag === 'Identification');
  if (!identificationSpan) return null;
  const opening = xml.slice(rootSpan.openStart, rootSpan.openEnd);
  const rootTag = /^<([\w:.-]+)/.exec(opening)?.[1];
  if (!rootTag) return null;
  const header = opening + xml.slice(identificationSpan.openStart, identificationSpan.end) + `</${rootTag}>`;
  let doc: unknown;
  try {
    doc = parser.parse(header);
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

  const units: ParsedUnit[] = [];

  // Schedules first, so a provision inside one is claimed by the schedule.
  for (const span of spans) {
    if (span.tag !== 'Schedule') continue;
    // A schedule inside a schedule, or inside an amending bill or regulation
    // recorded in one, is not a schedule of this instrument.
    if (span.path.some((tag) => tag === 'Schedule' || tag === 'BillPiece' || tag === 'RegulationPiece')) {
      continue;
    }
    const unit = buildScheduleUnit(xml, span, spans);
    if (unit) units.push(unit);
  }

  let provisionOrdinal = 0;
  let enactingOrdinal = 0;
  for (const span of spans) {
    if (span.tag === 'Section') {
      if (!isLawSection(span)) continue;
      const label = directChildLabel(xml, span, spans);
      if (!label) continue;
      const text = unitText(xml, span, spans, { removeOwnLabel: true });
      if (!text) continue;
      units.push({
        label: label.text,
        marginalNote: marginalNoteOf(xml, span, spans),
        text,
        kind: 'section',
        anchor: limsIdOf(xml, span),
      });
      continue;
    }
    if (span.tag !== 'Provision') continue;
    if (!isLawProvision(span)) continue;
    provisionOrdinal++;
    const label = directChildLabel(xml, span, spans);
    const text = unitText(xml, span, spans, { removeOwnLabel: true });
    if (!text) continue;
    // A preamble's clauses are numbered "1", "2", "3" — the same labels the body
    // sections use. Prefixed, they cannot be confused with a section.
    const inPreamble = span.path[span.path.length - 1] === 'Preamble';
    const inEnacts = span.path[span.path.length - 1] === 'Enacts';
    if (inEnacts) enactingOrdinal++;
    units.push({
      label: inPreamble
        ? `Preamble ${label?.text ?? provisionOrdinal}`
        : inEnacts
          ? `Enacting clause ${label?.text ?? enactingOrdinal}`
          : (label?.text ?? String(provisionOrdinal)),
      marginalNote: marginalNoteOf(xml, span, spans),
      text,
      kind: 'provision',
      anchor: limsIdOf(xml, span),
    });
  }

  return { shortTitle, citation, inForce, units };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The tree scan
 * ──────────────────────────────────────────────────────────────────────────── */

/** One element occurrence in the source, with its ancestry and its span. */
interface Span {
  tag: string;
  /** The ancestors, outermost first, excluding this element. */
  path: string[];
  /** The offset just after this element's opening tag. */
  contentStart: number;
  /** The offset just after this element's closing tag. */
  end: number;
  /** The offsets of this element's own opening and closing tags. */
  openStart: number;
  openEnd: number;
}

/**
 * Walk the raw XML and record every element's span and ancestry.
 *
 * A hand-rolled scanner rather than a DOM walk, because the offsets matter: the
 * text of a provision is sliced out of the source between two offsets, and a DOM
 * has already thrown the mixed content away by the time it is consulted.
 */
function scanElements(xml: string): Span[] {
  const spans: Span[] = [];
  // Mixed-content text is sliced from the source; only structural/citation and
  // editorial-removal spans are needed. Keeping every Text/Paragraph/XRef span
  // and a full ancestry array for each exceeded the Worker's memory budget.
  const retained = new Set(['Statute', 'Regulation', 'Identification', 'Section', 'Provision', 'Schedule',
    'Label', 'MarginalNote', 'HistoricalNote', 'Footnote', 'FootnoteRef', 'ScheduleFormHeading', 'TitleText']);
  const stack: { tag: string; path?: string[]; openStart: number; openEnd: number }[] = [];
  const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(xml)) !== null) {
    const [full, closing, rawTag, , selfClosing] = match;
    const tag = rawTag.split(':').pop()!;
    const offset = match.index;

    if (closing === '/') {
      // Pop to the matching open tag.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.tag !== tag) continue;
        const open = stack[i]!;
        stack.length = i;
        if (open.path) {
          spans.push({ tag: open.tag, path: open.path, contentStart: open.openEnd,
            end: offset + full.length, openStart: open.openStart, openEnd: open.openEnd });
        }
        break;
      }
      continue;
    }
    if (selfClosing === '/') continue;

    // Every direct child is a schedule item, including shapes unknown to this
    // parser. Retain it so schedule text/chunk boundaries remain unchanged.
    const path = retained.has(tag) || stack.at(-1)?.tag === 'Schedule'
      ? stack.map((frame) => frame.tag) : undefined;
    stack.push({ tag, path, openStart: offset, openEnd: offset + full.length });
  }
  return spans;
}

/** True when the element sits directly inside the parent. */
function isDirectChildOf(child: Span, parent: Span): boolean {
  return child.path.length === parent.path.length + 1 && child.path[parent.path.length] === parent.tag;
}

/**
 * The elements directly inside the given element.
 *
 * The ancestry check alone is not enough: a path says what an element's ancestors
 * are, not which of them it is inside. Two sections both have the path
 * `Body/Section`, and the first one's label would be found for both. Containment
 * is what makes it the *direct child of this element*.
 */
function childrenOf(spans: Span[], parent: Span): Span[] {
  return spans.filter(
    (span) =>
      span.path.length === parent.path.length + 1 &&
      span.path[parent.path.length] === parent.tag &&
      isInside(span, parent),
  );
}

/**
 * A section of the law.
 *
 * It has to be in the body, and it must not be an amending bill's own section
 * recorded inside a schedule.
 */
function isLawSection(span: Span): boolean {
  if (!span.path.includes('Body')) return false;
  return !span.path.some((tag) => tag === 'BillPiece' || tag === 'RegulationPiece' || tag === 'RelatedOrNotInForce');
}

/**
 * A provision of an order, or a clause of a preamble.
 *
 * An order has no numbered sections, so its provisions are its citable units. A
 * preamble's clauses are the "whereas" clauses of an Act.
 */
function isLawProvision(span: Span): boolean {
  const parent = span.path[span.path.length - 1];
  if (parent === 'Order' || parent === 'Preamble' || parent === 'Enacts') return true;
  return false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Text extraction
 * ──────────────────────────────────────────────────────────────────────────── */

/** The element's own label, if it has one — a direct child, not a subsection's. */
function directChildLabel(xml: string, span: Span, spans: Span[]): { text: string } | null {
  const label = directChildLabelSpan(xml, span, spans);
  if (!label) return null;
  const value = decodeEntities(stripTags(xml.slice(label.contentStart, label.end))).trim();
  return value.length ? { text: value } : null;
}

/**
 * The element's marginal note, if it has one.
 *
 * The marginal note is the heading the Justice Laws site prints beside a
 * provision — "Record of disclosures to be retained". It is not the law, but it is
 * the most useful single string for retrieval, so it is carried separately.
 */
function marginalNoteOf(xml: string, span: Span, spans: Span[]): string | null {
  const note = childrenOf(spans, span).find((candidate) => candidate.tag === 'MarginalNote');
  if (!note) return null;
  const value = decodeEntities(stripTags(xml.slice(note.contentStart, note.end))).trim();
  return value.length ? value : null;
}

/**
 * The plain text of a unit.
 *
 * Editorial history and the marginal note are not the law, and the unit's own label
 * is carried in a separate column, so all three are removed. Subsection labels are
 * kept: "(1) ..." is how the provision reads.
 */
function unitText(
  xml: string,
  span: Span,
  spans: Span[],
  options: { removeOwnLabel: boolean },
): string {
  const removals: [number, number][] = [];
  const own = directChildLabelSpan(xml, span, spans);
  if (options.removeOwnLabel && own) removals.push([own.contentStart, own.end]);

  for (const candidate of spans) {
    if (!isInside(candidate, span)) continue;
    // The marginal note is the heading beside a provision, not the provision. It
    // is removed here and carried separately in the row's own column.
    if (
      candidate.tag !== 'HistoricalNote' &&
      candidate.tag !== 'Footnote' &&
      candidate.tag !== 'FootnoteRef' &&
      candidate.tag !== 'MarginalNote'
    ) {
      continue;
    }
    removals.push([candidate.openStart, candidate.end]);
  }

  let text = sliceWithout(xml, span.contentStart, span.end, removals);
  // A subsection label reads "(1) the text follows"; without the space it reads
  // "(1)the text follows". The space belongs after the label, not inside it.
  text = text.replace(/<\/Label>/g, '</Label> ');
  text = stripTags(text);
  text = decodeEntities(text);
  return text.replace(/\s+/g, ' ').trim();
}

function directChildLabelSpan(xml: string, span: Span, spans: Span[]): Span | null {
  return (
    spans.find(
      (candidate) =>
        candidate.tag === 'Label' &&
        candidate.path.length === span.path.length + 1 &&
        candidate.path[span.path.length] === span.tag &&
        isInside(candidate, span),
    ) ?? null
  );
}

function isInside(candidate: Span, parent: Span): boolean {
  return candidate.contentStart >= parent.contentStart && candidate.end <= parent.end;
}

/** Slice out a range of the source, minus a set of ranges to remove. */
function sliceWithout(xml: string, start: number, end: number, removals: [number, number][]): string {
  const sorted = [...removals].sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = start;
  for (const [from, to] of sorted) {
    if (from < cursor || from >= end) continue;
    out += xml.slice(cursor, Math.min(from, end));
    cursor = Math.max(cursor, to);
  }
  out += xml.slice(Math.min(cursor, end), end);
  return out;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, '');
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
 * A schedule, as one unit.
 *
 * The schedule's items are its direct children, kept separate so that a chunk
 * boundary can fall between two items. A schedule's label — "SCHEDULE I" — is what
 * it is cited by.
 */
function buildScheduleUnit(xml: string, span: Span, spans: Span[]): ParsedUnit | null {
  const heading = childrenOf(spans, span).find((c) => c.tag === 'ScheduleFormHeading');
  // A child of the heading: its path is the heading's path plus the heading's tag.
  const isChildOfHeading = (c: Span): boolean =>
    !!heading &&
    c.path.length === heading.path.length + 1 &&
    c.path[heading.path.length] === heading.tag &&
    isInside(c, heading);

  const labelSpan = heading ? spans.find((c) => c.tag === 'Label' && isChildOfHeading(c)) : undefined;
  const label = labelSpan
    ? decodeEntities(stripTags(xml.slice(labelSpan.contentStart, labelSpan.end))).trim()
    : '';
  if (!label) return null;

  const items: { label: string; text: string }[] = [];
  for (const child of childrenOf(spans, span)) {
    // The heading and the editorial history are not the schedule's content.
    if (child.tag === 'ScheduleFormHeading' || child.tag === 'HistoricalNote') continue;
    const text = unitText(xml, child, spans, { removeOwnLabel: false });
    if (!text) continue;
    const childLabel = directChildLabelSpan(xml, child, spans);
    const itemLabel = childLabel
      ? decodeEntities(stripTags(xml.slice(childLabel.contentStart, childLabel.end))).trim()
      : '';
    items.push({ label: itemLabel, text });
  }
  if (items.length === 0) return null;

  return {
    label,
    marginalNote: scheduleTitleOf(xml, heading, spans),
    text: items.map((item) => item.text).join('\n'),
    kind: 'schedule',
    items,
    anchor: limsIdOf(xml, span),
  };
}

/** The schedule's title, which is usually the Act it belongs to. */
function scheduleTitleOf(xml: string, heading: Span | undefined, spans: Span[]): string | null {
  if (!heading) return null;
  const title = spans.find(
    (c) =>
      c.tag === 'TitleText' &&
      c.path.length === heading.path.length + 1 &&
      c.path[heading.path.length] === heading.tag &&
      isInside(c, heading),
  );
  if (!title) return null;
  const value = decodeEntities(stripTags(xml.slice(title.contentStart, title.end))).trim();
  return value.length ? value : null;
}

/** The Lims id of an element, used to anchor a citation into the full-text page. */
function limsIdOf(xml: string, span: Span): string | null {
  const open = xml.slice(span.openStart, span.openEnd);
  const match = /\blims:id="(\d+)"/.exec(open);
  return match ? match[1]! : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Rows
 * ──────────────────────────────────────────────────────────────────────────── */

export interface BuildRowsOptions {
  /** 'acts' or 'regulations' — decides the citation URL path. */
  kind: 'acts' | 'regulations';
  /** Language of the document. */
  language: 'en' | 'fr';
  /**
   * The maximum characters in a schedule chunk. A chunk is one embedding's worth of
   * text; a schedule with six hundred items is chunked rather than embedded whole.
   */
  scheduleChunkChars?: number;
}

/**
 * What state a provision is in.
 *
 * - `in-force` — the law.
 * - `repealed` — it was law and is not any more. The text says so: "[Repealed,
 *   SOR/2010-20]". This is worth keeping and worth finding, because the useful
 *   answer to "what does s. 9 say" is sometimes "it was repealed in 2010".
 * - `placeholder` — a gap in the consolidation: "[Amendment]" means the provision
 *   exists but its text lives in an amending instrument. There are nearly eleven
 *   thousand of these, all with identical text, and they are excluded from the
 *   vector index — eleven thousand identical vectors would crowd it. They stay in
 *   the store, because a citation to section 17 has to resolve to something.
 */
export type ProvisionStatus = 'in-force' | 'repealed' | 'placeholder';

export interface StatuteSectionRow {
  id: string;
  corpus_id: 'statutes-canada';
  act: string;
  citation: string;
  section: string;
  status: ProvisionStatus;
  /** The schedule a chunk belongs to, or null. */
  schedule: string | null;
  /** The chunk number within a schedule, or null. */
  part: number | null;
  heading: string | null;
  text: string;
  source_url: string;
  jurisdiction: 'CA';
  in_force: number;
  language: 'en' | 'fr';
  topics: string | null;
}

const DEFAULT_SCHEDULE_CHUNK_CHARS = 8000;

export function buildRows(
  parsed: ParsedStatute,
  options: BuildRowsOptions,
): StatuteSectionRow[] {
  const rows: StatuteSectionRow[] = [];
  const path = CORPUS_PATH[options.language][options.kind];
  // The French site percent-encodes the comma in a regulation's citation
  // ("C.R.C.%2C_ch._870"); the English site does not.
  const citation = options.language === 'fr' ? parsed.citation.replace(/,/g, '%2C') : parsed.citation;
  const chunkChars = options.scheduleChunkChars ?? DEFAULT_SCHEDULE_CHUNK_CHARS;
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const fullTextUrl = `${LAWS_BASE}/${options.language}/${path}/${citation}/FullText.html`;
  let provisionOrdinal = 0;
  let unitOrdinal = 0;

  /**
   * The row's identity.
   *
   * The LIMS id is the corpus's own identifier for a provision, and it is unique
   * across all 1,128,174 of them. It is also stable across re-consolidation: when
   * an Act is re-enacted the provision keeps its id and its text changes, which is
   * exactly the property an index wants. The readable part — instrument and label —
   * is not unique, because an amending regulation can have seventeen provisions
   * all labelled "169.1", each amending a different instrument, and two schedules
   * in one instrument can both be "SCHEDULE II".
   */
  const rowId = (unit: ParsedUnit, part: number | null): string => {
    unitOrdinal++;
    if (unit.anchor) {
      return part === null
        ? `${options.kind}-${options.language}-${unit.anchor}`
        : `${options.kind}-${options.language}-${unit.anchor}-${part}`;
    }
    const base = `${options.kind}-${options.language}-${slug(parsed.citation)}-${slug(unit.label)}`;
    return part === null ? `${base}-${unitOrdinal}` : `${base}-${unitOrdinal}-${part}`;
  };

  for (const unit of parsed.units) {
    if (unit.kind === 'schedule') {
      const chunks = chunkSchedule(unit, chunkChars);
      chunks.forEach((chunk, index) => {
        const id = rowId(unit, index + 1);
        rows.push(
          row({
            id,
            act: parsed.shortTitle,
            citation: parsed.citation,
            section: unit.label,
            schedule: unit.label,
            part: index + 1,
            heading: unit.marginalNote,
            text: chunk,
            sourceUrl: unit.anchor ? `${fullTextUrl}#h-${unit.anchor}` : fullTextUrl,
            inForce: parsed.inForce,
            language: options.language,
            extraText: unit.label,
          }),
        );
      });
      continue;
    }

    if (unit.kind === 'provision') provisionOrdinal++;

    // A section's own page exists for a numbered section and for nothing else. A
    // lettered label — an order's provision — has no page of its own, so it is
    // cited to the instrument's full text, which always exists.
    const isNumberedSection = unit.kind === 'section' && /^[0-9]+(\.[0-9]+)?$/.test(unit.label);
    const sourceUrl = isNumberedSection
      ? `${LAWS_BASE}/${options.language}/${path}/${citation}/section-${unit.label}.html`
      : unit.anchor
        ? `${fullTextUrl}#h-${unit.anchor}`
        : fullTextUrl;

    const id = rowId(unit, null);

    rows.push(
      row({
        id,
        act: parsed.shortTitle,
        citation: parsed.citation,
        section: unit.label,
        schedule: null,
        part: null,
        heading: unit.marginalNote,
        text: unit.text,
        sourceUrl,
        inForce: parsed.inForce,
        language: options.language,
        extraText: null,
      }),
    );
  }
  return rows;
}

/**
 * Split a schedule's items into chunks that fit an embedding.
 *
 * The boundary falls between items, so a chunk never begins in the middle of a
 * provision. A single item longer than the limit is kept whole rather than cut:
 * a truncated legal provision is worse than an oversized one, because it looks
 * complete and is not.
 */
function chunkSchedule(unit: ParsedUnit, limit: number): string[] {
  const items = unit.items ?? [];
  if (items.length === 0) return unit.text ? [unit.text] : [];

  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const item of items) {
    const size = item.text.length + 1;
    if (current.length > 0 && length + size > limit) {
      chunks.push(current.join('\n'));
      current = [];
      length = 0;
    }
    current.push(item.text);
    length += size;
  }
  if (current.length) chunks.push(current.join('\n'));
  return chunks;
}

/**
 * The state of a provision, read from its own text.
 *
 * The consolidation marks a repeal by replacing the provision's text with
 * "[Repealed, …]" and marks a gap with "[Amendment]". Both are the whole of the
 * provision's content, so the text is the only place the answer can come from.
 */
export function statusOf(text: string): ProvisionStatus {
  const trimmed = text.trim();
  // A repeal marker.
  //
  // The two official languages use different words for the same thing, and the
  // French ones are exactly the ones a French-only implementation would miss.
  // The counterparts:
  //
  //   English    French                        Meaning
  //   --------   ---------------------------  --------------------------
  //   Repealed   Abrogé, Abrogée, Abrogés     the provision was repealed
  //   Repeal     Abrogation                   the provision is a repeal
  //   Repeals    Abrogations                  not a repeal of *this* one
  //
  // Missing the French ones does not fail loudly. It labels nineteen thousand
  // repealed provisions as placeholders, and — because `in_force` is derived
  // from this same call — leaves them with `in_force = 1`, so the corpus
  // reports repealed law as live law and a citation to it answers with the
  // wrong thing. The English corpus has 19,011 repealed provisions; the French
  // has 19,097 under the same rule, which is the number it should have had.
  //
  // The boundary is written as a lookahead rather than `\b` because **JavaScript
  // does not consider "é" a word character**. A `\b` after the French marker
  // asks for a transition between two word characters, and "é" is not one, so
  // the boundary is never there and every French repeal reads as a placeholder.
  // The lookahead says what it means: not followed by another ASCII letter.
  if (/^\[(?:Repeal(?:ed)?|Abrog[ée]e?s?|Abrogation)(?![A-Za-z0-9_])/i.test(trimmed)) {
    return 'repealed';
  }
  if (/^\[[^\]]{0,40}\]$/.test(trimmed)) return 'placeholder';
  return 'in-force';
}

function row(input: {
  id: string;
  act: string;
  citation: string;
  section: string;
  schedule: string | null;
  part: number | null;
  heading: string | null;
  text: string;
  sourceUrl: string;
  inForce: boolean;
  language: 'en' | 'fr';
  extraText: string | null;
}): StatuteSectionRow {
  return {
    id: input.id,
    corpus_id: 'statutes-canada',
    act: input.act,
    citation: input.citation,
    section: input.section,
    status: statusOf(input.text),
    schedule: input.schedule,
    part: input.part,
    heading: input.heading,
    text: input.text,
    source_url: input.sourceUrl,
    jurisdiction: 'CA',
    in_force: input.inForce && statusOf(input.text) !== 'repealed' ? 1 : 0,
    language: input.language,
    topics: null,
  };
}

/** The SQL statements that load the rows into D1. */
export function toInsertStatements(rows: StatuteSectionRow[], batchSize = 200): string[] {
  const statements: string[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values = batch.map((r) => rowTuple(r)).join(',');
    statements.push(
      `INSERT OR REPLACE INTO statute_sections (id, corpus_id, act, citation, section, status, schedule, part, heading, text, source_url, jurisdiction, in_force, language, topics) VALUES ${values};`,
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
  return `(${[
    quoted(r.id),
    quoted(r.corpus_id),
    quoted(r.act),
    quoted(r.citation),
    quoted(r.section),
    quoted(r.status),
    nullableQuoted(r.schedule),
    r.part === null ? 'NULL' : String(r.part),
    nullableQuoted(r.heading),
    quoted(r.text),
    quoted(r.source_url),
    quoted(r.jurisdiction),
    String(r.in_force),
    quoted(r.language),
    nullableQuoted(r.topics),
  ].join(',')})`;
}

export function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}
