#!/usr/bin/env bun
/**
 * Which local embedding run does the live index hold?
 *
 * Three runs of EmbeddingGemma 2 are on disk, all over the same 19,021 rows:
 * `gemma`, `gemma300`, and `gemmagpu`. The live index agrees with the current
 * recipe at about 0.82, which is neither 1.0 nor noise, so the question is
 * which run it does agree with.
 *
 * The comparison is local and pairwise over the same rows, so nothing is
 * confounded by the corpus or by the query instruction.
 *
 *     bun scripts/compare-runs.ts
 */
import { loadVectorStore, type VectorStore } from '../src/eval/retrieval';

const runs = [
  { name: 'gemma', path: 'dist/eval-corpus.gemma.emb' },
  { name: 'gemma300', path: 'dist/eval-corpus.gemma300.emb' },
  { name: 'gemmagpu', path: 'dist/eval-corpus.gemmagpu.emb' },
];

const stores = new Map<string, VectorStore>();
for (const run of runs) stores.set(run.name, loadVectorStore(run.path));

function cosAt(a: VectorStore, at: number, b: VectorStore, bt: number): number {
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let d = 0; d < a.dims; d++) {
    const x = a.vectors[at * a.dims + d]!;
    const y = b.vectors[bt * b.dims + d]!;
    dot += x * y;
    an += x * x;
    bn += y * y;
  }
  return dot / (Math.sqrt(an) * Math.sqrt(bn) || 1);
}

/** The same row, in the same place, across runs — a few at even spacing. */
const rowCount = stores.get('gemma')!.count;
const positions: number[] = [];
for (let i = 1; i <= 12; i++) positions.push(Math.floor((rowCount / 13) * i));

console.log(`${rowCount} row(s) per run, compared at ${positions.length} positions\n`);
console.log('positions   gemma/gemma300   gemma/gemmagpu   gemma300/gemmagpu');
for (const at of positions) {
  const row = [
    cosAt(stores.get('gemma')!, at, stores.get('gemma300')!, at).toFixed(4),
    cosAt(stores.get('gemma')!, at, stores.get('gemmagpu')!, at).toFixed(4),
    cosAt(stores.get('gemma300')!, at, stores.get('gemmagpu')!, at).toFixed(4),
  ];
  console.log(`${String(at).padStart(8)}   ${row.map((value) => value.padStart(13)).join('  ')}`);
}

function mean(pair: [string, string]): number {
  let sum = 0;
  for (const at of positions) {
    sum += cosAt(stores.get(pair[0])!, at, stores.get(pair[1])!, at);
  }
  return sum / positions.length;
}
console.log('\nthe means');
for (const pair of [
  ['gemma', 'gemma300'],
  ['gemma', 'gemmagpu'],
  ['gemma300', 'gemmagpu'],
] as [string, string][]) {
  console.log(`  ${pair.join(' / ').padEnd(22)} ${mean(pair).toFixed(4)}`);
}
