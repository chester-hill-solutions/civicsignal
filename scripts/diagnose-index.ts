#!/usr/bin/env bun
/**
 * Which side of the search disagrees with the evaluation?
 *
 * The live index gives every question a best cosine about 0.15 lower than the
 * evaluation corpus does. A larger corpus cannot lower a best score, so one of
 * two things is true, and they are different faults:
 *
 *   1. **the query side** — the production encoder puts the question somewhere
 *      other than the evaluation encoder did;
 *   2. **the document side** — the vectors in the live index are not the vectors
 *      in the evaluation corpus store.
 *
 * The test separates them without a document vector. An evaluation query vector
 * goes straight to `/api/match`, so the production index answers it directly:
 *
 *   - if the score matches the evaluation's own score, the index is the same
 *     space and the query side is the difference;
 *   - if the score is low, the index holds different document vectors.
 *
 *     CIVICSIGNAL_KEY=… bun scripts/diagnose-index.ts
 */
import { readFileSync } from 'node:fs';

const API = 'https://api.civicsignal.chesterhillsolutions.ca';
const ENCODER = 'https://civicsignal-encoder.chester-hill-solutions.workers.dev/embed-query';
const apiKey = process.env.CIVICSIGNAL_KEY ?? '';
if (!apiKey) {
  console.error('set CIVICSIGNAL_KEY');
  process.exit(1);
}
const encoderToken = readFileSync(`${process.env.HOME ?? '.'}/.civicsignal/encoder-token`, 'utf8').trim();

const ids = process.argv.slice(2);
const targets =
  ids.length > 0
    ? ids
    : ['exact-cc-theft', 'exact-cea-ordinary-residence', 'concept-fix-prices', 'un-prov-tenancy'];

const queries = JSON.parse(readFileSync('dist/query-vectors.gemmagpu.json', 'utf8')) as Record<
  string,
  number[]
>;
const { QUESTIONS, UNANSWERABLE_QUESTIONS } = await import('../src/eval/questions');
const questionOf = (id: string): string =>
  QUESTIONS.find((q) => q.id === id)?.question ??
  UNANSWERABLE_QUESTIONS.find((q) => q.id === id)?.question ??
  '';

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let d = 0; d < a.length; d++) {
    dot += a[d]! * b[d]!;
    na += a[d]! * a[d]!;
    nb += b[d]! * b[d]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function match(vector: number[], topK = 3): Promise<{ id: string; score: number }[]> {
  const response = await fetch(`${API}/api/match`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ vector, topK, corpus: 'statutes-canada' }),
  });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
  return ((await response.json()) as { matches?: { id: string; score: number }[] }).matches ?? [];
}

async function embedQuery(text: string): Promise<number[]> {
  const response = await fetch(ENCODER, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${encoderToken}` },
    body: JSON.stringify({ texts: [text] }),
  });
  if (!response.ok) throw new Error(`encoder ${response.status}`);
  return ((await response.json()) as { vectors: number[][] }).vectors[0]!;
}

console.log('id                                  eval-vs-container   index(eval q)   index(container q)');
for (const id of targets) {
  const question = questionOf(id);
  const evalVector = queries[id];
  if (!evalVector || !question) {
    console.log(`${id}: no query vector or no question`);
    continue;
  }
  const containerVector = await embedQuery(question);
  const agreement = cosine(evalVector, containerVector);
  const fromEval = (await match(evalVector))[0]!;
  const fromContainer = (await match(containerVector))[0]!;
  console.log(
    `${id.padEnd(35)} ${agreement.toFixed(4).padStart(10)}        ` +
      `${fromEval.score.toFixed(4)} ${fromEval.id.padEnd(22)} ` +
      `${fromContainer.score.toFixed(4)} ${fromContainer.id}`,
  );
}
