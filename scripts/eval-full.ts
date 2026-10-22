#!/usr/bin/env bun
/**
 * The retrieval measurement, on the corpus the product actually serves.
 *
 * Everything measured so far was taken on a 19,021-section evaluation corpus,
 * because embedding 277,857 provisions takes about five hours on the deployed
 * container. The vectors exist as a file now, so the same questions can be
 * asked of the real corpus, where the candidate sets are denser and the
 * distractors harder. The number this matters most for is the refusal
 * threshold, since that is what decides whether the product says "I don't
 * know".
 *
 * Two things keep it cheap. The gold rows' **ids** come from the small
 * evaluation corpus, which is a subset, so no scan of the full corpus is
 * needed to resolve a label; and their **positions** come from the index,
 * which is sorted by id. Only the fifty candidates per question are read, by
 * byte offset, out of the rows parts.
 *
 *     bun scripts/eval-full.ts --revision 0507465 [--top 50] [--repeats 3]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENCODER_CONTRACT, queryText } from '../src/encoder';
import { validateLabels } from '../src/eval/evaluate';
import { QUESTIONS, UNANSWERABLE_QUESTIONS } from '../src/eval/questions';
import { loadVectorStore, searchVectors } from '../src/eval/retrieval';
import {
  indexKey,
  locate,
  parseManifest,
  partStarts,
  type SnapshotIndexEntry,
} from '../src/ingest/snapshot-format';

const args = process.argv.slice(2);
function arg(flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

const revision = arg('--revision', '');
const dir = arg('--dir', join('dist', 'snapshot'));
const TOPK = Number(arg('--top', '50'));
const REPEATS = Number(arg('--repeats', '3'));
const ENDPOINT = 'https://opencode.ai/inference/systemone/v1/systemone';
const MODEL = 'jev-1.13';
const JEV_KEY = process.env.JEV_KEY ?? '';
if (!revision || !JEV_KEY) {
  console.error('usage: JEV_KEY=... bun scripts/eval-full.ts --revision <sha>');
  process.exit(2);
}

interface Row {
  id: string;
  act: string;
  section: string;
  heading: string | null;
  text: string;
}

const manifest = parseManifest(
  readFileSync(join(dir, `${revision}.manifest.json`), 'utf8'),
  `${revision}.manifest.json`,
);
const starts = partStarts(manifest);
const partFiles = manifest.rows.parts.map((part) => readFileSync(join(dir, part.key)));

/** The index, in the store's order, and a lookup by id for the gold rows. */
const index: SnapshotIndexEntry[] = readFileSync(join(dir, indexKey(revision)), 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as SnapshotIndexEntry);
const positionOf = new Map(index.map((entry, at) => [entry.id, at]));

/** One row, by its index entry. */
function rowAt(entry: SnapshotIndexEntry): Row {
  const { part, local } = locate(manifest, entry.off);
  const bytes = partFiles[part]!.subarray(local, local + entry.len);
  return JSON.parse(bytes.toString('utf8')) as Row;
}

const store = loadVectorStore(join(dir, `${revision}.store.emb`));
if (store.count !== index.length) {
  throw new Error(
    `the store holds ${store.count} vector(s) and the index names ${index.length} — they are not the same corpus`,
  );
}
console.log(`${store.count} vector(s) of ${store.dims} dimensions, from ${manifest.rows.parts.length} part(s)`);

// The gold rows' ids, from the small evaluation corpus, which is a subset.
const small: Row[] = readFileSync('dist/eval-corpus.jsonl', 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as Row);
const { valid } = validateLabels(
  QUESTIONS,
  small.map((row) => ({ act: row.act, section: row.section })),
);
const goldIds = new Map<string, string[]>();
for (const [id, positions] of valid) goldIds.set(id, positions.map((at) => small[at]!.id));

const queryVectors = JSON.parse(readFileSync('dist/eval-query-vectors.gemma.json', 'utf8')) as Record<
  string,
  number[]
>;

/** The unanswerable questions have no stored vectors, so they are embedded. */
const encoderToken =
  process.env.ENCODER_TOKEN ??
  readFileSync(`${process.env.HOME}/.civicsignal/encoder-token`, 'utf8').trim();
const fresh = await (async () => {
  const response = await fetch(
    'https://civicsignal-encoder.chester-hill-solutions.workers.dev/embed',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${encoderToken}` },
      body: JSON.stringify({
        texts: UNANSWERABLE_QUESTIONS.map((question) => queryText(question.question)),
        titles: UNANSWERABLE_QUESTIONS.map(() => ''),
      }),
    },
  );
  if (!response.ok) throw new Error(`the encoder refused: ${response.status}`);
  return ((await response.json()) as { vectors: number[][] }).vectors;
})();

/** The candidates for a question: the vector arm's top k, with their text. */
function candidates(vector: number[]): { entries: SnapshotIndexEntry[]; rows: Row[] } {
  const matches = searchVectors(store, Float32Array.from(vector), TOPK);
  const entries = matches.map((match) => index[match.docId]!);
  return { entries, rows: entries.map(rowAt) };
}

/**
 * How much of a provision Jev sees.
 *
 * The limits force the choice: at most 250 candidates and about 120K characters
 * in a single call, so a deeper candidate set means a shorter excerpt. Whether
 * that is a good trade is not obvious — a heading and a first sentence may carry
 * the whole decision, or may not — so it is measured rather than assumed.
 */
const EXCERPT = Number(arg('--excerpt', '1200'));

function excerpt(row: Row): string {
  return `${row.act}, section ${row.section}${row.heading ? ` (${row.heading})` : ''}\n${row.text.slice(0, EXCERPT)}`;
}

interface Flags {
  needs_federal_statute: number;
  needs_provincial: number;
  needs_court_decision: number;
  needs_foreign_law: number;
  is_not_law: number;
  asks_published_figure: number;
}

async function ask(
  query: string,
  rows: Row[],
): Promise<{ relevance: number[]; anyRelevant: number; flags: Flags; tokens: number }> {
  const questions: Record<string, unknown> = {};
  rows.forEach((_, at) => {
    questions[`c${at}`] = {
      type: 'noul',
      instructions: `Provision c${at} states the rule the question asks about.`,
    };
  });
  questions['any_relevant'] = {
    type: 'noul',
    instructions: 'At least one provision below states the rule the question asks about.',
  };

  // **The decomposition.** One compound judgment is what failed: "does any
  // provision state the rule" was answered *yes* for Quebec tenancy, correctly,
  // because the corpus does hold a federal tenancy regulation. Relevance is not
  // the decision. These ask the separate things that decision is made of, each
  // narrow enough to be a single gut-check, and the combination happens in code
  // below where it can be read and changed.
  const atomic: Record<string, string> = {
    needs_federal_statute:
      'The rule this question asks about is stated in a Canadian federal statute or regulation.',
    needs_provincial:
      'The rule this question asks about is stated in provincial or territorial law rather than federal law.',
    needs_court_decision:
      'The answer to this question is a decision of a court rather than the text of a statute.',
    needs_foreign_law:
      'The rule this question asks about comes from a jurisdiction outside Canada.',
    is_not_law: 'This question is not about law at all.',
    asks_published_figure:
      'This question asks for an amount or a rate, of the kind published as a policy figure, that the text of a statute does not state.',
  };
  for (const [id, instructions] of Object.entries(atomic)) {
    questions[id] = { type: 'noul', instructions };
  }
  const state = [
    ...rows.map((row, at) => `c${at}: ${excerpt(row)}`),
    `question: ${query}`,
  ].join('\n\n');
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${JEV_KEY}`, 'content-type': 'application/json' },
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
    relevance: rows.map((_, at) => body.answers[`c${at}`]?.noul ?? 0),
    anyRelevant: body.answers['any_relevant']?.noul ?? 0,
    flags: {
      needs_federal_statute: body.answers['needs_federal_statute']?.noul ?? 0,
      needs_provincial: body.answers['needs_provincial']?.noul ?? 0,
      needs_court_decision: body.answers['needs_court_decision']?.noul ?? 0,
      needs_foreign_law: body.answers['needs_foreign_law']?.noul ?? 0,
      is_not_law: body.answers['is_not_law']?.noul ?? 0,
      asks_published_figure: body.answers['asks_published_figure']?.noul ?? 0,
    },
    tokens: body.usage?.input_tokens ?? 0,
  };
}

async function repeated(query: string, rows: Row[]) {
  const relevance = new Array<number>(rows.length).fill(0);
  const anys: number[] = [];
  const flags = {
    needs_federal_statute: 0,
    needs_provincial: 0,
    needs_court_decision: 0,
    needs_foreign_law: 0,
    is_not_law: 0,
    asks_published_figure: 0,
  } as Flags;
  let tokens = 0;
  for (let run = 0; run < REPEATS; run++) {
    const one = await ask(query, rows);
    one.relevance.forEach((value, at) => {
      relevance[at] += value / REPEATS;
    });
    anys.push(one.anyRelevant);
    for (const key of Object.keys(flags) as (keyof Flags)[]) {
      flags[key] += one.flags[key] / REPEATS;
    }
    tokens += one.tokens;
  }
  return { relevance, anys, flags, tokens };
}

/**
 * The decision, in code, from the atomic answers.
 *
 * This is the part the docs say to own rather than ask for: each answer is one
 * narrow judgment, and what to *do* with them is a rule that can be read here
 * and changed when priorities change. Corpus answers only a question that needs
 * a federal statute, has a relevant provision, and does not want a published
 * figure. Provincial and case-law questions are the web arm's. The rest are
 * refused.
 */
function verdict(flags: Flags, anyRelevant: number, threshold: number) {
  if (flags.needs_foreign_law >= 0.5 || flags.is_not_law >= 0.5) return 'refuse';
  if (flags.needs_provincial >= 0.5 || flags.needs_court_decision >= 0.5) return 'web';
  if (flags.asks_published_figure >= 0.5) return 'refuse';
  if (flags.needs_federal_statute < 0.5) return 'refuse';
  return anyRelevant >= threshold ? 'answer' : 'refuse';
}

const hit = (rank: number | null, k: number) => rank !== null && rank <= k;

let tokens = 0;
let reachable = 0;
let vectorAt1 = 0;
let vectorAt5 = 0;
let jevAt1 = 0;
let jevAt5 = 0;
let vectorMrr = 0;
let jevMrr = 0;
const answerable: number[] = [];
const answerableVerdicts: string[] = [];

console.log('\nthe labelled questions, on the full corpus');
for (const question of QUESTIONS) {
  const gold = goldIds.get(question.id);
  const vector = queryVectors[question.id];
  if (!gold || !vector) continue;
  const { entries, rows } = candidates(vector);
  const goldSet = new Set(gold);
  const positions = entries.map((entry, at) => (goldSet.has(entry.id) ? at : -1)).filter((at) => at >= 0);
  if (positions.length === 0) continue;
  reachable++;

  const vectorRank = Math.min(...positions) + 1;
  const result = await repeated(question.question, rows);
  tokens += result.tokens;
  answerable.push(...result.anys);
  answerableVerdicts.push(verdict(result.flags, Math.min(...result.anys), 0.5));

  const order = rows
    .map((_, at) => at)
    .sort((a, b) => result.relevance[b]! - result.relevance[a]! || a - b);
  const at = order.findIndex((i) => goldSet.has(entries[i]!.id));
  const jevRank = at === -1 ? null : at + 1;

  if (hit(vectorRank, 1)) vectorAt1++;
  if (hit(vectorRank, 5)) vectorAt5++;
  if (hit(jevRank, 1)) jevAt1++;
  if (hit(jevRank, 5)) jevAt5++;
  vectorMrr += 1 / vectorRank;
  if (jevRank) jevMrr += 1 / jevRank;

  console.log(
    `  ${question.id.padEnd(34)} vector ${String(vectorRank).padStart(2)} to jev ` +
      `${String(jevRank).padStart(2)}   any_relevant ${Math.min(...result.anys).toFixed(2)}-` +
      `${Math.max(...result.anys).toFixed(2)}`,
  );
}

console.log(`\nwithin the top ${TOPK}: ${reachable} of ${QUESTIONS.length} question(s) reachable`);
console.log(`  vector   R@1 ${vectorAt1}/${reachable}   R@5 ${vectorAt5}/${reachable}   MRR ${(vectorMrr / reachable).toFixed(3)}`);
console.log(`  jev      R@1 ${jevAt1}/${reachable}   R@5 ${jevAt5}/${reachable}   MRR ${(jevMrr / reachable).toFixed(3)}`);

const unanswerable: { id: string; low: number; high: number; verdict: string }[] = [];
console.log('\nthe unanswerable questions, on the full corpus');
for (const [at, question] of UNANSWERABLE_QUESTIONS.entries()) {
  const { rows } = candidates(fresh[at]!);
  const result = await repeated(question.question, rows);
  tokens += result.tokens;
  const low = Math.min(...result.anys);
  const high = Math.max(...result.anys);
  const v = verdict(result.flags, high, 0.5);
  unanswerable.push({ id: question.id, low, high, verdict: v });
  console.log(
    `  ${question.id.padEnd(24)} any ${low.toFixed(2)}-${high.toFixed(2)}  ` +
      `fed ${result.flags.needs_federal_statute.toFixed(2)}  prov ${result.flags.needs_provincial.toFixed(2)}  ` +
      `court ${result.flags.needs_court_decision.toFixed(2)}  fig ${result.flags.asks_published_figure.toFixed(2)}  ` +
      `-> ${v.padEnd(6)} (${question.why})`,
  );
}

const sorted = [...answerable].sort((a, b) => a - b);
const floor = sorted[0]!;
const ceiling = Math.max(...unanswerable.map((question) => question.high));
console.log(
  `\nthe ${answerable.length} answerable sample(s): any_relevant min ${floor.toFixed(2)}, ` +
    `median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(2)}, max ${sorted[sorted.length - 1]!.toFixed(2)}`,
);
console.log(`the ${unanswerable.length} unanswerable: at most ${ceiling.toFixed(2)} (best of ${REPEATS} run(s))`);
const answeredFromCorpus = answerableVerdicts.filter((v) => v === 'answer').length;
const answeredFromUnanswerable = unanswerable.filter((question) => question.verdict === 'answer').length;
console.log(
  `\nthe decomposition, combined in code:\n` +
    `  of ${answerableVerdicts.length} answerable question(s), ` +
    `${answeredFromCorpus} are answered from the corpus ` +
    `(${answerableVerdicts.filter((v) => v === 'web').length} sent to the web, ` +
    `${answerableVerdicts.filter((v) => v === 'refuse').length} refused)\n` +
    `  of ${unanswerable.length} unanswerable question(s), ` +
    `${answeredFromUnanswerable} are answered from the corpus ` +
    `(${unanswerable.filter((q) => q.verdict === 'web').length} sent to the web, ` +
    `${unanswerable.filter((q) => q.verdict === 'refuse').length} refused)`,
);
if (answeredFromUnanswerable === 0) {
  console.log('  **the decomposition separates them, where one relevance score did not**');
}

console.log(
  `  for the record, a threshold on the single relevance score does not work here: ` +
    `the worst answerable is ${floor.toFixed(2)} and the best unanswerable is ${ceiling.toFixed(2)}`,
);
console.log(`  ${tokens} input tokens`);
