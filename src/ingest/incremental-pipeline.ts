import { SNAPSHOT_PARSER_VERSION } from './snapshot-format';
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

/**
 * Run `work` over `items`, a few at a time.
 *
 * The changed files come from GitHub, and one at a time is two round trips per
 * file — ninety-six for a commit that moved forty-eight files, which is three
 * and a half minutes of waiting for something that takes half a minute when
 * eight are in flight at once. The limit is what keeps the cycle from opening
 * six hundred connections at once and being refused by the other end.
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

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
  /**
   * The revision the store is at, and **how many rows it holds**.
   *
   * The count is not optional, because the state this cycle writes is a
   * *total* — the previous count, plus what this cycle did. A cycle that was
   * not told the count would have to guess, and the guess it used to make was
   * the provisions in the files that changed: the size of a commit, written
   * into the corpus's size. It is wrong by three orders of magnitude, nothing
   * downstream can tell, and the next cycle would carry it forward.
   */
  previous: { commit: string; date: string; rowCount: number };
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

  await store.recoverPendingWrites();
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
  //
  // The files are fetched **concurrently**. One at a time is two round trips
  // per file — ninety-six of them for a commit that moved forty-eight files,
  // which is three and a half minutes of waiting for something that takes
  // half a minute when eight are in flight at once.
  const before = new Map<string, PipelineRow>();
  const after = new Map<string, PipelineRow>();
  const oldContents = await mapWithLimit(change.files, 8, (file) =>
    file.status === 'added'
      ? Promise.resolve(null)
      : source.fileAt(file.previousPath ?? file.path, previous.commit),
  );
  const newContents = await mapWithLimit(change.files, 8, (file) =>
    file.status === 'removed'
      ? Promise.resolve(null)
      : source.fileAt(file.path, next.commit),
  );
  for (const [index, file] of change.files.entries()) {
    const oldPath = file.previousPath ?? file.path;
    for (const row of oldContents[index] === null
      ? []
      : rowsForFile({
          path: oldPath,
          content: oldContents[index]!,
          date: previous.date,
          corpusId,
        })) {
      before.set(row.id, row);
    }
    for (const row of newContents[index] === null
      ? []
      : rowsForFile({
          path: file.path,
          content: newContents[index]!,
          date: next.date,
          corpusId,
        })) {
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

  await store.applyBatch({
    corpusId, revision: next.commit, occurredAt: next.date,
    upserts: toWrite, removedIds,
    changes: feed.filter((entry) => entry.change !== 'removed'),
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
    rowCount: previous.rowCount + added - removedIds.length,
    lastRunAt: options.now.toISOString(),
  });
  return run;
}
