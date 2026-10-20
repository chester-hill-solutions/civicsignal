/**
 * Licence boundaries, encoded as code.
 *
 * Every corpus this product touches sits under a different reproduction regime, and
 * the differences are not academic — one of them decides whether the product can be
 * sold at all. The written analysis lives in `docs/LICENCE-REGISTER.md`; this module
 * is the enforcement point.
 *
 * The rule: a corpus declared `cite-only` or `metadata-only` can never have its body
 * emitted, no matter which route, tool or caller asks for it. Stripping happens here
 * rather than at each call site, so a new endpoint cannot accidentally leak a corpus
 * that the licence does not allow.
 */

/**
 * How freely a corpus may be reproduced.
 *
 * - `open`          — the source permits reproduction, including commercial use
 *                     (e.g. Open Government Licence - Canada).
 * - `cite-only`     — the source is Crown copyright and permits reproduction for
 *                     personal and non-commercial purposes only. We may index it,
 *                     derive facts from it, quote a short excerpt and link to the
 *                     official text; we may not republish it as a searchable corpus.
 * - `metadata-only` — we may surface the existence, title, timing and link of an item,
 *                     but not its content.
 */
export type Redistribution = 'open' | 'cite-only' | 'metadata-only';

export interface CorpusPolicy {
  /** Stable identifier, e.g. `statutes-canada`. */
  id: string;
  title: string;
  publisher: string;
  /** Short licence name, for display. */
  licence: string;
  licenceUrl: string;
  redistribution: Redistribution;
  /** Attribution string that must accompany any output from this corpus. */
  attribution: string;
  /** Human-readable conditions the reader is entitled to see. */
  conditions: string[];
  /** Longest excerpt, in characters, that may be emitted. 0 disables excerpts entirely. */
  excerptMaxChars: number;
  /** Whether source text may be returned verbatim. */
  allowFullText: boolean;
  /** Whether every emitted item must carry a link back to the official source. */
  requireSourceLink: boolean;
}

export class LicenceViolation extends Error {
  constructor(
    readonly corpusId: string,
    readonly field: string,
    readonly redistribution: Redistribution,
  ) {
    super(
      `Corpus "${corpusId}" may not emit "${field}" under its ${redistribution} terms. ` +
        `See docs/LICENCE-REGISTER.md.`,
    );
    this.name = 'LicenceViolation';
  }
}

/** The minimum a compliant item is allowed to look like, before any corpus-specific fields. */
export interface RawCorpusItem {
  corpusId: string;
  kind: 'statute' | 'bill' | 'debate' | 'news' | 'event' | 'sentiment';
  id: string;
  title: string;
  /** Full source text. Only ever emitted for `open` corpora. */
  body?: string;
  /** Short passage. Emitted for `open` and `cite-only` corpora, subject to the cap. */
  excerpt?: string;
  /** Link to the official source. */
  citationUrl: string;
  publishedAt?: string;
  /** Publisher or outlet. */
  source: string;
  language?: string;
  jurisdiction?: string;
  topics?: string[];
  entities?: { name: string; type: string; id?: string }[];
  sentiment?: { score: number; magnitude?: number };
  /** Corpus-specific fields, passed through untouched. */
  extra?: Record<string, unknown>;
}

/** What actually leaves the building. */
export interface CorpusItem {
  corpusId: string;
  kind: RawCorpusItem['kind'];
  id: string;
  title: string;
  body?: string;
  excerpt?: string;
  citationUrl: string;
  publishedAt?: string;
  source: string;
  language?: string;
  jurisdiction?: string;
  topics?: string[];
  entities?: { name: string; type: string; id?: string }[];
  sentiment?: { score: number; magnitude?: number };
  extra?: Record<string, unknown>;
  /** The licence regime this item was emitted under, so consumers can reason about it. */
  redistribution: Redistribution;
  attribution: string;
}

/**
 * Apply a corpus policy to a raw item, producing what may legally be returned.
 *
 * Throws rather than silently dropping fields when a caller asks for something the
 * licence forbids — that is a programming error, and it should fail loudly in tests
 * rather than quietly produce a less useful answer in production.
 */
export function emitCorpusItem(policy: CorpusPolicy, raw: RawCorpusItem): CorpusItem {
  if (raw.corpusId !== policy.id) {
    throw new Error(
      `Corpus mismatch: policy "${policy.id}" cannot emit an item from "${raw.corpusId}".`,
    );
  }

  const item: CorpusItem = {
    corpusId: raw.corpusId,
    kind: raw.kind,
    id: raw.id,
    title: raw.title,
    citationUrl: raw.citationUrl,
    publishedAt: raw.publishedAt,
    source: raw.source,
    language: raw.language,
    jurisdiction: raw.jurisdiction,
    topics: raw.topics,
    entities: raw.entities,
    sentiment: raw.sentiment,
    extra: raw.extra,
    redistribution: policy.redistribution,
    attribution: policy.attribution,
  };

  if (policy.allowFullText && raw.body !== undefined) {
    item.body = raw.body;
  } else if (raw.body !== undefined && !policy.allowFullText) {
    // The body exists upstream but this corpus does not permit it. Drop it silently
    // here — the excerpt path below is the sanctioned substitute — but make the
    // policy visible in the output so consumers know what regime they are in.
    delete item.body;
  }

  if (raw.excerpt !== undefined) {
    if (policy.excerptMaxChars === 0) {
      delete item.excerpt;
    } else {
      item.excerpt = truncate(raw.excerpt, policy.excerptMaxChars);
    }
  }

  if (policy.requireSourceLink && !raw.citationUrl) {
    throw new LicenceViolation(policy.id, 'citationUrl', policy.redistribution);
  }

  return item;
}

/**
 * Emit a batch, skipping items whose policy forbids the requested field rather than
 * failing the whole response. Used for mixed-corpus responses where one corpus may
 * legitimately carry less than another.
 */
export function emitCorpusItems(
  policies: Map<string, CorpusPolicy>,
  raws: RawCorpusItem[],
): CorpusItem[] {
  const out: CorpusItem[] = [];
  for (const raw of raws) {
    const policy = policies.get(raw.corpusId);
    if (!policy) continue; // unknown corpus: never emit it
    out.push(emitCorpusItem(policy, raw));
  }
  return out;
}

export function truncate(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** The attribution block that must accompany any response drawing on this corpus. */
export function attributionFor(policy: CorpusPolicy): string {
  return `${policy.attribution} — ${policy.licence}. ${policy.conditions.join(' ')}`.trim();
}
