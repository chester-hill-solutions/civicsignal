import { SNAPSHOT_PARSER_VERSION } from './snapshot-format';
/**
 * The pipeline, streamed.
 *
 * `runPipeline` takes every row of the corpus at once, and the corpus is
 * 277,857 rows of statute text — several hundred megabytes as JavaScript
 * objects. A Railway service can hold that; a Worker has 128 MB and cannot.
 *
 * So the cycle is written the way the Workers runtime needs it: **the rows
 * arrive one instrument at a time, and only the rows that changed are ever
 * held.** The reconciliation is the same — a provision whose fingerprint has
 * not changed has not changed — but it is done *as the rows stream past*, so
 * the memory is the store's fingerprints and one batch of changed rows.
 *
 * ## The removals
 *
 * A provision that is no longer in the corpus has to be found, and the way to
 * find it is the store's own list: the rows the corpus did not mention. The
 * fingerprints are read once and **deleted as the corpus is seen**, so what is
 * left at the end is exactly what went away — and the map shrinks as it goes,
 * rather than growing.
 */
import { embeddableText, type ChangeFeedEntry, type CorpusStore, type Encoder, type PipelineRow, type UpsertRow } from './pipeline';
import { fingerprint, type PipelineRun } from './reconcile';

/** How many rows are written at a time. */
const WRITE_BATCH = 64;

/** How many rows are embedded at a time. */
const EMBED_BATCH = 32;

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

/**
 * One cycle, streamed.
 *
 * The rows are consumed from `options.rows` and are never all held: the
 * reconciliation happens as they pass, and the writes go out in batches.
 */
export async function runStreamingPipeline(options: {
  corpusId: string;
  /** The revision the corpus is moving to. */
  next: { commit: string; date: string };
  /** The corpus's rows, one instrument at a time. */
  rows: AsyncGenerator<PipelineRow>;
  store: CorpusStore;
  encoder: Encoder;
  now: Date;
  logger?: (line: string) => void;
  /**
   * How many rows are written at a time.
   *
   * A batch is the unit of work the pipeline can lose: if the invocation dies
   * mid-batch, that batch is written again next time, and writing it again is
   * harmless — the writes are upserts. So the batch is a trade, not a
   * correctness question: bigger batches mean fewer encoder calls, smaller
   * batches mean less work thrown away when something goes wrong.
   */
  batchSize?: number;
}): Promise<PipelineRun> {
  const started = Date.now();
  const log = options.logger ?? (() => {});
  const { corpusId, next, store, encoder } = options;
  const writeBatch = options.batchSize ?? WRITE_BATCH;

  // The store's fingerprints, keyed by row id. This is the whole of the
  // reconciliation's memory, and it is read once.
  await store.recoverPendingWrites();
  const stored = await store.fingerprints();

  let added = 0;
  let changed = 0;
  let unchanged = 0;
  let embedded = 0;
  const changes: ChangeFeedEntry[] = [];
  const batch: PipelineRow[] = [];

  /** Embed and write the batch, then empty it. */
  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    const indexable = batch.filter((row) => row.status !== 'placeholder');
    const embeddings = new Map<string, number[]>();
    for (let i = 0; i < indexable.length; i += EMBED_BATCH) {
      const chunk = indexable.slice(i, i + EMBED_BATCH);
      const vectors = await encoder.embed(chunk.map((row) => embeddableText(row)));
      if (vectors.length !== chunk.length) {
        throw new Error(`the encoder returned ${vectors.length} vectors for ${chunk.length} documents`);
      }
      chunk.forEach((row, index) => embeddings.set(row.id, vectors[index]!));
    }
    embedded += indexable.length;

    const upserts: UpsertRow[] = batch.map((row) => ({
      row,
      hash: fingerprint(row),
      embedding: embeddings.get(row.id) ?? null,
    }));
    await store.applyBatch({
      corpusId, revision: next.commit, occurredAt: next.date,
      upserts, removedIds: [], changes: changes.splice(0),
    });
    batch.length = 0;
  }

  for await (const row of options.rows) {
    const previous = stored.get(row.id);
    // The corpus has this row, so it is not a removal — whether or not it
    // changed.
    stored.delete(row.id);
    if (previous === fingerprint(row)) {
      unchanged++;
      continue;
    }
    if (previous === undefined) {
      added++;
      changes.push(feedEntry(corpusId, 'added', row, next.date));
    } else {
      changed++;
      changes.push(feedEntry(corpusId, 'changed', row, next.date));
    }
    batch.push(row);
    if (batch.length >= writeBatch) await flush();
  }
  await flush();

  // What is left in the store is what the corpus no longer holds.
  const removedIds = [...stored.keys()];
  await store.applyBatch({
    corpusId, revision: next.commit, occurredAt: next.date,
    upserts: [], removedIds, changes: [],
  });

  log(
    `${corpusId}: ${added} added, ${changed} changed, ${removedIds.length} removed, ${unchanged} unchanged`,
  );


  const run: PipelineRun = {
    parserVersion: SNAPSHOT_PARSER_VERSION,
    corpusId,
    commit: next.commit,
    commitDate: next.date,
    ranAt: options.now.toISOString(),
    counts: { added, changed, removed: removedIds.length, unchanged },
    embedded,
    durationMs: Date.now() - started,
    ok: true,
  };
  await store.finishRun(run, {
    parserVersion: SNAPSHOT_PARSER_VERSION,
    corpusId,
    commit: next.commit,
    commitDate: next.date,
    asOf: next.date,
    rowCount: unchanged + added + changed,
    lastRunAt: options.now.toISOString(),
  });
  return run;
}
