#!/usr/bin/env bun
/**
 * What does Vectorize's `score` actually measure?
 *
 * A vector the index holds finds itself at 0.826, and a query finds the right
 * provision at 0.63 where the same vector scores 0.82 against a local store. The
 * ranking is right in both cases, so the disagreement is in the **scale** of the
 * score, not in the order.
 *
 * Three sends separate the possibilities, with no local vector needed:
 *
 *   v    the recorded score
 *   -v   a cosine gives about -v; a score mapped into [0,1] gives about 1 - v
 *   2v   a cosine is unchanged; a raw dot product doubles
 *
 *     CIVICSIGNAL_KEY=… bun scripts/diagnose-score.ts
 */
import { readFileSync } from 'node:fs';
import { loadVectorStore } from '../src/eval/retrieval';

const API = 'https://api.civicsignal.chesterhillsolutions.ca';
const REVISION = '0507465393c224c0491fc8c17c88340217acc656';
const apiKey = process.env.CIVICSIGNAL_KEY ?? '';
if (!apiKey) {
  console.error('set CIVICSIGNAL_KEY');
  process.exit(1);
}

const index: { id: string }[] = [];
for (const line of readFileSync(`dist/snapshot/${REVISION}.index.jsonl`, 'utf8').split('\n')) {
  if (line.trim()) index.push(JSON.parse(line) as { id: string });
}
console.log('loading the exported store…');
const exported = loadVectorStore(`dist/snapshot/${REVISION}.store.emb`);

const id = process.argv[2] ?? 'acts-en-121704';
const position = index.findIndex((entry) => entry.id === id);
const base: number[] = [];
for (let d = 0; d < exported.dims; d++) base.push(exported.vectors[position * exported.dims + d]!);

async function match(vector: number[], topK = 2): Promise<{ id: string; score: number }[]> {
  const response = await fetch(`${API}/api/match`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ vector, topK, corpus: 'statutes-canada' }),
  });
  if (!response.ok) throw new Error(`match ${response.status}`);
  return ((await response.json()) as { matches?: { id: string; score: number }[] }).matches ?? [];
}

const variants: [string, number[]][] = [
  ['v   ', base],
  ['-v  ', base.map((value) => -value)],
  ['2v  ', base.map((value) => 2 * value)],
  ['0.5v', base.map((value) => 0.5 * value)],
];

console.log(`\nthe exported vector for ${id}, sent four ways (top hit each time)\n`);
for (const [label, vector] of variants) {
  const matches = await match(vector);
  console.log(
    `  ${label}  ${matches[0]!.score.toFixed(4).padStart(9)} ${matches[0]!.id.padEnd(20)} ` +
      `second ${matches[1]?.score.toFixed(4) ?? '—'}`,
  );
}
