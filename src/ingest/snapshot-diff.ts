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
import type { FingerprintedRow } from './reconcile';

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
export type { FingerprintedRow };
