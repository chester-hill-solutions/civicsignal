import { SNAPSHOT_PARSER_VERSION } from './snapshot-format';
/**
 * The cycle, over a snapshot.
 *
 * The other cycle diffs two **revisions**, with GitHub naming the files that
 * differ between them — and the compare endpoint names at most 300 files, so
 * a store that has fallen behind cannot catch up in one step.
 *
 * This one diffs two **indexes**: the snapshot's, and the store's own
 * fingerprints. The store is a snapshot of its revision. The corpus is a
 * snapshot of the head. Comparing the two is the whole reconciliation, and
 * the gap between the store's revision and the head is not a number of
 * commits — it is not a number of anything.
 *
 * ## Why it streams
 *
 * Neither index is ever held. A quarter of a million provisions as a `Map` is
 * eighty megabytes, the store's fingerprints are thirty more, and a Worker
 * has a hundred and twenty-eight — before a single row has been read. So the
 * diff is a **merge of two cursors**: the snapshot's index is read a line at a
 * time, the store's fingerprints a page at a time, and what is in memory is
 * the batch being written.
 *
 * ## Why it has a budget
 *
 * A store a year behind is two hundred thousand provisions to fetch, embed
 * and write, and one invocation cannot do that — the encoder alone would take
 * hours. So a cycle writes a bounded number of provisions and stops, and the
 * next one continues.
 *
 * Nothing has to be remembered for that to work, and that is the elegant
 * part: **the fingerprints are the progress**. A provision that has been
 * written no longer differs from the snapshot, so the next diff does not
 * mention it. A cycle that dies half way leaves the store consistent and
 * simply resumes.
 *
 * The state — the revision the store is at — is only advanced when the diff
 * has been exhausted, because until then the store is at no revision: it is
 * part of the way from one to another, which is exactly what its fingerprints
 * say.
 */
import { diffSnapshotStream } from './snapshot-diff';
import type { SnapshotSource } from './snapshot-source';
import {
  embeddableText,
  EMBED_BATCH,
  type ChangeFeedEntry,
  type CorpusStore,
  type Encoder,
  type PipelineRow,
  type UpsertRow,
} from './pipeline';
import { fingerprint, type PipelineRun } from './reconcile';

/**
 * How many provisions one cycle writes before it stops.
 *
 * A bound on the invocation rather than on the design: two thousand
 * provisions is sixty-three calls to the encoder, and the next cycle picks up
 * where this one stopped. Raise it once the encoder's throughput is measured;
 * nothing depends on the number being this one.
 */
const DEFAULT_MAX_ROWS = 2000;

/** Commit a successful provider batch before submitting another. An interrupted
 * or uncertain provider call can still spend attempts without a durable row. */
const BATCH_SIZE = EMBED_BATCH;

/** The change feed's entry, built from a row. */
function feedEntry(
  corpusId: string,
  change: 'added' | 'changed',
  row: PipelineRow,
  occurredAt: string,
): ChangeFeedEntry {
  return {
    corpusId,
    change,
    rowId: row.id,
    instrument: row.instrument,
    citation: row.citation,
    section: row.section,
    heading: row.heading,
    status: row.status,
    summary: row.text.slice(0, 280),
    sourceUrl: row.source_url,
    occurredAt,
  };
}

export async function runSnapshotPipeline(options: {
  corpusId: string;
  /** The revision the snapshot is at, and its date. */
  revision: { commit: string; date: string };
  source: SnapshotSource;
  store: CorpusStore;
  encoder: Encoder;
  now: Date;
  /** The most provisions this invocation will write. */
  maxRows?: number;
  logger?: (line: string) => void;
}): Promise<PipelineRun> {
  const started = Date.now();
  const log = options.logger ?? (() => {});
  const { corpusId, revision, source, store, encoder } = options;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;

  await store.recoverPendingWrites();
  let added = 0;
  let changed = 0;
  let removed = 0;
  let unchanged = 0;
  let embedded = 0;
  let written = 0;
  let exhausted = true;

  const batches = diffSnapshotStream(source.indexEntries(), store.fingerprintEntries(), {
    batchSize: BATCH_SIZE,
  });

  for await (const batch of batches) {
    if (written >= maxRows) {
      exhausted = false;
      break;
    }

    // The budget is the number written, not the number of batches: a batch
    // that would overshoot is taken up to the budget and no further, and what
    // is left of it is still in the diff — its fingerprint has not been
    // written, so the next cycle finds it exactly where this one stopped.
    const decided = [...batch.changed, ...batch.came];
    const entries = decided.slice(0, maxRows - written);
    // What the budget left behind is still in the diff, and the store is
    // still behind it.
    if (entries.length < decided.length) exhausted = false;

    const rows = await source.rows(entries);
    if (rows.length !== entries.length) {
      throw new Error(
        `the snapshot at ${revision.commit.slice(0, 9)} has no row for ` +
          `${entries.length - rows.length} of the ${entries.length} provision(s) its index names`,
      );
    }

    // The embeddings, for the rows that moved and are worth embedding.
    const indexable = rows.filter((row) => row.status !== 'placeholder');
    const embeddings = new Map<string, number[]>();
    for (let i = 0; i < indexable.length; i += EMBED_BATCH) {
      const chunk = indexable.slice(i, i + EMBED_BATCH);
      const vectors = await encoder.embed(chunk.map((row) => embeddableText(row)));
      if (vectors.length !== chunk.length) {
        throw new Error(
          `the encoder returned ${vectors.length} vectors for ${chunk.length} documents`,
        );
      }
      chunk.forEach((row, index) => embeddings.set(row.id, vectors[index]!));
    }
    embedded += indexable.length;

    const cameIds = new Set(batch.came.map((entry) => entry.id));
    const upserts: UpsertRow[] = [];
    const feed: ChangeFeedEntry[] = [];
    for (const row of rows) {
      upserts.push({
        row,
        hash: fingerprint(row),
        embedding: embeddings.get(row.id) ?? null,
      });
      if (cameIds.has(row.id)) {
        added++;
        feed.push(feedEntry(corpusId, 'added', row, revision.date));
      } else {
        changed++;
        feed.push(feedEntry(corpusId, 'changed', row, revision.date));
      }
    }

    const removals = batch.gone.slice(0, Math.max(0, maxRows - written - rows.length));
    if (removals.length < batch.gone.length) exhausted = false;
    await store.applyBatch({
      corpusId, revision: revision.commit, occurredAt: revision.date,
      upserts, removedIds: removals, changes: feed,
    });
    removed += removals.length;

    unchanged += batch.same;
    written += rows.length + removals.length;
    log(
      `${corpusId}: ${added} added, ${changed} changed, ${removed} removed ` +
        `(${written} of this cycle's budget)`,
    );
  }

  const run: PipelineRun = {
    parserVersion: SNAPSHOT_PARSER_VERSION,
    corpusId,
    commit: revision.commit,
    commitDate: revision.date,
    ranAt: options.now.toISOString(),
    counts: { added, changed, removed, unchanged },
    embedded,
    durationMs: Date.now() - started,
    ok: true,
    remaining: !exhausted,
  };
  // The state is only advanced when the store is actually at the snapshot's
  // revision. Part of the way there is not a revision, and a state that said
  // otherwise would make the next cycle skip the rest of the gap.
  await store.finishRun(run, exhausted ? {
      parserVersion: SNAPSHOT_PARSER_VERSION,
      corpusId,
      commit: revision.commit,
      commitDate: revision.date,
      asOf: revision.date,
      // The store's size after this cycle is the snapshot's size, and the
      // snapshot is exactly three things: what the two sides agreed on, what
      // changed, and what came. The provisions that went are not in it.
      rowCount: unchanged + changed + added,
      lastRunAt: options.now.toISOString(),
    } : undefined);



  if (exhausted) {
    log(
      `${corpusId}: at ${revision.commit.slice(0, 9)} (${revision.date}) — ` +
        `${added} added, ${changed} changed, ${removed} removed, ${run.embedded} embedded`,
    );
  } else {
    log(
      `${corpusId}: ${written} provision(s) written, and the store is still behind — ` +
        `the next cycle continues from here`,
    );
  }
  return run;
}
