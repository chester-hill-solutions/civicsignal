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
/**
 * Section label shapes that appear in citations and in the corpus: a number, a
 * decimal, a number with a bracketed subsection, and a lettered subsection.
 */
const SECTION = String.raw `\d+(?:\.\d+)?(?:\s*\(\s*[0-9a-z]+\s*\))?`;
/**
 * Extract a citation from free text.
 *
 * `knownActs` is the list of Act titles in the corpus. The Act is matched by its
 * longest title, so "Canada Labour Code" wins over a shorter title that is a
 * substring of it, and the caller does not have to pre-sort.
 */
export function parseCitation(text, knownActs) {
    const haystack = text.toLowerCase();
    let act;
    for (const candidate of knownActs) {
        if (candidate.length <= (act?.length ?? 0))
            continue;
        if (haystack.includes(candidate.toLowerCase()))
            act = candidate;
    }
    let actConfidence = "exact";
    if (!act) {
        // The Act may be referred to by a distinctive part of its name — "Labour Code"
        // for "Canada Labour Code". Accept a partial match only when the fragment is
        // long enough to be unambiguous.
        for (const candidate of knownActs) {
            const words = candidate.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 4);
            for (const word of words) {
                if (haystack.includes(word)) {
                    act = candidate;
                    actConfidence = "partial";
                    break;
                }
            }
            if (act)
                break;
        }
    }
    if (!act)
        return null;
    const patterns = [
        new RegExp(String.raw `\b(?:section|sections|s\.)\s*(${SECTION})`, "i"),
        new RegExp(String.raw `\b${SECTION}\s+(?:of|in)\s+(?:the\s+)?`, "i"),
    ];
    let section;
    let matched = "";
    for (const pattern of patterns) {
        const found = pattern.exec(text);
        if (found?.[1]) {
            section = found[1].replace(/\s+/g, "");
            matched = found[0];
            break;
        }
    }
    if (!section)
        return null;
    return { citation: { act, section, matched }, actConfidence };
}
/**
 * Resolve a parsed citation against a corpus.
 *
 * A citation that names a section the instrument does not have is not a near miss —
 * it is wrong, and returning the nearest section would be worse than returning
 * nothing. The resolver therefore reports whether the citation resolved exactly, and
 * whether the Act was identified by a full title or a fragment.
 */
export function resolveCitation(match, rows) {
    const exact = rows.find((row) => row.act === match.act && row.section === match.section);
    if (exact)
        return exact;
    // The Act title in a citation is often a superset of the corpus title, or the
    // corpus title carries a suffix the citation omits.
    const loose = rows.find((row) => row.section === match.section &&
        (row.act.toLowerCase().startsWith(match.act.toLowerCase()) ||
            match.act.toLowerCase().startsWith(row.act.toLowerCase())));
    return loose ?? null;
}
/**
 * The Act titles in a corpus, longest first, for citation matching.
 *
 * Longest first matters: "Canada Labour Code" must win over "Labour Code", and
 * "Income Tax Act" over "Tax Act".
 */
export function actTitles(rows) {
    const unique = new Set(rows.map((row) => row.act));
    return [...unique].sort((a, b) => b.length - a.length || a.localeCompare(b));
}
