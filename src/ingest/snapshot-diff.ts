/**
 * The diff, between a store and a snapshot.
 *
 * The pipeline's reconciliation used to be a comparison of two *revisions*:
 * the store's revision against the corpus's head, with GitHub naming the
 * files that differed in between. That has a ceiling — the compare endpoint
 * names at most 300 files — so a store that has fallen behind cannot catch
 * up in one step however big the gap is.
 *
 * A snapshot has no such ceiling, because the comparison is not over files.
 * It is over **provisions**, and both sides of it are already index files:
 *
 * - the store holds a fingerprint for every provision it has;
 * - the snapshot's index holds a fingerprint for every provision the corpus
 *   has, at the head.
 *
 * So the diff is those two lists compared, and the gap between the store's
 * revision and the head is not a number of commits — it is not a number of
 * anything. A store that is one week behind and a store that is one year
 * behind are the same amount of work.
 *
 * The three outcomes:
 *
 * - **changed** — the fingerprint differs. The provision's text moved.
 * - **gone** — the store has it and the snapshot does not. The corpus no
 *   longer holds it, and the store must let it go.
 * - **came** — the snapshot has it and the store does not. The corpus holds
 *   a provision the store has never seen.
 */
import type { FingerprintedRow, FingerprintEntry } from './reconcile';

/** One line of a snapshot's index. */
export interface SnapshotIndexEntry {
  id: string;
  fp: string;
  /** The byte offset of the row in the snapshot's rows file. */
  off: number;
  /** The byte length of the row. */
  len: number;
}

/** What changed between a store and a snapshot. */
export interface SnapshotDiff {
  /** The provisions whose text moved. */
  changed: string[];
  /** The provisions the corpus no longer holds. */
  gone: string[];
  /** The provisions the store has never seen. */
  came: string[];
}

/**
 * The diff between what the store holds and what the snapshot holds.
 *
 * The store's fingerprints are keyed by provision id, and the snapshot's
 * index is the same — so this is two maps compared, and the result is
 * whichever side each id is on.
 *
 * The order is the snapshot's order, because that is the order the rows are
 * in the file, and a caller that fetches the changed rows wants them in the
 * order it will read them.
 */
export function diffSnapshot(
  store: Map<string, string>,
  snapshot: Map<string, string>,
): SnapshotDiff {
  const changed: string[] = [];
  const came: string[] = [];
  const gone: string[] = [];

  for (const [id, fingerprint] of snapshot) {
    const held = store.get(id);
    if (held === undefined) came.push(id);
    else if (held !== fingerprint) changed.push(id);
  }
  for (const id of store.keys()) {
    if (!snapshot.has(id)) gone.push(id);
  }

  return { changed, gone, came };
}

/** A snapshot's index, read from its lines. */
export function parseSnapshotIndex(lines: string): Map<string, string> {
  const fingerprints = new Map<string, string>();
  for (const line of lines.split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as SnapshotIndexEntry;
    fingerprints.set(entry.id, entry.fp);
  }
  return fingerprints;
}

/**
 * The rows the diff says to write, and the ones to remove.
 *
 * A diff is a list of ids; the caller needs to know which of them are new
 * enough to be worth embedding, and the answer is in the fingerprint: a
 * provision whose fingerprint is unchanged has not changed, and a provision
 * the store does not have has to be embedded whatever its fingerprint says.
 */
export function partitionByNovelty(
  diff: SnapshotDiff,
  store: Map<string, string>,
): { toEmbed: string[]; toRemove: string[] } {
  return {
    toEmbed: [...diff.changed, ...diff.came],
    toRemove: diff.gone,
  };
}

/** A row's fingerprint, for the store's own comparison. */
export type { FingerprintedRow, FingerprintEntry };

/** One batch of the merge: the same three outcomes, in pieces. */
export interface SnapshotDiffBatch {
  changed: SnapshotIndexEntry[];
  came: SnapshotIndexEntry[];
  gone: string[];
  /**
   * How many provisions the two sides agree on, counted rather than listed.
   *
   * They are the ones the cycle does nothing about, which is almost all of
   * them, so they are a number — a list of a quarter of a million ids that
   * were already correct is exactly the memory this exists to avoid.
   */
  same: number;
}

/** A stream with one item of lookahead, so two of them can be merged. */
function peekable<T>(source: AsyncIterable<T>) {
  const iterator = source[Symbol.asyncIterator]();
  let ahead: T | null = null;
  let exhausted = false;
  return {
    async peek(): Promise<T | null> {
      if (ahead === null && !exhausted) {
        const next = await iterator.next();
        if (next.done) exhausted = true;
        else ahead = next.value;
      }
      return ahead;
    },
    async take(): Promise<T | null> {
      const value = await this.peek();
      if (value !== null) ahead = null;
      return value;
    },
  };
}

/**
 * The same diff, as a merge of two sorted streams.
 *
 * `diffSnapshot` compares two maps, and a map of a quarter of a million
 * provisions costs more than a Worker has. The index alone is eighty
 * megabytes held as objects, and the store's fingerprints are another thirty
 * — a hundred and thirty-seven before a single row is read, against a ceiling
 * of a hundred and twenty-eight.
 *
 * Neither side has to be held, though, because **both are already in id
 * order**: the snapshot's index is written in the order the rows are in, and
 * D1 will page its fingerprints `WHERE id > ? ORDER BY id`. So the diff is a
 * merge of two cursors, and what is in memory at any moment is one page of
 * each — kilobytes rather than megabytes.
 *
 * The batches are yielded as they fill, which is also what lets the cycle
 * write as it goes instead of collecting every changed provision in the
 * corpus before touching the store.
 */
export async function* diffSnapshotStream(
  index: AsyncIterable<SnapshotIndexEntry>,
  store: AsyncIterable<FingerprintEntry>,
  options: { batchSize?: number } = {},
): AsyncGenerator<SnapshotDiffBatch> {
  const batchSize = options.batchSize ?? 1000;
  const left = peekable(index);
  const right = peekable(store);

  let batch: SnapshotDiffBatch = { changed: [], came: [], gone: [], same: 0 };
  const size = () => batch.changed.length + batch.came.length + batch.gone.length;

  for (;;) {
    const fromIndex = await left.peek();
    const fromStore = await right.peek();
    if (fromIndex === null && fromStore === null) break;

    if (fromStore === null || (fromIndex !== null && fromIndex.id < fromStore.id)) {
      batch.came.push((await left.take())!);
    } else if (fromIndex === null || fromStore.id < fromIndex.id) {
      batch.gone.push((await right.take())!.id);
    } else {
      if (fromIndex.fp !== fromStore.fp) batch.changed.push(fromIndex);
      else batch.same++;
      await left.take();
      await right.take();
    }

    if (size() >= batchSize) {
      yield batch;
      batch = { changed: [], came: [], gone: [], same: 0 };
    }
  }

  // The last batch goes out even when it holds no work, because the count of
  // what the two sides *agreed* on is part of what the diff says — and a
  // cycle that found nothing to do still has to know how big the corpus is.
  if (size() > 0 || batch.same > 0) yield batch;
}
