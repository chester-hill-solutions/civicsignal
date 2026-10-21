/**
 * The ingestion pipeline, as a scheduled Worker.
 *
 * The pipeline used to be a service on Railway that woke up, ran a cycle and
 * slept. It is now a Worker with a cron trigger, because the product is on
 * Cloudflare and the corpus is the product's own content — a pipeline on
 * somebody else's platform is a second deploy pipeline, a second failure
 * domain and a second set of credentials for the sake of a loop that sleeps
 * most of the day.
 *
 * ## What a cycle does
 *
 *   1. ask the corpus repository what revision it is at
 *   2. if that is the revision the store is already at, stop
 *   3. stream the instruments at that revision and parse each one
 *   4. reconcile against the store, embed what changed, write it
 *
 * The common case is step 2. The corpus repository moves every three to eight
 * days, so almost every invocation finds nothing to do and costs one request.
 *
 * ## Why the streamed cycle
 *
 * The corpus is 277,857 provisions — several hundred megabytes of statute
 * text. `runPipeline` holds all of it at once, which a Railway service can do
 * and a Worker cannot: a Worker has 128 MB. So the cycle here is the streamed
 * one, which reconciles as the rows pass and holds only the store's
 * fingerprints and one batch of changed rows.
 */
import { D1CorpusStore } from '../../src/corpora/d1-store';
import { CORPUS_ID, instrumentRows } from '../../src/ingest/corpus-rows';
import { httpEncoder } from '../../src/ingest/encoder-client';
import { GitHubCorpusSource } from '../../src/ingest/source';
import { runStreamingPipeline } from '../../src/ingest/streaming-pipeline';

interface Env {
  /** The corpus: the rows in D1, the vectors in Vectorize. */
  CIVIC_DB: D1Database;
  VECTORIZE: Vectorize;
  /** The encoder, called directly. */
  ENCODER_SERVICE: { fetch(request: Request): Promise<Response> };
  /** The shared secret the encoder checks. */
  ENCODER_TOKEN: string;
  /**
   * A GitHub token.
   *
   * The corpus is public, so this is optional — without one the rate limit is
   * 60 requests an hour, and a cycle makes two.
   */
  GITHUB_TOKEN?: string;
}

export default {
  /**
   * The cron trigger.
   *
   * The work is handed to `waitUntil` so the invocation stays alive for the
   * cycle rather than being cut off when the trigger returns, and the error is
   * re-thrown so a failed cycle is a failed invocation — quiet failures are
   * how a corpus goes stale without anyone noticing.
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      cycle(env).catch((error: unknown) => {
        console.error(`the pipeline cycle failed: ${String(error)}`);
        throw error;
      }),
    );
  },

  /**
   * The Worker has nothing to serve.
   *
   * It is here so that a request for the health of the pipeline answers, and
   * so that anything else answers plainly that there is nothing here. Cloudflare
   * routes its own `__scheduled` request to the scheduled handler, which is
   * how a cycle is triggered by hand.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'civicsignal-pipeline' });
    }
    return Response.json(
      { error: 'not found', hint: 'this Worker runs on a schedule; there is nothing to call' },
      { status: 404 },
    );
  },
};

async function cycle(env: Env): Promise<void> {
  const log = (line: string) => console.log(`${new Date().toISOString()}  ${line}`);
  const source = new GitHubCorpusSource({ token: env.GITHUB_TOKEN || undefined });
  const store = new D1CorpusStore(env.CIVIC_DB, env.VECTORIZE, CORPUS_ID);

  const head = await source.head();
  const state = await store.currentCommit(CORPUS_ID);
  if (state && state.commit === head.commit) {
    log(`already at ${head.commit.slice(0, 9)} (${head.date}) — nothing to do`);
    return;
  }
  log(`the corpus is at ${head.commit.slice(0, 9)} (${head.date})`);

  let files = 0;
  const run = await runStreamingPipeline({
    corpusId: CORPUS_ID,
    next: { commit: head.commit, date: head.date },
    rows: instrumentRows({
      source,
      revision: head.commit,
      date: head.date,
      onFile: () => {
        files++;
      },
    }),
    store,
    encoder: httpEncoder({
      // The service binding, not an address: a Worker cannot fetch a
      // `workers.dev` address on this account — it answers `1042`.
      url: 'https://encoder',
      token: env.ENCODER_TOKEN,
      send: (request) => env.ENCODER_SERVICE.fetch(request),
    }),
    now: new Date(),
    logger: log,
  });

  const provisions = run.counts.added + run.counts.changed + run.counts.unchanged;
  log(`  ${files} instrument file(s), ${provisions} provision(s)`);
}
