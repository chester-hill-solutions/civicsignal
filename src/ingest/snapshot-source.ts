/**
 * The corpus, as a snapshot in a bucket.
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
 *
 * ## Why the ranges are merged
 *
 * One range request per changed row is fine for a commit that moves fifty
 * provisions and hopeless for a store that is a year behind: two hundred
 * thousand requests, at a few milliseconds each, is an hour of nothing but
 * round trips.
 *
 * So the requested rows are sorted by offset and neighbouring ones are read
 * in **one** request when the bytes between them are cheap — a gap of thirty
 * kilobytes between two provisions costs less to read than a request costs to
 * make. A gap of three megabytes does not, and those stay separate requests.
 *
 * ## Why the rows are sliced by byte
 *
 * The offsets are byte offsets into a UTF-8 file, and half the corpus is
 * French: `Éditeur officiel` is two bytes per accent. Slicing the text of a
 * merged range by *character* position would land mid-character, and the row
 * recovered would be a provision with its accents replaced by replacement
 * characters — a wrong row rather than an error, which is the worst kind.
 *
 * So a range is decoded to bytes, each row is cut out by its byte offset, and
 * only then is that row decoded to text.
 */
import type { PipelineRow } from './pipeline';
import type { SnapshotIndexEntry } from './snapshot-diff';

/** What a bucket's object has to do for this to read it. */
export interface SnapshotObject {
  arrayBuffer(): Promise<ArrayBuffer>;
  /** The body as a stream, when the bucket can give one. */
  body?: ReadableStream<Uint8Array>;
}

/** The slice of a bucket this uses. R2's own type satisfies it. */
export interface SnapshotBucket {
  get(key: string): Promise<SnapshotObject | null>;
  get(
    key: string,
    options: { range: { offset: number; length: number } },
  ): Promise<SnapshotObject | null>;
}

/** A snapshot, wherever it is kept. */
export interface SnapshotSource {
  /** The revision the snapshot is at. */
  readonly revision: string;
  /** The index: every provision's fingerprint and where its row is. */
  index(): Promise<Map<string, SnapshotIndexEntry>>;
  /** The index, one entry at a time, in the order the file has them. */
  indexEntries(): AsyncGenerator<SnapshotIndexEntry>;
  /** One row, by id. */
  row(id: string, entry: SnapshotIndexEntry): Promise<PipelineRow | null>;
  /** Several rows, in the order their entries are given. */
  rows(entries: readonly SnapshotIndexEntry[]): Promise<PipelineRow[]>;
}

/**
 * The gap between two rows that is cheaper to read over than to request.
 *
 * Thirty-two kilobytes is the size of a provision: between two provisions
 * that changed, the bytes in between are the provisions that did not, and
 * reading them costs one request's worth of nothing.
 */
export const MAX_GAP_BYTES = 32 * 1024;

/**
 * The largest single range.
 *
 * A commit that re-consolidates an act moves hundreds of *adjacent* rows, and
 * merging them without a ceiling would mean a dozen requests for forty
 * megabytes each — more memory than the Worker reading them has.
 */
export const MAX_SPAN_BYTES = 1024 * 1024;

/** How many ranges are read at once. */
export const READ_CONCURRENCY = 8;

/** A run of rows read in one request. */
export interface RowRange {
  offset: number;
  length: number;
  /** The rows this range covers, in offset order. */
  entries: SnapshotIndexEntry[];
}

/**
 * Group rows into the fewest requests that do not read much they do not need.
 *
 * The rows are taken in offset order, and a row joins the current range when
 * the gap before it is small and the range would stay under the ceiling.
 * Everything else starts a new range.
 */
export function mergeRanges(entries: readonly SnapshotIndexEntry[]): RowRange[] {
  const sorted = [...entries].sort((a, b) => a.off - b.off);
  const ranges: RowRange[] = [];

  for (const entry of sorted) {
    const current = ranges[ranges.length - 1];
    if (current) {
      const end = current.offset + current.length;
      const gap = entry.off - end;
      const span = entry.off + entry.len - current.offset;
      if (gap >= 0 && gap <= MAX_GAP_BYTES && span <= MAX_SPAN_BYTES) {
        current.length = entry.off + entry.len - current.offset;
        current.entries.push(entry);
        continue;
      }
    }
    ranges.push({ offset: entry.off, length: entry.len, entries: [entry] });
  }

  return ranges;
}

/** Run `work` over `items`, a few at a time. */
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

/** The rows file's key, for a revision. */
export function rowsKey(revision: string): string {
  return `${revision}.rows.jsonl`;
}

/** The index file's key, for a revision. */
export function indexKey(revision: string): string {
  return `${revision}.index.jsonl`;
}

/** The chunks of a stream, as an async iterable. */
async function* chunksOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** One buffer, as a stream of one chunk. */
async function* single(buffer: ArrayBuffer): AsyncGenerator<Uint8Array> {
  yield new Uint8Array(buffer);
}

/**
 * The lines of a byte stream.
 *
 * The decoding is **incremental**, and that is the whole reason this is not
 * `text().split('\n')`: the index is twenty-four megabytes of text, and
 * splitting it materialises a quarter of a million strings on top of the text
 * — fifty-four megabytes for something that is read one line at a time.
 *
 * A character can straddle two chunks, and half the corpus is French, so the
 * decoder is left in streaming mode and a split accent is completed by the
 * next chunk rather than becoming a replacement character.
 */
export async function* linesOf(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    let at = buffer.indexOf('\n');
    while (at !== -1) {
      yield buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
}

/**
 * A snapshot, read from a bucket.
 *
 * In production the bucket is R2 and the revision is the corpus commit. In a
 * script it is a directory and a file — the range logic is the same, which is
 * the point of the bucket being an interface rather than R2 itself.
 */
export class SnapshotReader implements SnapshotSource {
  constructor(
    private readonly bucket: SnapshotBucket,
    readonly revision: string,
  ) {}

  /** The index: every provision's fingerprint and where its row is. */
  async index(): Promise<Map<string, SnapshotIndexEntry>> {
    const entries = new Map<string, SnapshotIndexEntry>();
    for await (const entry of this.indexEntries()) entries.set(entry.id, entry);
    return entries;
  }

  /**
   * The index, one entry at a time, in the order the file has them.
   *
   * This is what the diff is a merge *against*: the file is written in id
   * order, so it can be read as a cursor rather than loaded as a map. Held as
   * a map, this index is eighty megabytes of objects — a Worker's ceiling is
   * a hundred and twenty-eight, before the store's fingerprints.
   *
   * The order is load-bearing, and it is checked: `check-snapshot.ts` and the
   * builder both write and verify the file sorted by id, and every id is
   * ASCII, so D1's `ORDER BY id` and JavaScript's `<` agree on the order.
   */
  async *indexEntries(): AsyncGenerator<SnapshotIndexEntry> {
    const object = await this.bucket.get(indexKey(this.revision));
    if (!object) throw new Error(`the snapshot at ${this.revision} has no index`);
    const chunks = object.body
      ? chunksOf(object.body)
      : single(await object.arrayBuffer());
    for await (const line of linesOf(chunks)) {
      if (!line.trim()) continue;
      yield JSON.parse(line) as SnapshotIndexEntry;
    }
  }

  /**
   * One row, by id.
   *
   * A range request for the row's bytes and nothing else — the offsets are
   * the index's, so the bytes it fetches are exactly the bytes it needs.
   */
  async row(_id: string, entry: SnapshotIndexEntry): Promise<PipelineRow | null> {
    const object = await this.bucket.get(rowsKey(this.revision), {
      range: { offset: entry.off, length: entry.len },
    });
    if (!object) return null;
    const text = new TextDecoder().decode(await object.arrayBuffer()).trim();
    if (!text) return null;
    return JSON.parse(text) as PipelineRow;
  }

  /**
   * Several rows, in the order they are given.
   *
   * The rows are fetched by merged range and cut out by byte, so a hundred
   * adjacent provisions are one request rather than a hundred — and an id the
   * index does not have is skipped rather than failing the whole batch.
   *
   * It takes the index **entries** rather than ids, because the caller that
   * needs this most is the cycle, and the cycle has the entries already: it
   * is reading the index as a stream and never holds the map they would have
   * to be looked up in.
   */
  async rows(entries: readonly SnapshotIndexEntry[]): Promise<PipelineRow[]> {
    if (entries.length === 0) return [];

    const found = new Map<string, PipelineRow>();
    await mapWithLimit(mergeRanges(entries), READ_CONCURRENCY, async (range) => {
      const object = await this.bucket.get(rowsKey(this.revision), {
        range: { offset: range.offset, length: range.length },
      });
      if (!object) return;
      // The bytes, not the text: the offsets are byte offsets.
      const bytes = new Uint8Array(await object.arrayBuffer());
      const decoder = new TextDecoder();
      for (const entry of range.entries) {
        const at = entry.off - range.offset;
        const slice = bytes.subarray(at, at + entry.len);
        const text = decoder.decode(slice).trim();
        if (!text) continue;
        found.set(entry.id, JSON.parse(text) as PipelineRow);
      }
    });

    const out: PipelineRow[] = [];
    for (const entry of entries) {
      const row = found.get(entry.id);
      if (row) out.push(row);
    }
    return out;
  }
}
