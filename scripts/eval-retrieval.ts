#!/usr/bin/env bun
/**
 * The retrieval evaluation.
 *
 * Compares three arms over the same 191,025-section corpus:
 *
 *   keyword  BM25 over the act name, heading and provision text
 *   vector   cosine over the embedded corpus
 *   hybrid   reciprocal rank fusion of the two
 *
 * The question it answers is narrow and worth answering before anything is built:
 * does a vector arm earn its running cost? It is answered on a labelled set where
 * half the questions are phrased in the statute's own words and half describe a
 * circumstance in ordinary language.
 *
 *   bun run eval:retrieval
 *   bun run eval:retrieval -- --topk 20
 */
import { readFileSync, existsSync } from 'node:fs';
import { buildIndex, search } from '../src/eval/bm25';
import { loadVectorStore, reciprocalRankFusion, searchVectors, type ScoredDoc } from '../src/eval/retrieval';
import { QUESTIONS } from '../src/eval/questions';
import { formatModeResult, scoreMode, validateLabels, type ModeResult, type QuestionOutcome, type RetrievalMode } from '../src/eval/evaluate';

interface Args {
  corpus: string;
  vectors: string;
  queries: string;
  topK: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    corpus: 'dist/statutes.jsonl',
    vectors: 'dist/statutes.emb',
    queries: 'dist/query-vectors.json',
    topK: 50,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--corpus') args.corpus = argv[++i] ?? args.corpus;
    else if (arg === '--vectors') args.vectors = argv[++i] ?? args.vectors;
    else if (arg === '--queries') args.queries = argv[++i] ?? args.queries;
    else if (arg === '--topk') args.topK = Number(argv[++i]) || args.topK;
  }
  return args;
}

interface CorpusRow {
  id: string;
  act: string;
  section: string;
  heading: string | null;
  text: string;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  for (const path of [args.corpus, args.vectors, args.queries]) {
    if (!existsSync(path)) {
      console.error(`missing ${path}`);
      process.exit(1);
    }
  }

  console.log('loading the corpus…');
  const rows: CorpusRow[] = [];
  for (const line of readFileSync(args.corpus, 'utf8').split('\n')) {
    if (line.trim()) rows.push(JSON.parse(line) as CorpusRow);
  }
  console.log(`  ${rows.length} sections`);

  // The labels are checked before anything is scored.
  const { valid, issues } = validateLabels(
    QUESTIONS,
    rows.map((r) => ({ act: r.act, section: r.section })),
  );
  if (issues.length) {
    console.log(`\n${issues.length} label issue(s):`);
    for (const issue of issues) {
      console.log(`  ${issue.question.id}: ${issue.reason} (${issue.matches})`);
    }
  }
  const usable = QUESTIONS.filter((q) => valid.has(q.id));
  console.log(`  ${usable.length}/${QUESTIONS.length} questions have a verified label`);

  console.log('building the keyword index…');
  const started = Date.now();
  const documents = rows.map((r) => [r.act, r.heading ?? '', r.text].filter(Boolean).join('\n'));
  const index = buildIndex(documents);
  console.log(`  ${index.termCount} terms, ${index.docCount} documents, ${Math.round((Date.now() - started) / 1000)}s`);

  const store = loadVectorStore(args.vectors);
  console.log(`  vector store: ${store.count} x ${store.dims}`);
  if (store.count !== rows.length) {
    console.warn(`  ! vector store has ${store.count} rows but the corpus has ${rows.length}; they are aligned by index`);
  }

  const queryVectors = JSON.parse(readFileSync(args.queries, 'utf8')) as Record<string, number[]>;
  const missing = usable.filter((q) => !queryVectors[q.id]);
  if (missing.length) {
    console.error(`no query vector for: ${missing.map((q) => q.id).join(', ')}`);
    process.exit(1);
  }

  const modes: RetrievalMode[] = ['keyword', 'vector', 'hybrid'];
  const results = new Map<RetrievalMode, ModeResult>();
  const perModeRankings = new Map<RetrievalMode, Map<string, ScoredDoc[]>>();

  for (const mode of modes) {
    const rankings = new Map<string, ScoredDoc[]>();
    const outcomes: QuestionOutcome[] = [];
    for (const question of usable) {
      const gold = valid.get(question.id)!;
      const query = queryVectors[question.id]!;
      const keyword = search(index, question.question, args.topK);
      const vector = searchVectors(store, Float32Array.from(query), args.topK);
      const ranking =
        mode === 'keyword' ? keyword : mode === 'vector' ? vector : reciprocalRankFusion([keyword, vector], 60, args.topK);
      rankings.set(question.id, ranking);
      const rank = ranking.findIndex((entry) => entry.docId === gold);
      outcomes.push({
        id: question.id,
        style: question.style,
        rank: rank === -1 ? null : rank + 1,
        goldCount: 1,
      });
    }
    perModeRankings.set(mode, rankings);
    results.set(mode, scoreMode(mode, outcomes));
  }

  console.log('\n=== retrieval evaluation — 191,025 federal statute sections ===\n');
  for (const mode of modes) {
    console.log(formatModeResult(results.get(mode)!));
    console.log('');
  }

  // The decision this evaluation exists to inform.
  const keyword = results.get('keyword')!;
  const hybrid = results.get('hybrid')!;
  const vector = results.get('vector')!;
  const gained = hybrid.byStyle.concept.hits - keyword.byStyle.concept.hits;
  const lost = keyword.byStyle.exact.hits - hybrid.byStyle.exact.hits;

  console.log('=== the decision ===\n');
  console.log(`  concept questions   keyword ${keyword.byStyle.concept.hits}/${keyword.byStyle.concept.total}` +
    `   vector ${vector.byStyle.concept.hits}/${vector.byStyle.concept.total}` +
    `   hybrid ${hybrid.byStyle.concept.hits}/${hybrid.byStyle.concept.total}`);
  console.log(`  exact questions     keyword ${keyword.byStyle.exact.hits}/${keyword.byStyle.exact.total}` +
    `   vector ${vector.byStyle.exact.hits}/${vector.byStyle.exact.total}` +
    `   hybrid ${hybrid.byStyle.exact.hits}/${hybrid.byStyle.exact.total}`);
  console.log(`\n  hybrid gains ${gained} concept question(s) and loses ${lost} exact question(s).`);
  console.log(
    gained > 0 && lost === 0
      ? '  VERDICT: the vector arm earns its place. Build the index.'
      : gained > 0
        ? '  VERDICT: the vector arm helps on concept questions but costs exact ones. Fuse selectively — run the vector arm only when the keyword arm scores weakly.'
        : '  VERDICT: the vector arm does not earn its running cost. Keep the keyword index and stop here.',
  );

  // Per-question detail for the ones that moved.
  console.log('\n=== per question ===');
  console.log('  question                                  style     keyword  vector  hybrid');
  for (const question of usable) {
    const ranks = modes.map((mode) => {
      const outcome = results.get(mode)!.outcomes.find((o) => o.id === question.id)!;
      return outcome.rank === null ? '  —  ' : String(outcome.rank).padStart(4);
    });
    console.log(`  ${question.id.padEnd(40)} ${question.style.padEnd(9)} ${ranks.join('  ')}`);
  }
}

main();
