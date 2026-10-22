#!/usr/bin/env bun
/**
 * Where the answers that cannot be reached actually are.
 *
 * Eight of the thirty-six labelled questions have no answer inside the top
 * fifty, so no amount of reranking reaches them. What matters is *where* they
 * are instead, because the two possibilities need different repairs:
 *
 *   - the correct provision sits at rank 300: the ranking is poor, and the work
 *     is on the embedding side — the query instruction, the tolerance of the
 *     comparison, or the candidate generation;
 *   - the correct provision sits at rank 40,000, or its similarity is below the
 *     provisions that merely share a subject: the provision's text as embedded
 *     does not resemble the question at all, and the work is on how the
 *     document is composed — the title, the truncation of long provisions, or
 *     splitting them.
 *
 * The full ranking is computed, not a top-k, so the rank is the real one.
 *
 *     bun scripts/eval-recall.ts --revision 0507465
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateLabels } from '../src/eval/evaluate';
import { QUESTIONS } from '../src/eval/questions';
import { loadVectorStore, searchVectors } from '../src/eval/retrieval';
import { indexKey } from '../src/ingest/snapshot-format';

const args = process.argv.slice(2);
function arg(flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

const revision = arg('--revision', '');
const dir = arg('--dir', join('dist', 'snapshot'));
if (!revision) {
  console.error('usage: bun scripts/eval-recall.ts --revision <sha> [--dir dist/snapshot]');
  process.exit(2);
}

const indexIds = readFileSync(join(dir, indexKey(revision)), 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => (JSON.parse(line) as { id: string }).id);
const positionOf = new Map(indexIds.map((id, at) => [id, at]));

const store = loadVectorStore(join(dir, `${revision}.store.emb`));
const queryVectors = JSON.parse(readFileSync('dist/eval-query-vectors.gemma.json', 'utf8')) as Record<
  string,
  number[]
>;

interface Row {
  id: string;
  act: string;
  section: string;
}
const small: Row[] = readFileSync('dist/eval-corpus.jsonl', 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as Row);
const { valid } = validateLabels(
  QUESTIONS,
  small.map((row) => ({ act: row.act, section: row.section })),
);

const rounded = (rank: number) =>
  rank <= 10 ? String(rank) : rank <= 1000 ? `${Math.round(rank / 10) * 10}` : `${Math.round(rank / 1000)}k`;

const buckets = { at5: 0, at50: 0, at500: 0, at5000: 0, beyond: 0 };
const rows: { id: string; rank: number; gold: number; top: number; gap: number }[] = [];

console.log(`${store.count} vector(s) of ${store.dims} dimensions\n`);
for (const question of QUESTIONS) {
  const goldIds = new Set((valid.get(question.id) ?? []).map((at) => small[at]!.id));
  const vector = queryVectors[question.id];
  if (goldIds.size === 0 || !vector) continue;

  // The whole ranking, so the rank is the real one and not "past the top k".
  const ranking = searchVectors(store, Float32Array.from(vector), store.count);
  const at = ranking.findIndex((match) => goldIds.has(indexIds[match.docId]!));
  const rank = at === -1 ? store.count : at + 1;
  const gold = at === -1 ? 0 : ranking[at]!.score;
  const top = ranking[0]!.score;

  if (rank <= 5) buckets.at5++;
  else if (rank <= 50) buckets.at50++;
  else if (rank <= 500) buckets.at500++;
  else if (rank <= 5000) buckets.at5000++;
  else buckets.beyond++;

  rows.push({ id: question.id, rank, gold, top, gap: top - gold });
  console.log(
    `  ${question.id.padEnd(34)} ${question.style.padEnd(8)} rank ${rounded(rank).padStart(6)}  ` +
      `gold ${gold.toFixed(3)}  best ${top.toFixed(3)}  gap ${(top - gold).toFixed(3)}`,
  );
}

console.log(`\nwhere the answers are, over ${rows.length} question(s):`);
console.log(`  at rank 5 or better   ${buckets.at5}`);
console.log(`  6 to 50               ${buckets.at50}`);
console.log(`  51 to 500             ${buckets.at500}`);
console.log(`  501 to 5,000          ${buckets.at5000}`);
console.log(`  worse than 5,000      ${buckets.beyond}`);

const misses = rows.filter((row) => row.rank > 50);
if (misses.length > 0) {
  const worst = [...misses].sort((a, b) => b.rank - a.rank).slice(0, 5);
  console.log(`\nthe ${misses.length} answer(s) outside the top 50, worst first:`);
  for (const miss of worst) {
    console.log(`  ${miss.id.padEnd(34)} rank ${rounded(miss.rank).padStart(6)}  gap ${miss.gap.toFixed(3)}`);
  }
  const median = [...misses].sort((a, b) => a.rank - b.rank)[Math.floor(misses.length / 2)]!;
  console.log(`  median rank of the misses: ${rounded(median.rank)}`);
}
