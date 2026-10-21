/**
 * The cycle, incrementally.
 *
 * The whole corpus does not fit in a Worker: 878 MB of tarball, eighty
 * seconds of parsing, and thirty seconds of CPU. A commit that moves the
 * corpus moves a few dozen files, though, and GitHub will say which ones —
 * so the cycle fetches the files that changed, parses those, and leaves the
 * rest alone.
 *
 * ## Where "before" comes from
 *
 * The removals are the hard part of an incremental ingest, and the answer is
 * that **the base revision is the store's revision**. The store says which
 * revision it is at; that revision's copy of a changed file is what the store
 * holds, and the difference between it and the new copy is exactly what
 * changed.
 *
 * So a file is fetched twice — once at the base, once at the head — and:
 *
 * - a provision in the new copy and not in the old one is **added**;
 * - a provision in both, whose fingerprint differs, is **changed**;
 * - a provision in the old copy and not in the new one is **removed**.
 *
 * The removed ones are the ones a full ingest would have found by diffing the
 * whole corpus, and finding them this way means the store's own list of rows
 * is never read — which is what keeps the cycle inside its budget.
 *
 * ## The one thing that can go wrong
 *
 * GitHub's compare endpoint names **at most 300 files** and does not say that
 * it has stopped early. A change list that is exactly 300 long might be
 * longer, and a cycle that trusted it would quietly leave part of the corpus
 * stale. So the list is checked, and a cut-short comparison stops the cycle
 * with an error instead of pretending it did the work.
 */
import { rowsForFile } from './corpus-rows';
import {
  embeddableText,
  type ChangeFeedEntry,
  type CorpusStore,
  type Encoder,
  type PipelineRow,
  type UpsertRow,
} from './pipeline';
import { fingerprint, type PipelineRun } from './reconcile';
import type { CorpusSource } from './source';

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
 * One cycle, over the files that changed.
 */
export async function runIncrementalPipeline(options: {
  corpusId: string;
  /** The revision the store is at, and how many rows it holds. */
  previous: { commit: string; date: string; rowCount?: number };
  /** The revision the corpus is moving to. */
  next: { commit: string; date: string };
  source: CorpusSource;
  store: CorpusStore;
  encoder: Encoder;
  now: Date;
  logger?: (line: string) => void;
}): Promise<PipelineRun> {
  const started = Date.now();
  const log = options.logger ?? (() => {});
  const { corpusId, previous, next, source, store, encoder } = options;

  const change = await source.changedFiles(previous.commit, next.commit);
  if (change.truncated) {
    throw new Error(
      `the comparison between ${previous.commit.slice(0, 9)} and ${next.commit.slice(0, 9)} ` +
        `names more files than GitHub will return, so the change list is incomplete. ` +
        `The whole corpus would have to be ingested, and a Worker cannot do that in one invocation.`,
    );
  }
  log(`${corpusId}: ${change.files.length} file(s) changed between ${previous.commit.slice(0, 9)} and ${next.commit.slice(0, 9)}`);

  // What the changed files held before, and what they hold now.
  const before = new Map<string, PipelineRow>();
  const after = new Map<string, PipelineRow>();
  for (const file of change.files) {
    const oldPath = file.previousPath ?? file.path;
    const oldContent =
      file.status === 'added' ? null : await source.fileAt(oldPath, previous.commit);
    const newContent =
      file.status === 'removed' ? null : await source.fileAt(file.path, next.commit);
    for (const row of oldContent === null
      ? []
      : rowsForFile({ path: oldPath, content: oldContent, date: previous.date, corpusId })) {
      before.set(row.id, row);
    }
    for (const row of newContent === null
      ? []
      : rowsForFile({ path: file.path, content: newContent, date: next.date, corpusId })) {
      after.set(row.id, row);
    }
  }

  let added = 0;
  let changed = 0;
  let unchanged = 0;
  let embedded = 0;
  const feed: ChangeFeedEntry[] = [];
  const toWrite: UpsertRow[] = [];
  const removedIds: string[] = [];

  // The removals: a provision the old copy had and the new copy does not.
  //
  // The check is against **every** new row, not just this file's — a
  // provision that moved from one file to another is not a removal.
  for (const [id, row] of before) {
    if (after.has(id)) continue;
    removedIds.push(id);
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
      sourceUrl: row.source_url,
      occurredAt: next.date,
    });
  }

  for (const [id, row] of after) {
    const old = before.get(id);
    if (old && fingerprint(old) === fingerprint(row)) {
      unchanged++;
      continue;
    }
    if (old) {
      changed++;
      feed.push(feedEntry(corpusId, 'changed', row, next.date));
    } else {
      added++;
      feed.push(feedEntry(corpusId, 'added', row, next.date));
    }
    toWrite.push({ row, hash: fingerprint(row), embedding: null });
  }

  // The embeddings, for the rows that changed and are worth embedding.
  const indexable = toWrite.filter((entry) => entry.row.status !== 'placeholder');
  const embeddings = new Map<string, number[]>();
  for (let i = 0; i < indexable.length; i += EMBED_BATCH) {
    const chunk = indexable.slice(i, i + EMBED_BATCH);
    const vectors = await encoder.embed(chunk.map((entry) => embeddableText(entry.row)));
    if (vectors.length !== chunk.length) {
      throw new Error(
        `the encoder returned ${vectors.length} vectors for ${chunk.length} documents`,
      );
    }
    chunk.forEach((entry, index) => embeddings.set(entry.row.id, vectors[index]!));
  }
  embedded = indexable.length;
  for (const entry of toWrite) {
    entry.embedding = embeddings.get(entry.row.id) ?? null;
  }

  // The rows first, then the removals: a row that is written and then
  // removed would be a provision the corpus holds and the store does not.
  if (toWrite.length > 0) await store.upsert(toWrite);
  if (removedIds.length > 0) await store.remove(removedIds);

  await store.recordChanges(feed);
  log(
    `${corpusId}: ${added} added, ${changed} changed, ${removedIds.length} removed, ${unchanged} unchanged`,
  );

  const run: PipelineRun = {
    corpusId,
    commit: next.commit,
    commitDate: next.date,
    ranAt: options.now.toISOString(),
    counts: { added, changed, removed: removedIds.length, unchanged },
    embedded,
    durationMs: Date.now() - started,
    ok: true,
  };
  await store.recordRun(run);
  await store.setState({
    corpusId,
    commit: next.commit,
    commitDate: next.date,
    asOf: next.date,
    rowCount: (previous.rowCount ?? after.size) + added - removedIds.length,
    lastRunAt: options.now.toISOString(),
  });
  return run;
}
