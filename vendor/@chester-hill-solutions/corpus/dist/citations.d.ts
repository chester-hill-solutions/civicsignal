/** Exact citation parsing and resolution, before lexical or similarity search. */
export interface ParsedCitation {
    /** The instrument title, as it appears in the known corpus titles. */
    act: string;
    /** The complete provision label, e.g. 210, 320.14 or 49(2)(a). */
    section: string;
    /** The citation text found in the input. */
    matched: string;
}
export interface CitationMatch {
    citation: ParsedCitation;
    /** Partial matches are retained in the type for compatibility, but never inferred. */
    actConfidence: "exact" | "partial";
}
/**
 * Parse an exact known instrument adjacent to a provision label.
 *
 * Case and whitespace may differ. Shortened names and shared words are not
 * aliases. More than one distinct citation is ambiguous and returns null.
 */
export declare function parseCitation(text: string, knownActs: string[]): CitationMatch | null;
/** Resolve one exact instrument/provision row, or return null for a miss or ambiguity. */
export declare function resolveCitation<T extends {
    act: string;
    section: string;
}>(match: ParsedCitation, rows: T[]): T | null;
/** Unique instrument titles, longest first, for presentation and citation parsing. */
export declare function actTitles(rows: {
    act: string;
}[]): string[];
