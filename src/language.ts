/**
 * Which language the caller is asking in.
 *
 * The corpus holds Canada's statutes in both official languages, and the two
 * versions of a provision are **different rows with different identifiers**. So
 * "which language" is not a presentation detail — it decides which row is the
 * answer, and a corpus that holds both without a way to ask about one of them
 * has an ambiguity problem rather than a translation problem.
 *
 * The language is therefore a **lens the caller chooses**, exactly like the
 * geography: a caller may always say which one they want, and the surfaces
 * infer it when they are not told.
 *
 * ## Why a heuristic and not a model
 *
 * The inference has to be cheap and it has to be explainable. A caller who asks
 * in French and gets English provisions back has been given the wrong rows, and
 * the reason should be visible: the question was French, so the French corpus
 * was used. A probability from a language model would be neither.
 *
 * It is also a decision with a legal edge. Under the *Official Languages Act*
 * both versions of an Act have equal legal force, and a paraphrase of one is
 * not the other. So a French question deserves the French text.
 */

/** The languages the corpus holds. */
export type CorpusLanguage = "en" | "fr";

/**
 * Words that carry a language on their own.
 *
 * Short, common, and grammatical rather than topical — a topical word would
 * be wrong, because "passport" and "passeport" differ by a prefix, not a
 * language, and "notice" exists in both.
 */
const FRENCH_MARKERS = [
  "le", "la", "les", "un", "une", "des", "du", "de", "au", "aux", "et", "ou",
  "que", "qui", "quoi", "comment", "quel", "quelle", "quels", "quelles",
  "est", "sont", "dans", "pour", "avec", "sur", "ce", "cette", "ces", "cet",
  "pas", "plus", "etre", "avoir", "son", "sa", "ses", "leur", "leurs", "ne",
  "en", "au", "y", "dont", "par", "si", "on", "il", "elle", "nous", "vous",
  "loi", "lois", "article", "articles", "section", "sections", "reglement",
  "reglements", "code", "codes", "travail", "famille", "sante", "impot",
];

const ENGLISH_MARKERS = [
  "the", "a", "an", "of", "and", "or", "what", "which", "who", "whom", "how",
  "is", "are", "was", "were", "in", "for", "with", "on", "to", "this", "that",
  "these", "those", "not", "be", "been", "have", "has", "its", "their", "it",
  "section", "sections", "act", "acts", "regulation", "regulations", "code",
  "law", "laws", "say", "says", "does", "do", "about", "under", "from",
];

/**
 * Characters that do not appear in English words.
 *
 * Accents are the strongest cheap signal there is: they mark the text as
 * French outright, and an English text with a loanword accent is rare enough
 * not to matter. The cedilla and the ligature are included because they are
 * common in French and absent from English.
 */
const FRENCH_CHARACTERS = /[àâçéèêëîïôûùœÀÂÇÉÈÊËÎÏÔÛÙŒ]/;

/**
 * Strip the accents, so that a word written without them still matches its
 * marker. "reglement" is how a person types "règlement" when the keyboard
 * does not have the key, and it should still be recognised as French.
 */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Count the markers that appear as whole words. */
function countMarkers(text: string, markers: string[]): number {
  const words = new Set(text.split(/[^a-z]+/i).filter(Boolean));
  let hits = 0;
  for (const marker of markers) {
    if (words.has(marker)) hits++;
  }
  return hits;
}

/**
 * Decide which language a question is in.
 *
 * The rule is deliberately simple and deliberately biased: the answer is French
 * only when the evidence is French, and the evidence has to be a **whole word**
 * or an accented character. A French marker inside an English word is not
 * evidence — "la" is in "legal", and counting it would make every question
 * about law look French.
 *
 * A tie goes to English, because English is the corpus's default and a wrong
 * guess that keeps the default is less surprising than one that does not.
 */
export function detectLanguage(text: string | undefined | null): CorpusLanguage {
  if (!text) return "en";
  const folded = fold(text);
  if (!folded.trim()) return "en";

  const french = countMarkers(folded, FRENCH_MARKERS);
  const english = countMarkers(folded, ENGLISH_MARKERS);

  // An accented character is decisive on its own: no English sentence has one.
  if (FRENCH_CHARACTERS.test(text)) return "fr";

  return french > english ? "fr" : "en";
}

/**
 * The language to search in, given what the caller asked for.
 *
 * An explicit request always wins. A caller who set the language meant it, the
 * same way a caller who set a jurisdiction meant it.
 *
 * Without an explicit request, the pieces of text are weighed **individually**,
 * and any one of them being French makes the answer French.
 *
 * That is asymmetric on purpose. English is the corpus's default, so English
 * is what everything falls back to — and French is the language with
 * *distinctive* markers: an accented character, `du`, `des`, `que`, `la`. So
 * the question is not "which language are these texts in" but "is anything
 * here French", and a single French instrument title among an English question
 * is exactly the case that matters:
 *
 *     "What does the Code du travail say about leave?"
 *
 * is a question about the French Labour Code, and answering it from the
 * English rows would answer a different question. Scoring the texts together
 * would lose that, because the question's English function words outnumber the
 * title's two French ones.
 */
export function languageFor(
  requested: string | undefined | null,
  ...texts: (string | undefined | null)[]
): CorpusLanguage {
  if (requested) {
    const normalized = requested.toLowerCase().trim();
    if (normalized === "fr" || normalized.startsWith("fr-")) return "fr";
    if (normalized === "en" || normalized.startsWith("en-")) return "en";
  }
  for (const text of texts) {
    if (text && detectLanguage(text) === "fr") return "fr";
  }
  return "en";
}
