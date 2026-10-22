#!/usr/bin/env bun
/**
 * Which answerable questions does the **floor** refuse?
 *
 * The relevance floor is the refusal for a deployment with no key for the
 * inference gateway. It is a score, so it cannot tell "the corpus has a
 * provision about this" from "the corpus has the provision that answers this" —
 * and the two halves of the labelled set separate cleanly:
 *
 *   - the **exact** questions use the statute's own words, and their best score
 *     is high;
 *   - the **concept** questions describe a circumstance in ordinary language,
 *     and their best score is low, even when the answer is in the ranking.
 *
 * So the floor refuses most of the ordinary-language half, and Jev is what
 * answers it. That is the measurement below, and it is the reason the rerank
 * is in the search path rather than beside it.
 *
 * The score here comes from the **evaluation corpus**, which is 19,021 sections.
 * The live index holds 277,857, and a larger corpus gives a question a higher
 * best score, so these numbers are a bound and not the production result.
 * `scripts/production-floor.ts` measures the live index.
 *
 *     bun scripts/floor-refusals.ts [--store X.emb] [--rows X.rows.json] [--queries X.json]
 */
import { readFileSync } from 'node:fs';
import { QUESTIONS } from '../src/eval/questions';
import { loadVectorStore, searchVectors } from '../src/eval/retrieval';

const args = process.argv.slice(2);
const arg = (flag: string, fallback: string): string => {
  const at = args.indexOf(flag);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};

const storePath = arg('--store', 'dist/eval-corpus.gemmagpu.emb');
const rowsPath = arg('--rows', 'dist/eval-corpus.gemmagpu.rows.json');
const queriesPath = arg('--queries', 'dist/query-vectors.gemmagpu.json');
const floor = Number(arg('--floor', '0.81'));
// The default is a **cosine**, because the evaluation corpus holds cosines. The
// live index does not, and its threshold is 0.62 — see `VECTOR_FLOOR`. Do not
// carry this default across.

const store = loadVectorStore(storePath);
const storeIds = JSON.parse(readFileSync(rowsPath, 'utf8')) as string[];

/** Row id → { act, section }, from the corpus file. */
const meta = new Map<string, { act: string; section: string }>();
for (const line of readFileSync('dist/eval-corpus.jsonl', 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const row = JSON.parse(line) as { id: string; act: string; section: string };
  meta.set(row.id, { act: row.act, section: row.section });
}

const queries = JSON.parse(readFileSync(queriesPath, 'utf8')) as Record<string, number[]>;

console.log(`${store.count} vector(s), ${storeIds.length} id(s), floor ${floor}\n`);
console.log('question                                    best     gold-rank   the floor');
const refusals: string[] = [];
const refusedByStyle: Record<string, { refused: number; total: number }> = {};
for (const question of QUESTIONS) {
  const vector = queries[question.id];
  if (!vector) {
    console.log(`${question.id.padEnd(42)} — no query vector`);
    continue;
  }
  const query = Float32Array.from(vector);
  const best = searchVectors(store, query, 1)[0]!;

  // The gold row: the corpus row whose act and section match the label.
  const goldStoreAt = storeIds.findIndex((id) => {
    const row = meta.get(id);
    return row !== undefined && row.act === question.act && row.section === question.section;
  });
  const top5 = searchVectors(store, query, 5).map((entry) => entry.docId);
  const rank = goldStoreAt === -1 ? null : top5.indexOf(goldStoreAt) + 1 || null;

  const refuses = best.score < floor;
  const tally = (refusedByStyle[question.style] ??= { refused: 0, total: 0 });
  tally.total++;
  if (refuses) {
    refusals.push(question.id);
    tally.refused++;
  }
  console.log(
    `${question.id.padEnd(42)} ${best.score.toFixed(4)}   ${
      String(rank ?? '—').padEnd(9)
    } ${refuses ? 'FLOOR REFUSES' : ''}`,
  );
}

console.log(`\n${refusals.length} answerable question(s) below the floor:`);
for (const id of refusals) {
  const question = QUESTIONS.find((q) => q.id === id)!;
  console.log(`  ${id}\n    ${question.question}`);
}
for (const style of Object.keys(refusedByStyle)) {
  const tally = refusedByStyle[style]!;
  console.log(`\n${style}: ${tally.refused} of ${tally.total} refused by the floor`);
}

