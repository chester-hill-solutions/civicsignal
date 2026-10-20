/**
 * A small BM25 index over the statute corpus.
 *
 * This is the lexical arm of the retrieval evaluation: the search that already
 * works, built on the `search_text` column the ingest produces. The question the
 * evaluation asks is whether a vector arm beats it, and that is only meaningful
 * against a properly implemented baseline.
 *
 * The implementation is deliberately plain — a term/postings index over typed
 * arrays — because the point is to measure, not to be fast.
 */

export const K1 = 1.2;
export const B = 0.75;

/** Words that carry no retrieval signal in English legal text. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from', 'has',
  'have', 'he', 'her', 'his', 'if', 'in', 'is', 'it', 'its', 'may', 'of', 'on', 'or',
  'our', 'she', 'that', 'the', 'their', 'them', 'there', 'these', 'they', 'this', 'to',
  'was', 'were', 'what', 'when', 'where', 'which', 'who', 'will', 'with', 'would', 'you',
  'your', 'shall', 'any', 'all', 'each', 'such', 'other', 'same', 'into', 'than', 'then',
]);

/**
 * A deliberately small stemmer — roughly Porter's first step.
 *
 * Legal text is full of nominalised forms ("increases", "increased", "increasing") and
 * a question says "increase". The stemmer is not a research project; it exists so the
 * baseline is not strawmanned. It is applied consistently to both documents and
 * queries.
 *
 * The Porter condition on the trailing vowel matters more than it looks: without
 * restoring the dropped "e", "increased" stems to "increas" while "increase" stems to
 * "increase", and the two no longer match. A baseline that misses that would flatter
 * the vector arm.
 */
export function stem(word: string): string {
  let w = word;

  // 1a — plurals.
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('sses')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) {
    w = w.slice(0, -1);
  }

  // 1b — past tense and gerund.
  for (const suffix of ['ing', 'ed']) {
    if (w.length > 5 && w.endsWith(suffix)) {
      let base = w.slice(0, -suffix.length);
      if (/(bb|dd|ff|gg|mm|nn|pp|rr|tt)$/.test(base)) base = base.slice(0, -1);
      else if (/(at|bl|iz)$/.test(base)) base += 'e';
      else if (endsShortSyllable(base)) base += 'e';
      w = base;
      break;
    }
  }

  // A final "e" is dropped so that a verb and its inflections collide: Porter alone
  // leaves "increase" as "increase" and "increased" as "increas", so a question
  // saying "increase" would never match a statute saying "increased". The baseline
  // has to be strong, because the decision this evaluation informs is whether to
  // spend money on a vector arm; a weak baseline would flatter the vector arm.
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);

  return w;
}

function isVowel(char: string): boolean {
  return 'aeiou'.includes(char);
}

function isConsonant(char: string): boolean {
  return /[a-z]/.test(char) && !isVowel(char);
}

/** The Porter condition: the stem ends in consonant-vowel-consonant. */
function endsShortSyllable(word: string): boolean {
  if (word.length < 3) return false;
  const last = word.at(-1)!;
  const middle = word.at(-2)!;
  const first = word.at(-3)!;
  if (!isConsonant(last) || !isVowel(middle) || !isConsonant(first)) return false;
  return !'wxy'.includes(last);
}

/** Lowercase, split on anything that is not a letter or a digit, stem, drop stopwords. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    const s = stem(raw);
    if (s.length < 2) continue;
    out.push(s);
  }
  return out;
}

export interface Bm25Index {
  docCount: number;
  /** Term frequency per posting. */
  tfs: Int32Array;
  /** Document id per posting. */
  docIds: Int32Array;
  /** First posting of each term. */
  termStart: Int32Array;
  /** Term frequency per document, for the length normalisation. */
  docTf: Int32Array;
  /** Document lengths in tokens. */
  docLen: Int32Array;
  avgDocLen: number;
  /** Number of documents each term appears in. */
  docFreq: Int32Array;
  termIds: Map<string, number>;
  termCount: number;
}

export function buildIndex(documents: string[]): Bm25Index {
  const termIds = new Map<string, number>();
  const termCounts: number[] = [];
  const postings: number[][] = [];
  const docTfCounts: number[] = [];
  const docLen: number[] = [];

  for (let docId = 0; docId < documents.length; docId++) {
    const tokens = tokenize(documents[docId]!);
    docLen.push(tokens.length);
    const counts = new Map<number, number>();
    for (const token of tokens) {
      let id = termIds.get(token);
      if (id === undefined) {
        id = termCounts.length;
        termIds.set(token, id);
        termCounts.push(0);
        postings.push([]);
      }
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [id, count] of counts) {
      postings[id]!.push(docId);
      termCounts[id]! += count;
    }
    docTfCounts.push(counts.size);
  }

  const totalPostings = postings.reduce((sum, p) => sum + p.length, 0);
  const tfs = new Int32Array(totalPostings);
  const docIds = new Int32Array(totalPostings);
  const termStart = new Int32Array(termCounts.length + 1);
  const docFreq = new Int32Array(termCounts.length);
  let cursor = 0;
  for (let term = 0; term < postings.length; term++) {
    termStart[term] = cursor;
    docFreq[term] = postings[term]!.length;
    for (const docId of postings[term]!) {
      docIds[cursor] = docId;
      tfs[cursor] = docTfCounts[docId]!;
      cursor++;
    }
  }
  termStart[postings.length] = cursor;

  const totalLen = docLen.reduce((a, b) => a + b, 0);
  return {
    docCount: documents.length,
    tfs,
    docIds,
    termStart,
    docTf: Int32Array.from(docTfCounts),
    docLen: Int32Array.from(docLen),
    avgDocLen: documents.length ? totalLen / documents.length : 0,
    docFreq,
    termIds,
    termCount: termCounts.length,
  };
}

export interface ScoredDoc {
  docId: number;
  score: number;
}

/**
 * BM25 over the index.
 *
 * A term that appears in most documents contributes almost nothing, because the
 * IDF term is near zero — which is the behaviour we want, and the reason a query
 * like "section 210" still finds its target among 191,000 sections.
 */
export function search(
  index: Bm25Index,
  query: string,
  topK: number,
): ScoredDoc[] {
  const scores = new Map<number, number>();
  for (const token of tokenize(query)) {
    const term = index.termIds.get(token);
    if (term === undefined) continue;
    const idf = Math.log(1 + (index.docCount - index.docFreq[term]! + 0.5) / (index.docFreq[term]! + 0.5));
    const start = index.termStart[term]!;
    const end = index.termStart[term + 1]!;
    for (let p = start; p < end; p++) {
      const docId = index.docIds[p]!;
      const tf = index.tfs[p]!;
      const norm = tf * (K1 + 1);
      const denom = tf + K1 * (1 - B + (B * index.docLen[docId]!) / (index.avgDocLen || 1));
      const contribution = idf * (norm / denom);
      scores.set(docId, (scores.get(docId) ?? 0) + contribution);
    }
  }
  return [...scores.entries()]
    .map(([docId, score]) => ({ docId, score }))
    .sort((a, b) => b.score - a.score || a.docId - b.docId)
    .slice(0, topK);
}
