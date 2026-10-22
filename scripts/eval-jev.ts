#!/usr/bin/env bun
/**
 * Jev as a reranker, measured against the vector arm's own ranking.
 *
 * The vector arm finds the right provision in the top 5 for about 22 of the 36
 * labelled questions. A reranker can only reorder what it is given, so the
 * experiment is deliberately narrow: take the vector arm's top N candidates and
 * ask Jev to order them, then compare the two orderings over the same set.
 * That isolates the effect of ranking from the effect of recall.
 *
 * Every request carries one `noul` per candidate, plus `any_relevant`. The
 * second one is the interesting half of the experiment in the long run: a
 * sorted list always has a top entry, even when nothing fits, and `any_relevant`
 * is a calibrated answer to "does any of these fit", which is the question the
 * product currently asks of a raw cosine threshold.
 *
 *     JEV_KEY=... bun scripts/eval-jev.ts 20
 */
import { readFileSync } from 'node:fs';
import { validateLabels } from '../src/eval/evaluate';
import { QUESTIONS, UNANSWERABLE_QUESTIONS } from '../src/eval/questions';
import { loadVectorStore, searchVectors } from '../src/eval/retrieval';
import { ENCODER_CONTRACT, queryText } from '../src/encoder';

const KEY = process.env.JEV_KEY ?? '';
if (!KEY) {
  console.error('JEV_KEY is not set');
  process.exit(2);
}
const ENDPOINT = 'https://opencode.ai/inference/systemone/v1/systemone';
const MODEL = 'jev-1.13';
const TOPK = Number(process.argv[2] ?? 20);

interface Row {
  id: string;
  act: string;
  section: string;
  heading: string | null;
  text: string;
}

const rows: Row[] = readFileSync('dist/eval-corpus.jsonl', 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as Row);
const store = loadVectorStore('dist/eval-corpus.gemmagpu.emb');
const manifest = JSON.parse(readFileSync('dist/eval-corpus.gemmagpu.rows.json', 'utf8')) as string[];
const rowOf = new Map(rows.map((row, at) => [row.id, at]));
const vectorToRow = manifest.map((id) => rowOf.get(id)!);
const queryVectors = JSON.parse(readFileSync('dist/eval-query-vectors.gemma.json', 'utf8')) as Record<
  string,
  number[]
>;

const { valid } = validateLabels(
  QUESTIONS,
  rows.map((row) => ({ act: row.act, section: row.section })),
);
const usable = QUESTIONS.filter((question) => valid.has(question.id));

/**
 * One provision, as Jev sees it.
 *
 * Truncated, because what decides is the provision's own words and the title
 * that identifies it; the tail of a four-megabyte regulation would crowd out
 * the other nineteen candidates and decide nothing.
 */
function excerpt(row: Row): string {
  return `${row.act}, section ${row.section}${row.heading ? ` (${row.heading})` : ''}\n${row.text.slice(0, 1200)}`;
}

async function ask(
  query: string,
  candidates: Row[],
): Promise<{ relevance: number[]; anyRelevant: number; tokens: number }> {
  const questions: Record<string, unknown> = {};
  candidates.forEach((_, at) => {
    questions[`c${at}`] = {
      type: 'noul',
      instructions:
        `Does provision c${at} answer the question? Score high if it states the rule the ` +
        `question asks about, low if it is about a different subject.`,
    };
  });
  questions['any_relevant'] = {
    type: 'noul',
    instructions: 'Does any provision below answer the question?',
  };
  const state = [
    ...candidates.map((row, at) => `c${at}: ${excerpt(row)}`),
    `question: ${query}`,
  ].join('\n\n');

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, state, questions }),
  });
  if (!response.ok) {
    throw new Error(`the gateway refused: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  const body = (await response.json()) as {
    answers: Record<string, { noul?: number }>;
    usage?: { input_tokens?: number };
  };
  return {
    relevance: candidates.map((_, at) => body.answers[`c${at}`]?.noul ?? 0),
    anyRelevant: body.answers['any_relevant']?.noul ?? 0,
    tokens: body.usage?.input_tokens ?? 0,
  };
}

const hit = (rank: number | null, k: number) => rank !== null && rank <= k;

let vectorAt1 = 0;
let vectorAt5 = 0;
let jevAt1 = 0;
let jevAt5 = 0;
let vectorReciprocal = 0;
let jevReciprocal = 0;
let reachable = 0;
let tokens = 0;
/** The answerable set's own `any_relevant`, for the comparison below. */
const answerableAnyRelevant: number[] = [];
const recovered: string[] = [];
const lost: string[] = [];

for (const question of usable) {
  const gold = new Set(valid.get(question.id)!);
  const matches = searchVectors(store, Float32Array.from(queryVectors[question.id]!), TOPK).map(
    (match) => vectorToRow[match.docId] ?? match.docId,
  );
  const candidates = matches.map((rowAt) => rows[rowAt]!);

  const goldPositions = matches
    .map((rowAt, at) => (gold.has(rowAt) ? at : -1))
    .filter((at) => at >= 0);
  // Not in the candidate set at all: no reranker can reach it, so it is not
  // part of this experiment.
  if (goldPositions.length === 0) continue;
  reachable++;

  const vectorRank = Math.min(...goldPositions) + 1;
  const { relevance, anyRelevant, tokens: used } = await ask(question.question, candidates);
  tokens += used;
  answerableAnyRelevant.push(anyRelevant);

  const order = candidates
    .map((_, at) => at)
    .sort((a, b) => relevance[b]! - relevance[a]! || a - b);
  const jevAt = order.findIndex((at) => gold.has(matches[at]!));
  const jevRank = jevAt === -1 ? null : jevAt + 1;

  if (hit(vectorRank, 1)) vectorAt1++;
  if (hit(vectorRank, 5)) vectorAt5++;
  if (hit(jevRank, 1)) jevAt1++;
  if (hit(jevRank, 5)) jevAt5++;
  vectorReciprocal += 1 / vectorRank;
  if (jevRank) jevReciprocal += 1 / jevRank;

  if (!hit(vectorRank, 5) && hit(jevRank, 5)) recovered.push(`${question.id} (${vectorRank} to ${jevRank})`);
  if (hit(vectorRank, 5) && !hit(jevRank, 5)) lost.push(`${question.id} (${vectorRank} to ${jevRank})`);

  console.log(
    `  ${question.id.padEnd(34)} ${question.style.padEnd(8)} ` +
      `vector ${String(vectorRank).padStart(2)} to jev ${String(jevRank).padStart(2)}` +
      `   any_relevant ${anyRelevant.toFixed(2)}`,
  );
}

console.log(`\nwithin the top ${TOPK}: ${reachable} question(s) have their answer in the set`);
console.log(
  `  vector   R@1 ${vectorAt1}/${reachable}   R@5 ${vectorAt5}/${reachable}   MRR ${(vectorReciprocal / reachable).toFixed(3)}`,
);
console.log(
  `  jev      R@1 ${jevAt1}/${reachable}   R@5 ${jevAt5}/${reachable}   MRR ${(jevReciprocal / reachable).toFixed(3)}`,
);
console.log(`  recovered by jev: ${recovered.length ? recovered.join(', ') : 'none'}`);
console.log(`  lost by jev:      ${lost.length ? lost.join(', ') : 'none'}`);
console.log(`  ${tokens} input tokens`);

/* -------------------------------------------------------------------------- */
/* The refusal, which is what the floor cannot decide well                     */
/* -------------------------------------------------------------------------- */

/**
 * The twelve questions the corpus cannot answer, through Jev.
 *
 * The product decides "I don't have information on that" by thresholding a raw
 * cosine at `VECTOR_FLOOR`. That number is global, and a cosine is not
 * calibrated: the same value means different things for different questions.
 * `any_relevant` is a calibrated answer to the question the threshold
 * approximates, so the test is whether it separates these twelve from the
 * answerable ones on its own.
 *
 * The same candidate set the product would use: the vector arm's top twenty.
 */
const encoder = process.env.ENCODER_URL ?? 'https://civicsignal-encoder.chester-hill-solutions.workers.dev/embed';
const encoderToken =
  process.env.ENCODER_TOKEN ??
  readFileSync(`${process.env.HOME}/.civicsignal/encoder-token`, 'utf8').trim();

async function embedQueries(texts: string[]): Promise<number[][]> {
  const response = await fetch(encoder, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(encoderToken ? { authorization: `Bearer ${encoderToken}` } : {}),
    },
    body: JSON.stringify({ texts: texts.map((text) => queryText(text)), titles: texts.map(() => '') }),
  });
  if (!response.ok) throw new Error(`the encoder refused: ${response.status}`);
  const body = (await response.json()) as { vectors: number[][] };
  if (body.vectors.length !== texts.length) throw new Error('the encoder returned the wrong count');
  return body.vectors;
}

const vectors = await embedQueries(UNANSWERABLE_QUESTIONS.map((question) => question.question));
let highestUnanswered = 0;

console.log('\nquestions the corpus cannot answer, through Jev');
for (const [at, question] of UNANSWERABLE_QUESTIONS.entries()) {
  const matches = searchVectors(store, Float32Array.from(vectors[at]!), TOPK).map(
    (match) => vectorToRow[match.docId] ?? match.docId,
  );
  const candidates = matches.map((rowAt) => rows[rowAt]!);
  const { relevance, anyRelevant, tokens: used } = await ask(question.question, candidates);
  tokens += used;
  const best = Math.max(...relevance);
  highestUnanswered = Math.max(highestUnanswered, anyRelevant);
  console.log(
    `  ${question.id.padEnd(24)} any_relevant ${anyRelevant.toFixed(2)}  ` +
      `best candidate ${best.toFixed(2)}  (${question.why})`,
  );
}

const lowestAnswered = Math.min(...answerableAnyRelevant);
const sorted = [...answerableAnyRelevant].sort((a, b) => a - b);
console.log(
  `\nthe ${answerableAnyRelevant.length} answerable question(s): any_relevant ` +
    `min ${lowestAnswered.toFixed(2)}, median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(2)}, ` +
    `max ${sorted[sorted.length - 1]!.toFixed(2)}`,
);
console.log(
  `the ${UNANSWERABLE_QUESTIONS.length} unanswerable: at most ${highestUnanswered.toFixed(2)}`,
);
if (lowestAnswered > highestUnanswered) {
  console.log(
    `  **separated.** A threshold anywhere in (${highestUnanswered.toFixed(2)}, ` +
      `${lowestAnswered.toFixed(2)}] refuses every unanswerable question and keeps every answerable one, ` +
      `and unlike the cosine floor it is a calibrated probability rather than a number chosen by hand`,
  );
} else {
  console.log(
    `  **not separated**: the worst answerable (${lowestAnswered.toFixed(2)}) is at or below the best ` +
      `unanswerable (${highestUnanswered.toFixed(2)}), so any threshold trades one against the other`,
  );
}
console.log(`  ${tokens} input tokens in total`);
