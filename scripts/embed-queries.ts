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

const argOf = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1] ?? fallback;
};
const endpoint = argOf('--endpoint', 'http://127.0.0.1:8799/embed');
const token = argOf('--token', process.env.ENCODER_TOKEN ?? '');
const model = argOf('--model', '@cf/baai/bge-m3');
const outFile = argOf('--out', 'dist/query-vectors.json');

const texts = QUESTIONS.map((q) => q.question);
const vectors: number[][] = [];

for (let i = 0; i < texts.length; i += 50) {
  const chunk = texts.slice(i, i + 50);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ texts: chunk, model }),
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
writeFileSync(outFile, JSON.stringify(out));
console.log(`wrote ${outFile} — ${vectors.length} query vectors, ${vectors[0]?.length} dims, ${model}`);
