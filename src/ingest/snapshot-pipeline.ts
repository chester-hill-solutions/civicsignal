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
 * So the cycle is:
 *
 *   1. read the snapshot's index (about twenty-five megabytes);
 *   2. read the store's fingerprints;
 *   3. diff them — what moved, what went, what came;
 *   4. fetch only the rows that moved, by byte range;
 *   5. embed and write them, and remove the ones that went.
 */
import { diffSnapshot, type SnapshotDiff } from './snapshot-diff';
import type { R2SnapshotSource } from './snapshot-source';
import {
  embeddableText,
  type ChangeFeedEntry,
  type CorpusStore,
  type Encoder,
  type PipelineRow,
  type UpsertRow,
} from './pipeline';
import { fingerprint, type PipelineRun } from './reconcile';

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

export async function runSnapshotPipeline(options: {
  corpusId: string;
  /** The revision the snapshot is at, and its date. */
  revision: { commit: string; date: string };
  source: R2SnapshotSource;
  store: CorpusStore;
  encoder: Encoder;
  now: Date;
  logger?: (line: string) => void;
}): Promise<PipelineRun> {
  const started = Date.now();
  const log = options.logger ?? (() => {});
  const { corpusId, revision, source, store, encoder } = options;

  const index = await source.index();
  const fingerprints = new Map<string, string>();
  for (const [id, entry] of index) fingerprints.set(id, entry.fp);

  const held = await store.fingerprints();
  const diff: SnapshotDiff = diffSnapshot(held, fingerprints);
  log(
    `${corpusId}: ${diff.changed.length} changed, ${diff.gone.length} gone, ${diff.came.length} came`,
  );

  const writeIds = [...diff.changed, ...diff.came];
  const rows = await source.rows(writeIds, index);

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

  const upserts: UpsertRow[] = rows.map((row) => ({
    row,
    hash: fingerprint(row),
    embedding: embeddings.get(row.id) ?? null,
  }));
  const feed: ChangeFeedEntry[] = rows.map((row) =>
    feedEntry(
      corpusId,
      diff.came.includes(row.id) ? 'added' : 'changed',
      row,
      revision.date,
    ),
  );

  // The rows first, then the removals: a row that is written and then
  // removed would be a provision the corpus holds and the store does not.
  if (upserts.length > 0) await store.upsert(upserts);
  if (diff.gone.length > 0) {
    const removed = await store.remove(diff.gone);
    for (const row of removed) {
      feed.push({
        corpusId,
        change: 'removed',
        rowId: row.id,
        instrument: row.instrument,
        citation: row.citation,
        section: row.section,
        heading: row.heading,
        status: row.status,
        summary: null,
        sourceUrl: row.sourceUrl,
        occurredAt: revision.date,
      });
    }
  }

  await store.recordChanges(feed);
  const counts = {
    added: diff.came.length,
    changed: diff.changed.length,
    removed: diff.gone.length,
    unchanged: Math.max(0, held.size - diff.changed.length - diff.gone.length),
  };
  log(`${corpusId}: ${counts.added} added, ${counts.changed} changed, ${counts.removed} removed`);

  const run: PipelineRun = {
    corpusId,
    commit: revision.commit,
    commitDate: revision.date,
    ranAt: options.now.toISOString(),
    counts,
    embedded: indexable.length,
    durationMs: Date.now() - started,
    ok: true,
  };
  await store.recordRun(run);
  await store.setState({
    corpusId,
    commit: revision.commit,
    commitDate: revision.date,
    asOf: revision.date,
    rowCount: held.size + counts.added - counts.removed,
    lastRunAt: options.now.toISOString(),
  });
  return run;
}
