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
  rerank: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    corpus: 'dist/statutes.jsonl',
    vectors: 'dist/statutes.emb',
    queries: 'dist/query-vectors.json',
    topK: 50,
    rerank: 'http://127.0.0.1:8799/rerank',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--corpus') args.corpus = argv[++i] ?? args.corpus;
    else if (arg === '--vectors') args.vectors = argv[++i] ?? args.vectors;
    else if (arg === '--queries') args.queries = argv[++i] ?? args.queries;
    else if (arg === '--topk') args.topK = Number(argv[++i]) || args.topK;
    else if (arg === '--rerank') args.rerank = argv[++i] ?? '';
  }
  return args;
}

interface CorpusRow {
  id: string;
  act: string;
  section: string;
  heading: string | null;
  text: string;
  status?: string;
}

async function main(): Promise<void> {
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
  const ambiguous = [...valid.entries()].filter(([, rows]) => rows.length > 1);
  if (ambiguous.length) {
    console.log(`  ${ambiguous.length} label(s) match more than one row; any of them counts as the answer.`);
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

  // The vector index and the corpus are aligned by the manifest the embed wrote,
  // not by position. The index skips placeholder provisions, so the two are not
  // the same length and position is not an identity.
  const manifestPath = args.vectors.replace(/\.emb$/, '') + '.rows.json';
  let vectorToRow: number[] = rows.map((_, index) => index);
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as string[];
    const byId = new Map(rows.map((r, index) => [r.id, index]));
    const missing = manifest.filter((id) => !byId.has(id));
    if (missing.length) {
      console.error(`  the manifest names ${missing.length} row(s) the corpus does not have`);
      process.exit(1);
    }
    vectorToRow = manifest.map((id) => byId.get(id)!);
    console.log(`  aligned by manifest: ${vectorToRow.length} of ${rows.length} rows are indexed`);
  } else if (store.count !== rows.length) {
    console.warn(`  ! no manifest and the counts differ (${store.count} vectors, ${rows.length} rows)`);
  }

  const queryVectors = JSON.parse(readFileSync(args.queries, 'utf8')) as Record<string, number[]>;
  const missing = usable.filter((q) => !queryVectors[q.id]);
  if (missing.length) {
    console.error(`no query vector for: ${missing.map((q) => q.id).join(', ')}`);
    process.exit(1);
  }

  const modes: RetrievalMode[] = [
    'keyword',
    'keyword-reranked',
    'vector',
    'vector-reranked',
    'hybrid',
  ];

  // The reranker sees one candidate set, so reranking the keyword arm's candidates
  // and reranking the vector arm's candidates are two different experiments and
  // both are worth running.
  const rerankEndpoint = args.rerank;
  // A reranker that fails must not look like a reranker that found nothing: an empty
  // ranking is a legitimate result only if the call actually succeeded.
  let rerankCalls = 0;
  let rerankFailures = 0;
  const rerank = async (question: string, candidates: number[]): Promise<ScoredDoc[]> => {
    if (!rerankEndpoint) return [];
    rerankCalls++;
    const documents = candidates.map((docId) => {
      const row = rows[docId]!;
      return [row.act, row.heading ?? '', row.text].filter(Boolean).join(' ').slice(0, 1200);
    });
    const response = await fetch(rerankEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: question, documents }),
    });
    if (!response.ok) {
      rerankFailures++;
      console.error(`  rerank failed for "${question.slice(0, 60)}…": ${response.status}`);
      return [];
    }
    const body = (await response.json()) as { results?: { index: number; score: number }[] };
    // The worker normalises the model's `response: [{id, score}]` shape.
    return (body.results ?? []).map((r) => ({ docId: candidates[r.index]!, score: r.score }));
  };

  // The base rankings are computed once per question. The vector search scans every
  // section in the corpus, so computing it once per arm meant doing it four times
  // over for no reason.
  interface Base {
    keyword: ScoredDoc[];
    vector: ScoredDoc[];
  }
  const base = new Map<string, Base>();
  for (const question of usable) {
    const query = queryVectors[question.id]!;
    base.set(question.id, {
      keyword: search(index, question.question, args.topK),
      vector: searchVectors(store, Float32Array.from(query), args.topK).map((entry) => ({
        docId: vectorToRow[entry.docId] ?? entry.docId,
        score: entry.score,
      })),
    });
  }

  const reranked = new Map<string, { keyword: ScoredDoc[]; vector: ScoredDoc[] }>();
  for (const question of usable) {
    const b = base.get(question.id)!;
    reranked.set(question.id, {
      keyword: await rerank(question.question, b.keyword.map((k) => k.docId)),
      vector: await rerank(question.question, b.vector.map((k) => k.docId)),
    });
  }

  const rankingFor = (mode: RetrievalMode, questionId: string): ScoredDoc[] => {
    const b = base.get(questionId)!;
    const r = reranked.get(questionId)!;
    switch (mode) {
      case 'keyword':
        return b.keyword;
      case 'keyword-reranked':
        return r.keyword;
      case 'vector':
        return b.vector;
      case 'vector-reranked':
        return r.vector;
      case 'hybrid':
        return reciprocalRankFusion([b.keyword, b.vector], 60, args.topK);
    }
  };

  const results = new Map<RetrievalMode, ModeResult>();
  for (const mode of modes) {
    const outcomes: QuestionOutcome[] = [];
    for (const question of usable) {
      const gold = valid.get(question.id)!;
      const ranking = rankingFor(mode, question.id);
      // Any row that matches the label counts: the label names a provision, and a
      // corpus that holds two copies of one provision must not turn a correct
      // retrieval into a miss.
      const rank = ranking.findIndex((entry) => gold.includes(entry.docId));
      outcomes.push({
        id: question.id,
        style: question.style,
        rank: rank === -1 ? null : rank + 1,
        goldCount: 1,
      });
    }
    results.set(mode, scoreMode(mode, outcomes));
  }

  console.log('\n=== retrieval evaluation ===\n');
  console.log(`  corpus: ${args.corpus}  (${rows.length.toLocaleString()} sections)`);
  if (rerankCalls > 0) {
    console.log(
      `  reranker: ${rerankCalls - rerankFailures}/${rerankCalls} calls succeeded` +
        (rerankFailures > 0 ? ` — ${rerankFailures} FAILED, and the reranked arms are not a result` : ''),
    );
  }
  for (const mode of modes) {
    console.log(formatModeResult(results.get(mode)!));
    console.log('');
  }

  // The fusion sweep.
  //
  // Equal-weight fusion is not automatically right. The keyword arm is strong on
  // exact questions and weak on concept ones, and the vector arm is the reverse, so
  // the weight that preserves one may cost the other. This sweeps the constant and
  // the weight and reports what the best setting actually is, rather than assuming
  // the standard one is correct for this corpus.
  console.log('=== fusion sweep (keyword + vector) ===\n');
  const sweep: { label: string; result: ModeResult }[] = [];
  for (const k of [10, 30, 60]) {
    for (const weight of [1, 2, 4, 8, 16]) {
      const outcomes: QuestionOutcome[] = [];
      for (const question of usable) {
        const b = base.get(question.id)!;
        const fused = reciprocalRankFusion([b.keyword, b.vector], k, args.topK, [1, weight]);
        const gold = valid.get(question.id)!;
        const rank = fused.findIndex((e) => gold.includes(e.docId));
        outcomes.push({
          id: question.id,
          style: question.style,
          rank: rank === -1 ? null : rank + 1,
          goldCount: 1,
        });
      }
      sweep.push({ label: `k=${k} vectorWeight=${weight}`, result: scoreMode('hybrid', outcomes) });
    }
  }
  sweep.sort((a, b) => b.result.mrr - a.result.mrr);
  for (const entry of sweep) {
    const r = entry.result;
    console.log(
      `  ${entry.label.padEnd(26)} hits ${String(r.hits).padStart(3)}/${r.total}` +
        `  concept ${String(r.byStyle.concept.hits).padStart(2)}/${r.byStyle.concept.total}` +
        `  exact ${String(r.byStyle.exact.hits).padStart(2)}/${r.byStyle.exact.total}` +
        `  MRR ${r.mrr.toFixed(3)}`,
    );
  }
  console.log('');

  // The decision this evaluation exists to inform.
  const keyword = results.get('keyword')!;
  const best = [...results.values()].sort((a, b) => b.mrr - a.mrr)[0]!;
  const bestExact = Math.max(...[...results.values()].map((r) => r.byStyle.exact.hits));

  console.log('=== the decision ===\n');
  for (const mode of modes) {
    const r = results.get(mode)!;
    console.log(
      `  ${mode.padEnd(17)} concept ${String(r.byStyle.concept.hits).padStart(2)}/${r.byStyle.concept.total}` +
        `   exact ${String(r.byStyle.exact.hits).padStart(2)}/${r.byStyle.exact.total}` +
        `   MRR ${r.mrr.toFixed(3)}` +
        (r.byStyle.exact.hits === bestExact ? '' : '   (loses exact questions)'),
    );
  }
  console.log('');
  console.log(
    `  the best arm is "${best.mode}": ${best.byStyle.concept.hits}/${best.byStyle.concept.total} concept, ` +
      `${best.byStyle.exact.hits}/${best.byStyle.exact.total} exact, MRR ${best.mrr.toFixed(3)}.`,
  );
  console.log(
    `  the keyword baseline reaches ${keyword.byStyle.concept.hits}/${keyword.byStyle.concept.total} concept. ` +
      `The vector arm adds ${best.byStyle.concept.hits - keyword.byStyle.concept.hits} concept question(s)` +
      (best.byStyle.exact.hits < bestExact
        ? ` and costs ${bestExact - best.byStyle.exact.hits} exact question(s).`
        : ' and costs none.'),
  );

  // Per-question detail for the ones that moved.
  console.log('\n=== per question ===');
  console.log(`  ${'question'.padEnd(40)} ${'style'.padEnd(9)} ${modes.map((m) => m.padEnd(9)).join(' ')}`);
  for (const question of usable) {
    const ranks = modes.map((mode) => {
      const outcome = results.get(mode)!.outcomes.find((o) => o.id === question.id)!;
      return (outcome.rank === null ? '  —  ' : String(outcome.rank).padStart(4)).padEnd(9);
    });
    console.log(`  ${question.id.padEnd(40)} ${question.style.padEnd(9)} ${ranks.join(' ')}`);
  }

  // The misses.
  //
  // A question that every arm fails is not a retrieval result, it is a question
  // about the label or the corpus. Showing what outranked the gold answer is the
  // only way to tell those apart.
  console.log('\n=== the misses ===\n');
  const describe = (docId: number): string => {
    const row = rows[docId]!;
    const heading = row.heading ? ` — ${row.heading.slice(0, 60)}` : '';
    return `${row.act} s.${row.section}${heading}`;
  };
  let missCount = 0;
  for (const question of usable) {
    const gold = valid.get(question.id)!;
    const b = base.get(question.id)!;
    const inKeyword = b.keyword.some((e) => gold.includes(e.docId));
    const inVector = b.vector.some((e) => gold.includes(e.docId));
    if (inKeyword && inVector) continue;
    missCount++;
    const goldRow = rows[gold[0]!]!;
    const truncated = goldRow.text.length > 24000;
    console.log(`  ${question.id}`);
    console.log(`    Q: ${question.question}`);
    console.log(`    gold: ${gold.map(describe).join('; ')}  (${goldRow.text.length} chars${truncated ? ', TRUNCATED in the embedding' : ''})`);
    const missedBy = inVector ? 'keyword' : 'vector';
    const outranked = inVector ? b.keyword : b.vector;
    console.log(`    missed by the ${missedBy} arm; its top hits were:`);
    for (const entry of outranked.slice(0, 5)) {
      console.log(`      ${String(entry.docId).padStart(6)}  ${describe(entry.docId)}`);
    }
  }
  if (missCount === 0) console.log('  none — every question was found by both arms.');
  console.log('');
}

await main();
