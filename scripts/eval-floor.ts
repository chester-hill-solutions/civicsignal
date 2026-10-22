#!/usr/bin/env bun
/**
 * Can the product honestly say "I don't have information on that"?
 *
 * The query path has a lexical fallback that runs when the vector arm returns
 * **nothing** — and that condition is the thing this measures, because a vector
 * search over a quarter of a million provisions never returns nothing. Ask for
 * fifty and it returns fifty, ranked. So "the vector arm found nothing" does
 * not happen, the fallback is unreachable, and the product's answer to a
 * question the corpus cannot answer is fifty provisions about something else.
 *
 * What can honestly say it is a **floor on the score**: the best match's
 * similarity, below which the product says it does not know. That is a
 * decision with a cost on both sides — too high and it refuses questions it
 * could have answered, too low and it answers questions it should not — so it
 * has to be measured rather than chosen.
 *
 * And the measurement answers the question the fallback was for: **when the
 * floor says "not found", does the keyword arm find the answer anyway?** If it
 * does, the fallback earns its place and `search_text` stays. If it does not,
 * the fallback is a second search that never helps, and the column it searches
 * — 250 MB of folded text on a 232 MB corpus — can go.
 *
 *     bun scripts/eval-floor.ts --corpus dist/eval-corpus.jsonl \
 *          --vectors dist/eval-corpus.matched.emb \
 *          --queries dist/eval-query-vectors.matched.json
 */
import { existsSync, readFileSync } from 'node:fs';
import { buildIndex, search } from '../src/eval/bm25';
import { validateLabels } from '../src/eval/evaluate';
import { QUESTIONS } from '../src/eval/questions';
import { loadVectorStore, searchVectors } from '../src/eval/retrieval';

const args = process.argv.slice(2);
function arg(flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

const corpusPath = arg('--corpus', 'dist/eval-corpus.jsonl');
const vectorsPath = arg('--vectors', 'dist/eval-corpus.matched.emb');
const queriesPath = arg('--queries', 'dist/eval-query-vectors.matched.json');
const topK = Number(arg('--topk', '50'));

for (const path of [corpusPath, vectorsPath, queriesPath]) {
  if (!existsSync(path)) {
    console.error(`missing ${path}`);
    process.exit(1);
  }
}

interface Row {
  id: string;
  act: string;
  section: string;
  heading: string | null;
  text: string;
  status?: string;
}

const rows: Row[] = [];
for (const line of readFileSync(corpusPath, 'utf8').split('\n')) {
  if (line.trim()) rows.push(JSON.parse(line) as Row);
}

const { valid, issues } = validateLabels(
  QUESTIONS,
  rows.map((row) => ({ act: row.act, section: row.section })),
);
if (issues.length) console.log(`${issues.length} label issue(s)`);
const usable = QUESTIONS.filter((question) => valid.has(question.id));

console.log(`building the keyword index over ${rows.length} section(s)…`);
const index = buildIndex(rows.map((row) => [row.act, row.heading ?? '', row.text].filter(Boolean).join('\n')));

const store = loadVectorStore(vectorsPath);
const manifestPath = vectorsPath.replace(/\.emb$/, '') + '.rows.json';
const byId = new Map(rows.map((row, at) => [row.id, at]));
const vectorToRow = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as string[]).map((id) => byId.get(id)!)
  : rows.map((_, at) => at);
console.log(`  ${store.count} vector(s) of ${store.dims} dimensions, ${usable.length} question(s)`);

const queryVectors = JSON.parse(readFileSync(queriesPath, 'utf8')) as Record<string, number[]>;

/** One question, measured. */
interface Measured {
  id: string;
  style: string;
  question: string;
  /** The best similarity the vector arm found, and the id of the row it found. */
  topScore: number;
  topRow: string;
  /** Where the gold answer is in the vector ranking, or null. */
  vectorRank: number | null;
  /** The gold answer's own similarity, when it is in the ranking at all. */
  goldScore: number | null;
  /** Where the gold answer is in the keyword ranking, or null. */
  keywordRank: number | null;
}

const measured: Measured[] = [];
for (const question of usable) {
  const gold = new Set(valid.get(question.id)!);
  const vector = searchVectors(store, Float32Array.from(queryVectors[question.id]!), topK).map(
    (entry) => ({ docId: vectorToRow[entry.docId] ?? entry.docId, score: entry.score }),
  );
  const keyword = search(index, question.question, topK);

  const vectorAt = vector.findIndex((entry) => gold.has(entry.docId));
  const keywordAt = keyword.findIndex((entry) => gold.has(entry.docId));
  measured.push({
    id: question.id,
    style: question.style,
    question: question.question,
    topScore: vector[0]?.score ?? 0,
    topRow: vector[0] ? `${rows[vector[0].docId]!.act} s.${rows[vector[0].docId]!.section}` : '—',
    vectorRank: vectorAt === -1 ? null : vectorAt + 1,
    goldScore: vectorAt === -1 ? null : vector[vectorAt]!.score,
    keywordRank: keywordAt === -1 ? null : keywordAt + 1,
  });
}

const hit = (rank: number | null, at: number) => rank !== null && rank <= at;
const pct = (n: number, of: number) => `${((n / Math.max(1, of)) * 100).toFixed(0)}%`;

console.log('\nthe two arms, as they are');
for (const style of ['exact', 'concept'] as const) {
  const set = measured.filter((m) => m.style === style);
  const v5 = set.filter((m) => hit(m.vectorRank, 5)).length;
  const k5 = set.filter((m) => hit(m.keywordRank, 5)).length;
  console.log(
    `  ${style.padEnd(8)} ${set.length} question(s): vector R@5 ${v5} (${pct(v5, set.length)}), ` +
      `keyword R@5 ${k5} (${pct(k5, set.length)})`,
  );
}

/**
 * The floor.
 *
 * "Found" means the best similarity is at or above the threshold. A question
 * the vector arm got right is a **true positive** if the floor keeps it, and a
 * question it got wrong is a **false positive** if the floor keeps it — the
 * product answering confidently about something else.
 */
console.log('\nthe floor: what each threshold would do');
console.log('  threshold   kept   kept-and-right   kept-and-wrong   refused-but-answerable');
const scores = measured.map((m) => m.topScore).sort((a, b) => a - b);
const thresholds = [
  ...new Set([
    ...scores.filter((_, at) => at % Math.max(1, Math.floor(scores.length / 12)) === 0),
    scores[scores.length - 1]!,
  ]),
].sort((a, b) => a - b);

/** How the fallback would fare for the questions the floor refuses. */
let refused = 0;
let refusedAnswerable = 0;
let refusedRescuedByKeyword = 0;

for (const threshold of thresholds) {
  const kept = measured.filter((m) => m.topScore >= threshold);
  const right = kept.filter((m) => hit(m.vectorRank, 5));
  const wrong = kept.filter((m) => !hit(m.vectorRank, 5));
  // "Refused but answerable" is the cost of the floor: the answer was in the
  // ranking and the floor threw it away.
  const refusedAnswerableHere = measured.filter(
    (m) => m.topScore < threshold && hit(m.vectorRank, 5),
  );
  console.log(
    `  ${threshold.toFixed(4)}   ${String(kept.length).padStart(4)}   ` +
      `${String(right.length).padStart(14)}   ${String(wrong.length).padStart(15)}   ` +
      `${String(refusedAnswerableHere.length).padStart(23)}`,
  );
}

// The decision the doc is for: at a threshold that refuses the questions the
// vector arm cannot answer, is there anything for a keyword search to rescue?
console.log('\nwhat the keyword arm would rescue');
for (const threshold of thresholds) {
  const refusedHere = measured.filter((m) => m.topScore < threshold);
  const rescued = refusedHere.filter((m) => hit(m.keywordRank, 5));
  if (refusedHere.length === 0) continue;
  console.log(
    `  floor ${threshold.toFixed(4)}: refuses ${refusedHere.length} question(s), ` +
      `and the keyword arm finds the answer in its top 5 for ${rescued.length} of them` +
      (rescued.length > 0 ? ` — ${rescued.slice(0, 4).map((m) => m.id).join(', ')}` : ''),
  );
  if (threshold === thresholds[Math.floor(thresholds.length / 2)]!) {
    refused = refusedHere.length;
    refusedRescuedByKeyword = rescued.length;
    refusedAnswerable = refusedHere.filter((m) => hit(m.vectorRank, 5)).length;
  }
}

/**
 * The other side of the same question, and the one that is easiest to miss:
 * the keyword arm finds the answer for some questions the vector arm **also**
 * finds. Those are not a fallback's doing — they are two arms doing the same
 * work, which is what the hybrid already measures.
 */
const vectorMisses = measured.filter((m) => !hit(m.vectorRank, 5));
const rescued = vectorMisses.filter((m) => hit(m.keywordRank, 5));
console.log(
  `\nthe vector arm misses ${vectorMisses.length} of ${measured.length} at rank 5, and the ` +
    `keyword arm finds ${rescued.length} of those in its top 5`,
);
for (const miss of vectorMisses) {
  console.log(
    `  ${miss.style.padEnd(8)} ${miss.id.padEnd(34)} vector ${miss.vectorRank ?? '—'} / keyword ${
      miss.keywordRank ?? '—'
    }  top score ${miss.topScore.toFixed(4)}`,
  );
}

const answerable = measured.filter((m) => hit(m.vectorRank, 5)).length;
console.log(
  `\nthe vector arm answers ${answerable} of ${measured.length}; the keyword arm rescues ` +
    `${rescued.length} of the ${vectorMisses.length} it does not`,
);
console.log(
  `at the middle floor, ${refused} question(s) are refused, ${refusedAnswerable} of which the ` +
    `vector arm could have answered, and the keyword arm rescues ${refusedRescuedByKeyword}`,
);
