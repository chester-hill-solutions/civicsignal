#!/usr/bin/env bun
/**
 * The ingestion pipeline's runner.
 *
 * One cycle of the continuous ingest:
 *
 *   1. ask the corpus repository what revision it is at
 *   2. if that is the revision the store is already at, stop
 *   3. stream the instruments at that revision and parse each one
 *   4. reconcile against the store, embed what changed, write it
 *
 * There is no clone, no volume and no git binary. The corpus is a public git
 * repository and the pipeline needs two things from it — the current revision and
 * the content of the instruments at that revision — and both come over HTTPS.
 * The only state is the commit SHA, which is already in `corpus_state`.
 *
 * The whole tree is parsed on every run rather than only the changed files,
 * because the reconciliation is by provision: the store holds a fingerprint for
 * every provision, and a provision whose fingerprint is unchanged is unchanged.
 * Parsing 5,868 instruments takes about eighty seconds; a commit that changes
 * fifty-six of them costs six seconds of embedding and nothing else.
 *
 *   bun scripts/pipeline-run.ts --once        # one cycle, then exit
 *   bun scripts/pipeline-run.ts --watch       # loop, sleeping between cycles
 */
import { runPipeline, type PipelineRow } from '../src/ingest/pipeline';
import { CORPUS_ID, instrumentRows } from '../src/ingest/corpus-rows';
import { httpEncoder } from '../src/ingest/encoder-client';
import { GitHubCorpusSource, type CorpusSource } from '../src/ingest/source';
import { PostgresCorpusStore } from '../services/corpus-db/store';
import { ensureCorpusSchema } from '../services/corpus-db/schema';

const ENCODER_DOMAIN = process.env.ENCODER_DOMAIN ?? '127.0.0.1';
const ENCODER_PORT = process.env.ENCODER_PORT ?? '8080';
const ENCODER_URL = ENCODER_DOMAIN.includes('://')
  ? ENCODER_DOMAIN
  : `http://${ENCODER_DOMAIN}:${ENCODER_PORT}`;
const ENCODER_TOKEN = process.env.ENCODER_TOKEN ?? '';
const DATABASE_URL = process.env.CORPUS_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const WATCH_SECONDS = Number(process.env.PIPELINE_INTERVAL_SECONDS ?? 21_600);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';

const args = process.argv.slice(2);
const once = args.includes('--once') || !args.includes('--watch');

function log(line: string): void {
  console.log(`${new Date().toISOString()}  ${line}`);
}

/**
 * The instruments at a revision, as the rows the store holds.
 *
 * The parsing is shared with the Worker (`src/ingest/corpus-rows.ts`), so both
 * read **both** trees of the corpus — the English one and the French one. The
 * corpus is bilingual, and an ingest that reads only one of them is not a
 * corpus, it is half of one.
 */
async function parseInstruments(
  source: CorpusSource,
  revision: string,
  date: string,
): Promise<PipelineRow[]> {
  const rows: PipelineRow[] = [];
  let files = 0;
  for await (const row of instrumentRows({
    source,
    revision,
    date,
    onFile: () => {
      files++;
    },
  })) {
    rows.push(row);
  }
  log(`  ${files} instrument file(s) parsed into ${rows.length} provision(s)`);
  return rows;
}

async function cycle(): Promise<void> {
  if (!DATABASE_URL) {
    log('no DATABASE_URL — the pipeline cannot run');
    return;
  }

  // The schema, before anything else.
  //
  // The pipeline owns the corpus database, and a service that cannot reach its
  // own schema is a service that cannot run. Every statement is
  // `IF NOT EXISTS`, so this is free on every start and means a deployment that
  // changed the schema does not need a human to remember to migrate.
  try {
    await ensureCorpusSchema(DATABASE_URL);
  } catch (error) {
    log(`the schema could not be applied: ${String(error).slice(0, 300)}`);
    throw error;
  }

  const source = new GitHubCorpusSource({ token: GITHUB_TOKEN || undefined });
  const store = new PostgresCorpusStore(DATABASE_URL);

  try {
    const head = await source.head();
    const state = await store.currentCommit(CORPUS_ID);
    if (state && state.commit === head.commit) {
      log(`already at ${head.commit.slice(0, 9)} (${head.date}) — nothing to do`);
      return;
    }
    log(`the corpus is at ${head.commit.slice(0, 9)} (${head.date})`);

    const rows = await parseInstruments(source, head.commit, head.date);

    await runPipeline({
      corpusId: CORPUS_ID,
      previous: state ?? { commit: 'empty', date: '1970-01-01' },
      next: { commit: head.commit, date: head.date },
      rows,
      store,
      encoder: httpEncoder({ url: ENCODER_URL, token: ENCODER_TOKEN }),
      now: new Date(),
      logger: log,
    });
  } finally {
    await store.close();
  }
}

if (once) {
  await cycle();
} else {
  for (;;) {
    try {
      await cycle();
    } catch (error) {
      log(`the cycle failed: ${(error as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, WATCH_SECONDS));
  }
}
