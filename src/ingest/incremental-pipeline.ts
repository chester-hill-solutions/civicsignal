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
import type { ChangedFile, CorpusRevision, CorpusSource } from './source';

/** How many rows are embedded at a time. */
const EMBED_BATCH = 32;

/** Release each file's XML before fetching the next. Yield in source order so
 * repeated provision IDs follow the same precedence as the file comparison. */
async function* changedRows(
  source: CorpusSource, files: ChangedFile[], revision: CorpusRevision, corpusId: string, previous: boolean,
): AsyncGenerator<PipelineRow> {
  for (const file of files) {
    if (file.status === (previous ? 'added' : 'removed')) continue;
    const path = previous ? file.previousPath ?? file.path : file.path;
    const content = await source.fileAt(path, revision.commit);
    if (content !== null) yield* rowsForFile({ path, content, date: revision.date, corpusId });
  }
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

  const before = new Map<string, string>();
  for await (const row of changedRows(source, change.files, previous, corpusId, true)) {
    before.set(row.id, fingerprint(row));
  }
  // Keep unchanged IDs so a provision that moved between files remains visible
  // to the removal check. Only added or changed rows retain their text.
  const after = new Map<string, UpsertRow | null>();
  for await (const row of changedRows(source, change.files, next, corpusId, false)) {
    const hash = fingerprint(row);
    after.set(row.id, before.get(row.id) === hash ? null : { row, hash, embedding: null });
  }

  let added = 0;
  let changed = 0;
  let unchanged = 0;
  const feed: ChangeFeedEntry[] = [];
  const toWrite: UpsertRow[] = [];
  const removedIds = [...before.keys()].filter(id => !after.has(id));
  for (const [id, entry] of after) {
    if (!entry) {
      unchanged++;
      continue;
    }
    const exists = before.has(id);
    if (exists) changed++;
    else added++;
    feed.push(feedEntry(corpusId, exists ? 'changed' : 'added', entry.row, next.date));
    toWrite.push(entry);
  }

  const indexable = toWrite.filter(entry => entry.row.status !== 'placeholder');
  for (let i = 0; i < indexable.length; i += EMBED_BATCH) {
    const chunk = indexable.slice(i, i + EMBED_BATCH);
    const vectors = await encoder.embed(chunk.map(entry => embeddableText(entry.row)));
    if (vectors.length !== chunk.length) {
      throw new Error(
        `the encoder returned ${vectors.length} vectors for ${chunk.length} documents`,
      );
    }
    chunk.forEach((entry, index) => { entry.embedding = vectors[index]!; });
  }

  await store.applyBatch({
    corpusId, revision: next.commit, occurredAt: next.date,
    upserts: toWrite, removedIds,
    changes: feed,
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
    embedded: indexable.length,
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
