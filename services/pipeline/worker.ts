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
 *   3. reconcile the store against that revision, and write what changed
 *
 * The common case is step 2. The corpus repository moves every three to eight
 * days, so almost every invocation finds nothing to do and costs one request.
 *
 * ## Two ways to reconcile, and why there are two
 *
 * **The snapshot**, when one has been published for that revision. The store
 * holds a fingerprint for every provision it has; the snapshot's index holds
 * a fingerprint for every provision the corpus has. Comparing them is the
 * whole reconciliation, and the gap between the store's revision and the head
 * is not a number of commits — it is not a number of anything. That is the
 * one to use.
 *
 * **The files**, when no snapshot has been published. GitHub says which files
 * differ between two revisions, and the cycle fetches those. It is cheap and
 * it has a ceiling: the compare endpoint names at most three hundred files,
 * and it does not say when it has stopped early — so a store that has fallen
 * behind cannot catch up, and the cycle refuses rather than pretending.
 *
 * The fallback exists because the snapshot is built by a job of its own, and
 * a pipeline that stops working whenever that job is a revision behind is
 * worse than one that says which path it took.
 */
import { DurableObject } from 'cloudflare:workers';
import { CoordinatorAdmissionError, DurableSingleFlight, type CoordinatorObservation } from './single-flight';
import { readJsonBody, RequestInputError } from '../../src/http';
import { D1CorpusStore } from '../../src/corpora/d1-store';
import { CORPUS_ID } from '../../src/ingest/corpus-rows';
import { httpEncoder } from '../../src/ingest/encoder-client';
import { runIncrementalPipeline } from '../../src/ingest/incremental-pipeline';
import { runSnapshotPipeline } from '../../src/ingest/snapshot-pipeline';
import { SnapshotReader } from '../../src/ingest/snapshot-source';
import { manifestKey, SNAPSHOT_PARSER_VERSION } from '../../src/ingest/snapshot-format';
import { assertCorpusVectorExportCurrent, exportSnapshotVectors, parseVectorExportRequest, type VectorExportRequest } from './vector-export';
import { retainD1Text } from './options';
import { DurableAttemptBudget, pipelineControl, type PipelineControlEnv } from './attempt-budget';
import type { StageRecoveryAuthorization } from './staging-recovery-plan';
import { GitHubCorpusSource } from '../../src/ingest/source';

interface Env extends PipelineControlEnv {
  /** The corpus: the rows in D1, the vectors in Vectorize. */
  CIVIC_DB: D1Database;
  PIPELINE_COORDINATOR: DurableObjectNamespace<PipelineCoordinator>;
  VECTORIZE: Vectorize;
  /**
   * The corpus's snapshots: the rows and the index, one file per revision,
   * named for the corpus commit.
   *
   * This is what the cycle diffs against when it can. The other cycle asks
   * GitHub which files changed, and GitHub names at most three hundred of
   * them — so a store that has fallen behind cannot catch up. A snapshot has
   * no such ceiling: the comparison is over provisions.
   */
  CORPUS: R2Bucket;
  /** Keep true until the approved fresh-D1/strict-R2 cutover. */
  CORPUS_RETAIN_D1_TEXT?: string;
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
      const result = await coordinator(env).run();
      if (isCoordinatorRejection(result) && result.code !== 'suspended') throw new Error('The coordinator refused the scheduled invocation.');
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
    if (['/control', '/control/suspend', '/control/resume'].includes(url.pathname)) {
      if (!env.PIPELINE_SECRET || request.headers.get('x-pipeline-secret') !== env.PIPELINE_SECRET) return Response.json({ error: 'forbidden' }, { status: 403 });
      try {
        if (url.pathname === '/control' && request.method === 'GET') {
          return Response.json(await coordinator(env).controlStatus(), { headers: { 'cache-control': 'no-store' } });
        }
        if (url.pathname !== '/control' && request.method === 'POST') {
          const revision = parseControlRevision(await readJsonBody(request, 1024));
          const value = url.pathname.endsWith('/suspend') ? await coordinator(env).suspend(revision) : await coordinator(env).resume(revision);
          if (isCoordinatorRejection(value)) return rejectionResponse(value);
          return Response.json(value, { status: url.pathname.endsWith('/suspend') && !value.coordinator.quiescent ? 202 : 200,
            headers: { 'cache-control': 'no-store' } });
        }
        return Response.json({ error: 'method not allowed' }, { status: 405, headers: { allow: url.pathname === '/control' ? 'GET' : 'POST' } });
      } catch (error) { return administrativeError(error); }
    }
    if (url.pathname === '/run' && request.method === 'POST') {
      const presented = request.headers.get('x-pipeline-secret') ?? '';
      if (!env.PIPELINE_SECRET || presented !== env.PIPELINE_SECRET) {
        return Response.json({ error: 'forbidden' }, { status: 403 });
      }
      // Awaited, for the same reason the cron awaits: a `waitUntil` task is
      // cancelled thirty seconds after the response goes out, and the cycle
      // takes longer than that.
      try {
        const summary = await coordinator(env).run();
        return isCoordinatorRejection(summary) ? rejectionResponse(summary) : Response.json(summary);
      } catch (error) { return administrativeError(error); }
    }

    // **The vectors, out of the index and into the snapshot.**
    //
    // This is here rather than in a script because it cannot be a script: the
    // Vectorize **REST** list endpoint returns ids and no values, and no
    // combination of `include_values`, `return_values` or `include=values`
    // changes that. The *binding* returns them, and a binding only exists
    // inside a Worker. So the export runs here, one part at a time, and writes
    // to R2 — which is where the snapshot is going anyway.
    if (url.pathname === '/vectors' && request.method === 'POST') {
      const presented = request.headers.get('x-pipeline-secret') ?? '';
      if (!env.PIPELINE_SECRET || presented !== env.PIPELINE_SECRET) {
        return Response.json({ error: 'forbidden' }, { status: 403 });
      }
      try {
        const suspensionRevision = parseSuspensionHeader(request.headers.get('x-pipeline-suspension-revision'));
        const json = await readJsonBody(request, 1024);
        let body: VectorExportRequest;
        try { body = parseVectorExportRequest(json); }
        catch { throw new RequestInputError('Invalid vector export request.'); }
        const result = await coordinator(env).exportVectors(body, suspensionRevision);
        if (isCoordinatorRejection(result)) return rejectionResponse(result);
        // This records admission for this one export, not a complete backup's
        // consistency. The caller still verifies the same pause after all parts.
        return Response.json(result, { headers: suspensionRevision === undefined ? {} :
          { 'x-pipeline-suspension-revision': String(suspensionRevision) } });
      } catch (error) { return administrativeError(error); }
    }

    return Response.json(
      {
        error: 'not found',
        hint: 'this Worker runs on a schedule; POST /run to run a cycle, POST /vectors to export vectors',
      },
      { status: 404 },
    );
  },
};

interface CoordinatorRejection { coordinatorRejected: true; code: string; error: string; status: 400 | 409 }
function isCoordinatorRejection(value: unknown): value is CoordinatorRejection {
  return value !== null && typeof value === 'object' && 'coordinatorRejected' in value && value.coordinatorRejected === true;
}
/** Plain refusals survive the DO RPC boundary without relying on custom Error prototypes. */
async function admitted<R>(work: () => Promise<R>): Promise<R | CoordinatorRejection> {
  try { return await work(); }
  catch (error) {
    if (error instanceof CoordinatorAdmissionError) return { coordinatorRejected: true, code: error.code, error: error.message, status: error.status };
    throw error;
  }
}
function rejectionResponse(value: CoordinatorRejection): Response {
  return Response.json({ error: value.error, code: value.code }, { status: value.status, headers: { 'cache-control': 'no-store' } });
}
function administrativeError(error: unknown): Response {
  return error instanceof RequestInputError
    ? Response.json({ error: error.message }, { status: error.status })
    : Response.json({ error: 'The pipeline operation is unavailable.' }, { status: 500 });
}
function parseControlRevision(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 ||
      !('expectedRevision' in value) || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) {
    throw new RequestInputError('Only a non-negative safe integer expectedRevision is accepted.');
  }
  return Number(value.expectedRevision);
}
function parseSuspensionHeader(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new RequestInputError('Invalid pipeline suspension revision header.');
  return Number(value);
}

/** One corpus has one durable writer, across cron and manual requests. */
export class PipelineCoordinator extends DurableObject<Env> {
  private readonly runner: DurableSingleFlight<CycleSummary>;
  private readonly budget: DurableAttemptBudget;
  constructor(ctx: DurableObjectState, env: Env, recovery?: StageRecoveryAuthorization) {
    super(ctx, env);
    this.budget = new DurableAttemptBudget(ctx.storage, pipelineControl(env), recovery);
    this.runner = new DurableSingleFlight(ctx.storage, () => cycle(this.env, this.budget), Date.now,
      { suspendOnFailure: recovery !== undefined });
    // Only checkpoint initialization is blocked; a corpus cycle can run for
    // minutes and must not sit in blockConcurrencyWhile's 30-second window.
    this.ctx.blockConcurrencyWhile(async () => { await this.budget.initialize(); await this.runner.initialize(); });
  }
  async run() { return admitted(() => this.runner.run()); }
  private async withBudget(observation: Promise<CoordinatorObservation>) {
    const [budget, status] = await Promise.all([this.budget.status(), observation]);
    return { ...budget, corpusId: CORPUS_ID, coordinatorId: this.ctx.id.toString(), coordinator: status };
  }
  async controlStatus() { return this.withBudget(this.runner.status()); }
  async suspend(revision: number) { return admitted(() => this.withBudget(this.runner.suspend(revision))); }
  async resume(revision: number) { return admitted(() => this.withBudget(this.runner.resume(revision))); }
  async alarm(): Promise<void> { await this.runner.alarm(); }
  async exportVectors(body: VectorExportRequest, suspensionRevision?: number) {
    return admitted(() => this.runner.exclusive(() => exportSnapshotVectors(body, {
      bucket: this.env.CORPUS, vector: this.env.VECTORIZE,
      assertCurrent: (entries, total) => assertCorpusVectorExportCurrent(this.env.CIVIC_DB, CORPUS_ID, body, entries, total),
    }), suspensionRevision));
  }
}

function coordinator(env: Env): DurableObjectStub<PipelineCoordinator> {
  return env.PIPELINE_COORDINATOR.get(env.PIPELINE_COORDINATOR.idFromName(CORPUS_ID));
}

/** What a cycle did, for the caller that asked for it by hand. */
interface CycleSummary {
  ok: boolean;
  /** The revision the corpus is at. */
  at: string;
  /** True when the store was already at that revision. */
  nothing?: boolean;
  /** Which reconciliation ran, and why it matters which. */
  cycle?: 'snapshot' | 'files';
  counts?: { added: number; changed: number; removed: number; unchanged: number };
  embedded?: number;
  durationMs?: number;
  /** True when the cycle stopped on its budget with the store still behind. */
  remaining?: boolean;
}

async function cycle(env: Env, budget: DurableAttemptBudget): Promise<CycleSummary> {
  const log = (line: string) => console.log(`${new Date().toISOString()}  ${line}`);
  const source = new GitHubCorpusSource({ token: env.GITHUB_TOKEN || undefined });
  const store = new D1CorpusStore(env.CIVIC_DB, env.VECTORIZE, CORPUS_ID, { textBucket: env.CORPUS,
    retainD1Text: retainD1Text(env.CORPUS_RETAIN_D1_TEXT, !!env.CORPUS) });
  await budget.initialize();
  const head = await source.head();
  budget.assertHead(head);
  const reader = new SnapshotReader(env.CORPUS, head.commit, { parser: SNAPSHOT_PARSER_VERSION });
  if (budget.control) budget.assertSnapshot(await reader.manifest());
  const encoder = httpEncoder({
    // Budget reservations are durable before the actual binding HTTP call.
    url: 'https://encoder', token: env.ENCODER_TOKEN,
    send: (request) => budget.sendEncoder(request, {
      head: () => source.head(), snapshot: () => reader.manifest(),
      send: (message) => env.ENCODER_SERVICE.fetch(message),
    }),
  });

  await store.recoverPendingWrites();
  const state = await store.currentCommit(CORPUS_ID);
  if (state && state.commit === head.commit && state.parserVersion === SNAPSHOT_PARSER_VERSION) {
    log(`already at ${head.commit.slice(0, 9)} (${head.date}) — nothing to do`);
    return { ok: true, at: head.commit, nothing: true };
  }
  log(`the corpus is at ${head.commit.slice(0, 9)} (${head.date})`);

  await assertFingerprinted(env);

  // **The snapshot, if there is one.**
  //
  // It is the path that can fill a gap of any size, and it needs nothing from
  // the store except its fingerprints — so it also works on a store that has
  // never been through a cycle, which the file path cannot.
  const snapshot = await env.CORPUS.head(manifestKey(head.commit, SNAPSHOT_PARSER_VERSION));
  if (snapshot) {
    log(`the snapshot at ${head.commit.slice(0, 9)} is published — diffing against its index`);
    const run = await runSnapshotPipeline({
      corpusId: CORPUS_ID,
      revision: { commit: head.commit, date: head.date },
      source: reader,
      store,
      encoder,
      now: new Date(),
      logger: log,
    });
    return {
      ok: true,
      at: head.commit,
      cycle: 'snapshot',
      counts: run.counts,
      embedded: run.embedded,
      durationMs: run.durationMs,
      remaining: run.remaining,
    };
  }

  if (budget.control) throw new Error('controlled pipeline cannot fall back without its matching parser-versioned snapshot');

  if (state && state.parserVersion !== SNAPSHOT_PARSER_VERSION) {
    throw new Error(`corpus parser ${state.parserVersion ?? 'legacy'} differs from ${SNAPSHOT_PARSER_VERSION}; ` +
      `publish the parser-versioned snapshot before reconciling this store`);
  }

  // **The files, when there is not.**
  //
  // The file cycle compares two revisions, so it needs to know which one the
  // store is at — and a store that has never been through a cycle does not
  // know, which is why that is an error here rather than a guess.
  if (!state) {
    throw new Error(
      `${CORPUS_ID} has no revision recorded in corpus_state, and there is no snapshot ` +
        `at ${head.commit.slice(0, 9)} to reconcile against. Run ` +
        `\`bun scripts/backfill-fingerprints.ts\` to prepare the store, or publish a snapshot.`,
    );
  }
  log(`no snapshot at ${head.commit.slice(0, 9)} — the file cycle, which GitHub caps at 300 files`);

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
    encoder,
    now: new Date(),
    logger: log,
  });

  const provisions = run.counts.added + run.counts.changed + run.counts.unchanged;
  log(`  ${provisions} provision(s) in the changed file(s)`);
  return {
    ok: true,
    at: head.commit,
    cycle: 'files',
    counts: run.counts,
    embedded: run.embedded,
    durationMs: run.durationMs,
  };
}

/**
 * The store has to be prepared.
 *
 * Both reconciliations are by fingerprint, and a row without one reads as
 * "this row has never been seen" — so a store whose fingerprints were never
 * filled in would say that the whole corpus is new, and the cycle would
 * re-embed all 277,857 of them. That is an expensive mistake to make by
 * accident, so it is made on purpose instead: the count is asked for first,
 * and a store that is not ready stops the cycle with a message that says what
 * to run.
 */
async function assertFingerprinted(env: Env): Promise<void> {
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
}
