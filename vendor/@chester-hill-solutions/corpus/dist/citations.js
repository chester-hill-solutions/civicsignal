/** Exact citation parsing and resolution, before lexical or similarity search. */
const SECTION = "\\d+(?:\\.\\d+)*(?:\\s*\\(\\s*[0-9a-z]+\\s*\\))*";
const MARKER = "\\b(?:sections?|s\\.)\\s*";
const CITATION_START = "(?:^|[?!;,\\n]|\\band)\\s*";
const SECTION_END = "(?![\\p{L}\\p{N}_]|\\.\\d|\\s*\\()";
// A title may end the citation or be followed by ordinary question wording,
// never by an arbitrary suffix such as Regulations or Amendment Act.
const TITLE_END = "(?=\\s*$|[?!.;:,)]|\\s+(?:say|says|mean|means|provide|provides|require|requires|apply|applies|cover|covers|do|does|is|are)\\b|\\s+and\\s+(?:(?:sections?|s\\.)\\s*)?\\d)";
function normalizedTitle(title) {
    return title.trim().replace(/\s+/g, " ").toLowerCase();
}
function normalizedSection(section) {
    return section.trim().replace(/\s*([()])\s*/g, "$1");
}
function titlePattern(title) {
    return title.trim().split(/\s+/).map((word) => word.replace(/[.*+?^{}()|[\]\\$]/g, "\\$&")).join("\\s+");
}
/**
 * Parse an exact known instrument adjacent to a provision label.
 *
 * Case and whitespace may differ. Shortened names and shared words are not
 * aliases. More than one distinct citation is ambiguous and returns null.
 */
export function parseCitation(text, knownActs) {
    const titles = new Map();
    for (const act of knownActs) {
        const key = normalizedTitle(act);
        if (key && !titles.has(key))
            titles.set(key, act);
    }
    const citations = new Map();
    for (const act of titles.values()) {
        const title = titlePattern(act);
        const patterns = [
            {
                pattern: new RegExp(MARKER + "(" + SECTION + ")\\s+(?:of|in)\\s+(?:the\\s+)?(" + title + ")" + TITLE_END, "giu"),
                sectionGroup: 1,
            },
            {
                pattern: new RegExp(CITATION_START + "(" + SECTION + ")\\s+(?:of|in)\\s+(?:the\\s+)?(" + title + ")" + TITLE_END, "giu"),
                sectionGroup: 1,
            },
            {
                pattern: new RegExp(CITATION_START + "(?:the\\s+)?(" + title + ")\\s*[,;:]?\\s*" + MARKER + "(" + SECTION + ")" + SECTION_END, "giu"),
                sectionGroup: 2,
            },
        ];
        for (const { pattern, sectionGroup } of patterns) {
            for (const match of text.matchAll(pattern)) {
                const citation = { act, section: normalizedSection(match[sectionGroup]), matched: match[0] };
                citations.set(JSON.stringify([normalizedTitle(act), citation.section]), citation);
            }
        }
    }
    if (citations.size !== 1)
        return null;
    return { citation: citations.values().next().value, actConfidence: "exact" };
}
/** Resolve one exact instrument/provision row, or return null for a miss or ambiguity. */
export function resolveCitation(match, rows) {
    const matches = rows.filter((row) => normalizedTitle(row.act) === normalizedTitle(match.act) &&
        normalizedSection(row.section) === normalizedSection(match.section));
    return matches.length === 1 ? matches[0] : null;
}
/** Unique instrument titles, longest first, for presentation and citation parsing. */
export function actTitles(rows) {
    const unique = new Set(rows.map((row) => row.act));
    return [...unique].sort((a, b) => b.length - a.length || a.localeCompare(b));
}
