/**
 * Text, normalised for search.
 *
 * The corpus is bilingual, and the two languages do not agree about their
 * letters. A French provision says "règlement" and the person typing the
 * query writes "reglement" — because the keyboard has no accent key, because
 * the form was copied from an English source, or because the accent was simply
 * forgotten. Both are the same word, and the corpus has to treat them as the
 * same word.
 *
 * So the accents come off, on both sides of the comparison: in the corpus's
 * `search_text` and in the query the lexical path searches it with. Folding
 * only one side would make the two disagree in exactly the case the fold is
 * for.
 *
 * This is the **lexical** path's problem. The vector path does not have it: a
 * model reads "règlement" and "reglement" as the same word, which is one of
 * the things a model is for.
 */

/**
 * Remove the diacritics and lower-case.
 *
 * `é` becomes `e`, `ç` becomes `c`, `œ` becomes `oe`, and the letters that
 * have no unaccented form — `ß`, `ø`, `đ` — are left alone rather than
 * mangled.
 */
export function foldAccents(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[œŒ]/g, (c) => (c === "œ" ? "oe" : "OE"))
    .toLowerCase();
}

/**
 * The form of a string that the lexical path compares.
 *
 * Both sides use this. The corpus's `search_text` is built with it, and the
 * query's patterns are built with it, so a match means the same thing on both
 * sides.
 */
export function normalizeForSearch(text: string): string {
  return foldAccents(text);
}
