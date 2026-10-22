#!/usr/bin/env bun
/**
 * Are the exported vectors the same vectors as the evaluation corpus's?
 *
 * Two runs of EmbeddingGemma 2 exist in this project: the one that filled the
 * live index (exported to R2) and the one that filled the evaluation corpus.
 * They can only be compared through a shared text, and the corpus row is that
 * text: `embeddableText`, in both cases.
 *
 * The comparison is local. Nothing here talks to Vectorize, so if the two agree
 * and the live score is still low, the score itself — not the vectors — is what
 * disagrees.
 *
 *     bun scripts/compare-stores.ts [--id acts-en-121704]
 */
import { readFileSync } from 'node:fs';
import { embeddableText } from '../src/ingest/pipeline';
import { loadVectorStore } from '../src/eval/retrieval';

const args = process.argv.slice(2);
const arg = (flag: string, fallback: string): string => {
  const at = args.indexOf(flag);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};

const REVISION = arg('--revision', '0507465393c224c0491fc8c17c88340217acc656');
const wanted = args.filter((value) => value.startsWith('acts-') || value.startsWith('regulations-'));

/** The index, in the order the exported vectors are in. */
const index: { id: string; fp: string; off: number; len: number }[] = [];
for (const line of readFileSync(`dist/snapshot/${REVISION}.index.jsonl`, 'utf8').split('\n')) {
  if (line.trim()) index.push(JSON.parse(line) as { id: string; fp: string; off: number; len: number });
}

console.log('loading the exported store (853 MB)…');
const exported = loadVectorStore(`dist/snapshot/${REVISION}.store.emb`);
console.log(`  ${exported.count} vector(s) of ${exported.dims} dimensions`);

/** The evaluation corpus: the text, and the vector beside it. */
interface EvalRow {
  id: string;
  act: string;
  section: string;
  heading: string | null;
  text: string;
  instrument?: string;
}
const evalRows: EvalRow[] = [];
for (const line of readFileSync('dist/eval-corpus.jsonl', 'utf8').split('\n')) {
  if (line.trim()) evalRows.push(JSON.parse(line) as EvalRow);
}
const evalIds = JSON.parse(readFileSync('dist/eval-corpus.gemmagpu.rows.json', 'utf8')) as string[];
const evalStore = loadVectorStore('dist/eval-corpus.gemmagpu.emb');
const evalAt = new Map(evalIds.map((id, at) => [id, at]));

function cosineAt(store: ReturnType<typeof loadVectorStore>, at: number, other: number[]): number {
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let d = 0; d < store.dims; d++) {
    const value = store.vectors[at * store.dims + d]!;
    dot += value * other[d]!;
    an += value * value;
    bn += other[d]! * other[d]!;
  }
  return dot / (Math.sqrt(an) * Math.sqrt(bn) || 1);
}

function exportedVector(position: number): number[] {
  const out: number[] = [];
  for (let d = 0; d < exported.dims; d++) out.push(exported.vectors[position * exported.dims + d]!);
  return out;
}

/** The row's text in the exported corpus, for the title of the comparison. */
const targets =
  wanted.length > 0
    ? wanted
    : ['acts-en-121704', 'acts-en-88695', 'acts-en-203599'];

for (const id of targets) {
  const position = index.findIndex((entry) => entry.id === id);
  if (position === -1) {
    console.log(`\n${id}: not in the exported index`);
    continue;
  }
  const vector = exportedVector(position);

  // The evaluation corpus is addressed by the provision, not by the exported id,
  // so the match is on the nearest neighbour inside the evaluation store. If the
  // two runs agree, the exported vector's best match among the evaluation
  // vectors is the same provision, at a cosine near 1.
  let bestAt = -1;
  let best = -1;
  for (let at = 0; at < evalStore.count; at++) {
    const score = cosineAt(evalStore, at, vector);
    if (score > best) {
      best = score;
      bestAt = at;
    }
  }
  const neighbour = evalRows.find((row) => row.id === evalIds[bestAt]);
  console.log(
    `\n${id} (position ${position})\n  best match in the evaluation store: ${best.toFixed(4)}  ` +
      `${neighbour ? `${neighbour.act} s. ${neighbour.section}${neighbour.heading ? ` — ${neighbour.heading}` : ''}` : evalIds[bestAt]}`,
  );
}

/** A sanity anchor: the median self-agreement inside the evaluation store. */
let sum = 0;
let counted = 0;
for (let at = 0; at < Math.min(evalStore.count, 40); at++) {
  const own: number[] = [];
  for (let d = 0; d < evalStore.dims; d++) own.push(evalStore.vectors[at * evalStore.dims + d]!);
  sum += cosineAt(evalStore, at, own);
  counted++;
}
console.log(`\nthe evaluation store's self-cosine, over ${counted} vector(s): mean ${(sum / counted).toFixed(6)}`);
console.log(`embeddableText is available: ${typeof embeddableText === 'function'}`);
