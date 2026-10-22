/**
 * The shape of a snapshot on disk and in a bucket.
 *
 * A snapshot used to be two files: the rows, and an index saying where every
 * row is. The rows were three hundred and forty-seven megabytes, and that
 * turned out to be a limit rather than a detail — **neither wrangler nor the
 * Cloudflare API will upload a single object larger than 300 MB**. The
 * publish failed, the bucket kept the index it had already taken, and nothing
 * said so: a missing object is not an error until something reads it.
 *
 * So the rows are **parts**, and a **manifest** says what they are. Three
 * things fall out of that, and only the first is about the size limit:
 *
 * - a snapshot is published as six or seven ordinary uploads, none of them
 *   near a limit;
 * - a snapshot is **verifiable** — the manifest states the count, the total
 *   size and every part's size, so "is it all there?" is a question with an
 *   answer rather than a hope;
 * - the part size is a property of the snapshot rather than of the reader, so
 *   it can be changed without rebuilding anything.
 *
 * The offsets in the index stay **global**: the byte offset of a row in the
 * snapshot, as if it were one file. That is what makes the part size a
 * publishing detail — the index does not know or care how the rows are cut
 * up, and a row can be read without reading the ones before it.
 */
import type { SnapshotIndexEntry } from './snapshot-diff';

/** The manifest's format number. A reader refuses one it does not know. */
export const SNAPSHOT_FORMAT = 1;

/** How large a part is, unless the builder was told otherwise. */
export const DEFAULT_PART_BYTES = 64 * 1024 * 1024;

/** One part of the rows. */
export interface SnapshotPart {
  /** The object's key. */
  key: string;
  /** Its size in bytes. */
  bytes: number;
}

/** What a snapshot is, and where all of it is. */
export interface SnapshotManifest {
  format: number;
  /** The corpus revision this is a snapshot of. */
  commit: string;
  /** The revision's date, as the corpus reports it. */
  date: string;
  rows: {
    /** How many provisions. */
    count: number;
    /** The total size of the rows, in bytes — the offsets' ceiling. */
    bytes: number;
    /** The size the parts were cut to. */
    partBytes: number;
    parts: SnapshotPart[];
  };
  index: {
    key: string;
    bytes: number;
    /** How many provisions the index names. Should equal `rows.count`. */
    entries: number;
  };
}

/** The manifest's key. */
export function manifestKey(commit: string): string {
  return `${commit}.manifest.json`;
}

/** The index's key. */
export function indexKey(commit: string): string {
  return `${commit}.index.jsonl`;
}

/** A part's key. */
export function partKey(commit: string, part: number): string {
  return `${commit}.rows.${String(part).padStart(3, '0')}.jsonl`;
}

/**
 * A manifest, checked.
 *
 * The check that matters is that the parts add up to the size the manifest
 * claims, because the alternative is a snapshot whose last part never
 * arrived — and the reader would find that out by asking for a row and
 * getting nothing, which looks exactly like a row that is not in the corpus.
 */
export function parseManifest(text: string, where = 'the manifest'): SnapshotManifest {
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(text) as SnapshotManifest;
  } catch {
    throw new Error(`${where} is not JSON`);
  }
  // The shape first, so that a manifest from a newer builder is told the
  // format is wrong rather than the shape is.
  if (!manifest.commit || !manifest.rows || !manifest.index) {
    throw new Error(`${where} does not describe a snapshot`);
  }
  if (manifest.format !== SNAPSHOT_FORMAT) {
    throw new Error(
      `${where} is format ${manifest.format}; this reader knows format ${SNAPSHOT_FORMAT}`,
    );
  }
  if (!Array.isArray(manifest.rows.parts) || manifest.rows.parts.length === 0) {
    throw new Error(`${where} names no parts`);
  }
  const total = manifest.rows.parts.reduce((sum, part) => sum + part.bytes, 0);
  if (total !== manifest.rows.bytes) {
    throw new Error(
      `${where} says the rows are ${manifest.rows.bytes} bytes, and its ` +
        `${manifest.rows.parts.length} part(s) add up to ${total} — the snapshot is incomplete`,
    );
  }
  return manifest;
}

/** Where each part begins, as a global byte offset. */
export function partStarts(manifest: SnapshotManifest): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const part of manifest.rows.parts) {
    starts.push(at);
    at += part.bytes;
  }
  return starts;
}

/** Which part holds a global byte offset, and where in it. */
export function locate(
  manifest: SnapshotManifest,
  offset: number,
): { part: number; local: number } {
  const starts = partStarts(manifest);
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return { part: low, local: offset - starts[low]! };
}

/**
 * A snapshot's rows, cut into parts on line boundaries.
 *
 * The caller hands over lines and this yields the parts as they fill, so the
 * builder and the repackager cut them the same way — and so a three-hundred-
 * and-sixty-megabyte file is never held: one part is in memory, and then the
 * next.
 *
 * A part is closed when it has reached the part size and the current line is
 * finished — never in the middle of one, because a row that straddled two
 * parts could not be read by a range request, which is the only way rows are
 * read.
 */
export function* cutRows(
  lines: Iterable<string>,
  partBytes = DEFAULT_PART_BYTES,
): Generator<{ lines: string[]; bytes: number }> {
  let current: string[] = [];
  let bytes = 0;

  for (const line of lines) {
    const size = new TextEncoder().encode(line).length;
    if (bytes > 0 && bytes + size > partBytes) {
      yield { lines: current, bytes };
      current = [];
      bytes = 0;
    }
    current.push(line);
    bytes += size;
  }
  if (current.length > 0) yield { lines: current, bytes };
}

/** An index entry's bytes, as the index file holds them. */
export function indexLine(entry: SnapshotIndexEntry): string {
  return `${JSON.stringify(entry)}\n`;
}
