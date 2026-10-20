/**
 * Citation parsing and resolution.
 *
 * A large share of real legal questions are citations rather than queries:
 * "section 210 of the Canada Labour Code", "s. 320.14 of the Criminal Code". A
 * citation is a key, not a similarity. Running one through a search index puts the
 * right answer at rank five, because a bare section number has almost no IDF across
 * a large corpus — "210" appears in a thousand different provisions.
 *
 * So citations are resolved structurally, ahead of any search arm.
 */
/** A citation, as extracted from free text. */
export interface ParsedCitation {
    /** The Act the section belongs to, exactly as it appears in the corpus. */
    act: string;
    /** The section label, e.g. "210" or "320.14" or "49(2)". */
    section: string;
    /** The text the citation was found in. */
    matched: string;
}
export interface CitationMatch {
    citation: ParsedCitation;
    /** How confidently the Act was identified. */
    actConfidence: "exact" | "partial";
}
/**
 * Extract a citation from free text.
 *
 * `knownActs` is the list of Act titles in the corpus. The Act is matched by its
 * longest title, so "Canada Labour Code" wins over a shorter title that is a
 * substring of it, and the caller does not have to pre-sort.
 */
export declare function parseCitation(text: string, knownActs: string[]): CitationMatch | null;
/**
 * Resolve a parsed citation against a corpus.
 *
 * A citation that names a section the instrument does not have is not a near miss —
 * it is wrong, and returning the nearest section would be worse than returning
 * nothing. The resolver therefore reports whether the citation resolved exactly, and
 * whether the Act was identified by a full title or a fragment.
 */
export declare function resolveCitation<T extends {
    act: string;
    section: string;
}>(match: ParsedCitation, rows: T[]): T | null;
/**
 * The Act titles in a corpus, longest first, for citation matching.
 *
 * Longest first matters: "Canada Labour Code" must win over "Labour Code", and
 * "Income Tax Act" over "Tax Act".
 */
export declare function actTitles(rows: {
    act: string;
}[]): string[];
