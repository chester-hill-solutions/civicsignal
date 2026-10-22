/**
 * The corpus, as a snapshot in R2.
 *
 * The counterpart to `GitHubCorpusSource`: instead of a revision and a
 * tarball, a snapshot is an **index** and a **rows file**, and the index says
 * where every row is.
 *
 * The index is read whole — about twenty-five megabytes, and it is the diff.
 * The rows are read a few at a time, by byte range, using the offsets in the
 * index — so nothing ever reads the whole file.
 *
 * This is what lets the pipeline fill a gap of any size: the store's
 * fingerprints against this index, and then only the provisions that moved
 * are fetched.
 */
import type { PipelineRow } from './pipeline';
import type { SnapshotIndexEntry } from './snapshot-diff';

/** The slice of R2 this uses. */
export interface SnapshotBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  get(
    key: string,
    options: { range: { offset: number; length: number } },
  ): Promise<{ text(): Promise<string> } | null>;
}

/** A snapshot, read from a bucket. */
export class R2SnapshotSource {
  constructor(
    private readonly bucket: SnapshotBucket,
    /** The revision the snapshot is at. */
    readonly revision: string,
  ) {}

  /** The index: every provision's fingerprint and where its row is. */
  async index(): Promise<Map<string, SnapshotIndexEntry>> {
    const object = await this.bucket.get(`${this.revision}.index.jsonl`);
    if (!object) throw new Error(`the snapshot at ${this.revision} has no index`);
    const entries = new Map<string, SnapshotIndexEntry>();
    for (const line of (await object.text()).split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as SnapshotIndexEntry;
      entries.set(entry.id, entry);
    }
    return entries;
  }

  /**
   * One row, by id.
   *
   * A range request for the row's bytes and nothing else — the offsets are
   * the index's, so this is one request per provision, and the bytes it
   * fetches are exactly the bytes it needs.
   */
  async row(id: string, entry: SnapshotIndexEntry): Promise<PipelineRow | null> {
    const object = await this.bucket.get(`${this.revision}.rows.jsonl`, {
      range: { offset: entry.off, length: entry.len },
    });
    if (!object) return null;
    const row = JSON.parse((await object.text()).trim()) as PipelineRow;
    return row;
  }

  /** Several rows, in the order they are given. */
  async rows(ids: string[], index: Map<string, SnapshotIndexEntry>): Promise<PipelineRow[]> {
    const out: PipelineRow[] = [];
    for (const id of ids) {
      const entry = index.get(id);
      if (!entry) continue;
      const row = await this.row(id, entry);
      if (row) out.push(row);
    }
    return out;
  }
}
