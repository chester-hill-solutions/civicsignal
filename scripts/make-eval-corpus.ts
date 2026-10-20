#!/usr/bin/env bun
/**
 * Build a scoped corpus for the retrieval evaluation.
 *
 * The evaluation asks whether a vector arm beats the keyword baseline on concept
 * questions. That question is answered on a corpus that contains the gold answers
 * *and* a realistic number of distractors — it does not need all 191,025 sections
 * of federal law, and waiting an hour for the whole corpus to embed is the wrong
 * trade for a question that has a verdict in minutes.
 *
 * The scope is derived from the labelled set, not hard-coded: every Act the
 * questions name is included in full, and the rest is a random sample of other
 * sections as distractors. Both the corpus and the vector store are written in the
 * same row order, so a vector's index is its row's index.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { QUESTIONS } from '../src/eval/questions';

const args = process.argv.slice(2);
const argOf = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1] ?? fallback;
};
const out = argOf('--out', 'dist/eval-corpus.jsonl');
const distractors = Number(argOf('--distractors', '15000'));
const corpusPath = argOf('--corpus', 'dist/statutes.jsonl');

const wanted = new Set(QUESTIONS.map((q) => q.act));
console.log(`corpora the labelled set touches: ${[...wanted].join(', ')}`);

const all: Record<string, unknown>[] = [];
for (const line of readFileSync(corpusPath, 'utf8').split('\n')) {
  if (line.trim()) all.push(JSON.parse(line));
}

const keep: Record<string, unknown>[] = [];
for (const row of all) {
  if (wanted.has(String(row['act']))) keep.push(row);
}
const included = new Set(keep.map((r) => String(r['id'])));
console.log(`  ${keep.length} section(s) from those corpora`);

const pool = all.filter((r) => !included.has(String(r['id'])));
// A deterministic sample, so a run is reproducible.
let seed = 20261020;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const take = Math.min(distractors, pool.length);
for (let i = 0; i < take; i++) {
  keep.push(pool[Math.floor(rand() * pool.length)]!);
}
console.log(`  ${take} distractor section(s) sampled from ${pool.length.toLocaleString()} others`);

writeFileSync(out, keep.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`wrote ${out} — ${keep.length} rows`);

// The gold answers must survive the sample, or the evaluation is measuring nothing.
const goldIds = new Set(keep.map((r) => String(r['id'])));
let missing = 0;
for (const q of QUESTIONS) {
  const rows = keep.filter((r) => r['act'] === q.act && r['section'] === q.section);
  if (rows.length === 0) {
    console.error(`  MISSING gold answer for ${q.id}: ${q.act} s.${q.section}`);
    missing++;
  }
}
if (missing > 0) {
  console.error(`${missing} gold answer(s) are not in the scoped corpus`);
  process.exit(1);
}
console.log(`  all ${QUESTIONS.length} gold answers are present`);
void goldIds;
