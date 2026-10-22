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
import { CORPUS_ID } from '../../src/ingest/corpus-rows';
import { httpEncoder } from '../../src/ingest/encoder-client';
import { runIncrementalPipeline } from '../../src/ingest/incremental-pipeline';
import { GitHubCorpusSource } from '../../src/ingest/source';

interface Env {
  /** The corpus: the rows in D1, the vectors in Vectorize. */
  CIVIC_DB: D1Database;
  VECTORIZE: Vectorize;
  /** The encoder, called directly. */
  ENCODER_SERVICE: { fetch(request: Request): Promise<Response> };
  /** The shared secret the encoder checks. */
  ENCODER_TOKEN: string;
  /**
   * The secret that lets a cycle be run by hand.
   *
   * `POST /run` runs the ingest on demand, and it is behind this because a
   * public endpoint that runs the corpus's ingest is a button anybody can
   * press — and the cycle is not free.
   */
  PIPELINE_SECRET: string;
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
   * The cycle is **awaited**, not handed to `waitUntil`. A `waitUntil` task is
   * cancelled thirty seconds after the invocation ends, and the invocation
   * ends as soon as the handler returns — so a cycle that took two minutes
   * would be killed a third of the way through, having written some of its
   * rows and not the rest. Awaiting makes the invocation's lifetime the
   * cycle's lifetime, which is what a scheduled handler is for.
   *
   * The error is re-thrown so a failed cycle is a failed invocation. Quiet
   * failures are how a corpus goes stale without anyone noticing.
   */
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    try {
      await cycle(env);
    } catch (error) {
      console.error(`the pipeline cycle failed: ${String(error)}`);
      throw error;
    }
  },

  /**
   * The Worker has nothing to serve, except one thing.
   *
   * It is here so that a request for the health of the pipeline answers, and
   * so that anything else answers plainly that there is nothing here.
   *
   * **Except `POST /run`**, which runs a cycle by hand. The cron is a
   * schedule, not a button: when the corpus moves you want the ingest now,
   * not at 11:23 tomorrow — and there is no other way to ask a scheduled
   * Worker to run outside its schedule. It is behind a secret, because a
   * public endpoint that runs the corpus's ingest is a button anybody can
   * press, and the cycle is not free.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'civicsignal-pipeline' });
    }
    if (url.pathname === '/run' && request.method === 'POST') {
      const presented = request.headers.get('x-pipeline-secret') ?? '';
      if (!env.PIPELINE_SECRET || presented !== env.PIPELINE_SECRET) {
        return Response.json({ error: 'forbidden' }, { status: 403 });
      }
      // Awaited, for the same reason the cron awaits: a `waitUntil` task is
      // cancelled thirty seconds after the response goes out, and the cycle
      // takes longer than that.
      const summary = await cycle(env).catch((error: unknown) => {
        console.error(`the pipeline cycle failed: ${String(error)}`);
        return { error: String(error).slice(0, 500) };
      });
      return Response.json(summary, { status: 'error' in summary ? 500 : 200 });
    }
    return Response.json(
      { error: 'not found', hint: 'this Worker runs on a schedule; POST /run to run a cycle' },
      { status: 404 },
    );
  },
};

/** What a cycle did, for the caller that asked for it by hand. */
interface CycleSummary {
  ok: boolean;
  /** The revision the corpus is at. */
  at: string;
  /** True when the store was already at that revision. */
  nothing?: boolean;
  counts?: { added: number; changed: number; removed: number; unchanged: number };
  embedded?: number;
  durationMs?: number;
}

async function cycle(env: Env): Promise<CycleSummary> {
  const log = (line: string) => console.log(`${new Date().toISOString()}  ${line}`);
  const source = new GitHubCorpusSource({ token: env.GITHUB_TOKEN || undefined });
  const store = new D1CorpusStore(env.CIVIC_DB, env.VECTORIZE, CORPUS_ID);

  const head = await source.head();
  const state = await store.currentCommit(CORPUS_ID);
  if (state && state.commit === head.commit) {
    log(`already at ${head.commit.slice(0, 9)} (${head.date}) — nothing to do`);
    return { ok: true, at: head.commit, nothing: true };
  }
  log(`the corpus is at ${head.commit.slice(0, 9)} (${head.date})`);

  if (!state) {
    // **The store has to know what it is at.**
    //
    // The incremental cycle works by comparing the changed files at the head
    // with the same files at the revision the store holds — so without that
    // revision there is no "before" to compare with, and the removals would
    // be invisible. A store that has never been through a cycle has to be
    // brought up to date by hand first.
    throw new Error(
      `${CORPUS_ID} has no revision recorded in corpus_state. ` +
        `Run \`bun scripts/backfill-fingerprints.ts\` to prepare the store before the pipeline writes to it.`,
    );
  }

  // **The store has to be prepared.**
  //
  // The reconciliation is by fingerprint, and a row without one reads as "this
  // row has never been seen" — so a store whose fingerprints were never filled
  // in would say that the whole corpus is new, and the cycle would re-embed
  // all 277,857 of them. That is an expensive mistake to make by accident, so
  // it is made on purpose instead: the count is asked for first, and a store
  // that is not ready stops the cycle with a message that says what to run.
  const counts = await env.CIVIC_DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN text_hash IS NULL THEN 1 ELSE 0 END) AS unhashed
       FROM statute_sections
      WHERE corpus_id = ?`,
  )
    .bind(CORPUS_ID)
    .first<{ total: number; unhashed: number }>();
  const unhashed = counts?.unhashed ?? 0;
  if (unhashed > 0) {
    throw new Error(
      `${unhashed} of ${counts?.total ?? 0} row(s) in ${CORPUS_ID} have no fingerprint. ` +
        `Run \`bun scripts/backfill-fingerprints.ts\` before the pipeline writes to this store.`,
    );
  }

  const run = await runIncrementalPipeline({
    corpusId: CORPUS_ID,
    previous: {
      commit: state.commit,
      date: state.commitDate,
      rowCount: state.rowCount,
    },
    next: { commit: head.commit, date: head.date },
    source,
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
  log(`  ${provisions} provision(s) in the changed file(s)`);
  return {
    ok: true,
    at: head.commit,
    counts: run.counts,
    embedded: run.embedded,
    durationMs: run.durationMs,
  };
}
