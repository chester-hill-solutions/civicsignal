/**
 * Licence regimes for corpora, and the gate that enforces them.
 *
 * Public records are not all equally reusable. Some are open for commercial
 * redistribution; some may be quoted and cited but not republished; some may only
 * be referenced by title and link. A corpus that serves one of these without
 * knowing which regime it is under is a legal exposure, and the failure is silent:
 * the response looks correct, and it is not lawful to send it.
 *
 * So the regime is declared once, per corpus, and enforced at emission. A corpus
 * declared `cite-only` cannot have its body returned no matter which route, tool or
 * caller asks for it, because the stripping happens here rather than at each call
 * site.
 */
/**
 * How freely a corpus may be reproduced.
 *
 * - `open` — the source permits reproduction, including commercial use.
 * - `cite-only` — the source permits reproduction for personal and non-commercial
 *   purposes only. It may be indexed, facts may be derived from it, short excerpts
 *   may be quoted with attribution, and every use must link to the official record.
 *   It may not be republished as a searchable corpus.
 * - `metadata-only` — only the existence, title, timing and link of an item may
 *   surface. Not its content.
 */
export type Redistribution = "open" | "cite-only" | "metadata-only";
export interface CorpusPolicy {
    /** Stable identifier, e.g. `statutes-canada`. */
    id: string;
    /** Human-readable title of the corpus. */
    title: string;
    /** The body that published the source. */
    publisher: string;
    /** Short licence name, for display. */
    licence: string;
    /** Where the licence text lives. */
    licenceUrl: string;
    /** The reproduction regime the source actually permits. */
    redistribution: Redistribution;
    /** Attribution that must accompany any output from this corpus. */
    attribution: string;
    /** Conditions the reader is entitled to see. */
    conditions: string[];
    /** Longest excerpt, in characters, that may be emitted. 0 disables excerpts. */
    excerptMaxChars: number;
    /** Whether source text may be returned verbatim. */
    allowFullText: boolean;
    /** Whether every emitted item must carry a link back to the official source. */
    requireSourceLink: boolean;
}
export declare class LicenceViolation extends Error {
    readonly corpusId: string;
    readonly field: string;
    readonly redistribution: Redistribution;
    constructor(corpusId: string, field: string, redistribution: Redistribution);
}
/** The minimum a compliant item is allowed to look like, before any corpus fields. */
export interface RawCorpusItem {
    corpusId: string;
    kind: "statute" | "bill" | "debate" | "news" | "event" | "sentiment" | "document";
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
    entities?: {
        name: string;
        type: string;
        id?: string;
    }[];
    sentiment?: {
        score: number;
        magnitude?: number;
    };
    /** Corpus-specific fields, passed through untouched. */
    extra?: Record<string, unknown>;
}
/** What actually leaves the building. */
export interface CorpusItem {
    corpusId: string;
    kind: RawCorpusItem["kind"];
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
    entities?: {
        name: string;
        type: string;
        id?: string;
    }[];
    sentiment?: {
        score: number;
        magnitude?: number;
    };
    extra?: Record<string, unknown>;
    /** The regime this item was emitted under, so consumers can reason about it. */
    redistribution: Redistribution;
    attribution: string;
}
/**
 * Apply a corpus policy to a raw item, producing what may legally be returned.
 *
 * Throws rather than silently dropping fields when a caller asks for something the
 * regime forbids — that is a programming error, and it should fail loudly in tests
 * rather than quietly produce a less useful answer in production.
 */
export declare function emitCorpusItem(policy: CorpusPolicy, raw: RawCorpusItem): CorpusItem;
/**
 * Emit a batch, skipping items whose policy forbids the requested field rather than
 * failing the whole response. Used for mixed-corpus responses where one corpus may
 * legitimately carry less than another.
 */
export declare function emitCorpusItems(policies: Map<string, CorpusPolicy>, raws: RawCorpusItem[]): CorpusItem[];
export declare function truncate(value: string, maxChars: number): string;
/** The attribution block that must accompany any response drawing on this corpus. */
export declare function attributionFor(policy: CorpusPolicy): string;
