#!/usr/bin/env bun
/**
 * The relevance floor, measured on the **live index**.
 *
 * Every number behind the floor came from the evaluation corpus, which holds
 * 19,021 sections. The live index holds 277,857. A larger corpus gives a
 * question a higher best score, so the two are not the same measurement, and the
 * floor is a threshold on the live one.
 *
 * This script measures both sides where the product actually asks:
 *
 *   - the **answerable** questions, to price what the floor refuses;
 *   - the **unanswerable** questions, to check the floor's benefit — that is,
 *     whether any of them reach the threshold and would be answered with the
 *     nearest provision about something else.
 *
 * The vector comes from the production encoder, on the `/embed-query` route, so
 * the question lands in the same place the product puts it. The score comes from
 * the production index, through `/api/match`.
 *
 *     CIVICSIGNAL_KEY=… bun scripts/production-floor.ts [--top 5] [--only concept]
 */
import { readFileSync } from 'node:fs';
import { QUESTIONS, UNANSWERABLE_QUESTIONS } from '../src/eval/questions';

const args = process.argv.slice(2);
const arg = (flag: string, fallback: string): string => {
  const at = args.indexOf(flag);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};

const API = arg('--api', 'https://api.civicsignal.chesterhillsolutions.ca');
const ENCODER = arg(
  '--encoder',
  'https://civicsignal-encoder.chester-hill-solutions.workers.dev/embed-query',
);
const floor = Number(arg('--floor', '0.62'));
const topK = Number(arg('--top', '5'));
const only = arg('--only', '');

const apiKey = process.env.CIVICSIGNAL_KEY ?? '';
if (!apiKey) {
  console.error('set CIVICSIGNAL_KEY');
  process.exit(1);
}
const encoderToken =
  process.env.ENCODER_TOKEN ??
  readFileSync(`${process.env.HOME ?? '.'}/.civicsignal/encoder-token`, 'utf8').trim();

/** The encoder is one CPU container, so a call is retried rather than dropped. */
async function embed(text: string): Promise<number[]> {
  let last = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(ENCODER, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${encoderToken}`,
        },
        body: JSON.stringify({ texts: [text] }),
      });
      if (response.ok) {
        const body = (await response.json()) as { vectors?: number[][] };
        const vector = body.vectors?.[0];
        if (vector && vector.length > 0) return vector;
        last = 'no vector';
      } else {
        last = `${response.status} ${(await response.text()).slice(0, 120)}`;
      }
    } catch (error) {
      last = String(error);
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
  }
  throw new Error(`the encoder refused: ${last}`);
}

interface Match {
  id: string;
  score: number;
}

async function bestMatches(vector: number[]): Promise<Match[]> {
  const response = await fetch(`${API}/api/match`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ vector, topK, corpus: 'statutes-canada' }),
  });
  if (!response.ok) {
    throw new Error(`the match route refused ${response.status}: ${(await response.text()).slice(0, 160)}`);
  }
  const body = (await response.json()) as { matches?: Match[] };
  return body.matches ?? [];
}

interface Measured {
  id: string;
  side: 'answerable' | 'unanswerable';
  question: string;
  best: number;
  top: Match[];
}

const jobs: { id: string; side: Measured['side']; question: string }[] = [
  ...QUESTIONS.map((q) => ({ id: q.id, side: 'answerable' as const, question: q.question })),
  ...UNANSWERABLE_QUESTIONS.map((q) => ({
    id: q.id,
    side: 'unanswerable' as const,
    question: q.question,
  })),
].filter((job) => only === '' || job.side === only);

console.log(
  `${jobs.length} question(s), floor ${floor}, encoder ${new URL(ENCODER).host}, index ${new URL(API).host}\n`,
);

const measured: Measured[] = [];
for (const [at, job] of jobs.entries()) {
  process.stdout.write(`\r  ${at + 1}/${jobs.length}  ${job.id.padEnd(46)}`);
  const vector = await embed(job.question);
  const matches = await bestMatches(vector);
  measured.push({ ...job, best: matches[0]?.score ?? 0, top: matches.slice(0, 3) });
}
process.stdout.write('\n\n');

console.log('the answerable questions, best score on the live index');
for (const entry of measured.filter((m) => m.side === 'answerable')) {
  console.log(
    `  ${entry.best.toFixed(4)}  ${entry.best < floor ? 'FLOOR REFUSES' : '             '}  ${entry.id}`,
  );
}

const unanswerable = measured.filter((m) => m.side === 'unanswerable');
console.log('\nthe questions the corpus cannot answer, best score on the live index');
for (const entry of [...unanswerable].sort((a, b) => b.best - a.best)) {
  console.log(
    `  ${entry.best.toFixed(4)}  ${entry.best >= floor ? 'LET THROUGH' : 'refused    '}  ${entry.id.padEnd(24)} nearest: ${entry.top[0]?.id ?? '—'}`,
  );
}

for (const side of ['answerable', 'unanswerable'] as const) {
  const set = measured.filter((m) => m.side === side);
  const over = set.filter((m) => m.best >= floor).length;
  console.log(`\n${side}: ${over} of ${set.length} score at or above ${floor}`);
}
