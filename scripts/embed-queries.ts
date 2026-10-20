#!/usr/bin/env bun
/**
 * Embed the evaluation questions.
 *
 * Queries are embedded with the same model as the corpus. A query and a document are
 * not the same kind of input — an instruction-trained embedding model wants a
 * retrieval prompt on the query side — and this script is where that asymmetry
 * would be introduced if the model supported it. BGE-M3 does not, so the same
 * prompt-free encoding is used on both sides here.
 *
 *   bun scripts/embed-queries.ts --endpoint http://127.0.0.1:8799/embed
 */
import { writeFileSync } from 'node:fs';
import { QUESTIONS } from '../src/eval/questions';

const endpoint = process.argv.includes('--endpoint')
  ? process.argv[process.argv.indexOf('--endpoint') + 1]!
  : 'http://127.0.0.1:8799/embed';

const texts = QUESTIONS.map((q) => q.question);
const vectors: number[][] = [];

for (let i = 0; i < texts.length; i += 50) {
  const chunk = texts.slice(i, i + 50);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: chunk }),
  });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as { vectors: number[][] };
  vectors.push(...body.vectors);
  console.log(`  ${Math.min(i + 50, texts.length)}/${texts.length}`);
}

const out: Record<string, number[]> = {};
QUESTIONS.forEach((q, i) => {
  out[q.id] = vectors[i]!;
});
writeFileSync('dist/query-vectors.json', JSON.stringify(out));
console.log(`wrote dist/query-vectors.json — ${vectors.length} query vectors, ${vectors[0]?.length} dims`);
