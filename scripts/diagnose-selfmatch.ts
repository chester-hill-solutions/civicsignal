#!/usr/bin/env bun
/**
 * Give the live index a vector the export says it already holds.
 *
 * The export to R2 was made **by id, positionally, against the snapshot index**,
 * so the vector at a position is the index's own vector for that id. Handing it
 * back is the one test that separates the three possible faults:
 *
 *   - a score near 1 means the index holds it and the **query side** is wrong;
 *   - a score near 0.78, the same as a fresh document embedding, means the index
 *     does not hold it, and the **export** is not a copy of the index;
 *   - a score above 1 or a nonsense ranking would mean the score is not a cosine.
 *
 *     CIVICSIGNAL_KEY=… bun scripts/diagnose-selfmatch.ts
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

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['acts-en-121704', 'acts-en-88695', 'acts-en-203599'];

const index: { id: string }[] = [];
for (const line of readFileSync(`dist/snapshot/${REVISION}.index.jsonl`, 'utf8').split('\n')) {
  if (line.trim()) index.push(JSON.parse(line) as { id: string });
}

console.log('loading the exported store…');
const exported = loadVectorStore(`dist/snapshot/${REVISION}.store.emb`);

async function match(vector: number[], topK = 3): Promise<{ id: string; score: number }[]> {
  const response = await fetch(`${API}/api/match`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ vector, topK, corpus: 'statutes-canada' }),
  });
  if (!response.ok) throw new Error(`match ${response.status}: ${(await response.text()).slice(0, 160)}`);
  return ((await response.json()) as { matches?: { id: string; score: number }[] }).matches ?? [];
}

for (const id of targets) {
  const position = index.findIndex((entry) => entry.id === id);
  if (position === -1) {
    console.log(`${id}: not in the index`);
    continue;
  }
  const vector: number[] = [];
  for (let d = 0; d < exported.dims; d++) vector.push(exported.vectors[position * exported.dims + d]!);

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  const matches = await match(vector);
  console.log(
    `\n${id} (position ${position}, |v| ${norm.toFixed(4)})\n` +
      `  the exported vector finds: ${matches[0]!.score.toFixed(4)} ${matches[0]!.id}` +
      `${matches[0]!.id === id ? '   ✓ itself' : '   ✗ not itself'}\n` +
      `    then                    ${matches[1]?.score.toFixed(4) ?? '—'} ${matches[1]?.id ?? '—'}`,
  );
}
