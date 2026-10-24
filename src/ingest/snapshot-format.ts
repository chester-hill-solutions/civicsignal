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
import { hash128 } from './reconcile';
import type { SnapshotIndexEntry } from './snapshot-diff';

/** The manifest's format number. A reader refuses one it does not know. */
export const SNAPSHOT_FORMAT = 1;
/** Increment when row semantics change. Existing snapshots remain immutable. */
export const SNAPSHOT_PARSER_VERSION = 'statutes-v2';
export function snapshotNamespace(parser?: string): string {
  if (parser === undefined) return '';
  if (typeof parser !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(parser)) throw new Error('invalid snapshot parser identity');
  return `snapshots/${parser}/`;
}

/** How large a part is, unless the builder was told otherwise. */
export const DEFAULT_PART_BYTES = 64 * 1024 * 1024;

/** One part of the rows. */
export interface SnapshotPart {
  /** The object's key. */
  key: string;
  /** Its size in bytes. */
  bytes: number;
  /** Digest of immutable bytes, when produced by the Workflow builder. */
  sha256?: string;
}

/** What a snapshot is, and where all of it is. */
export interface SnapshotManifest {
  format: number;
  /** The corpus revision this is a snapshot of. */
  commit: string;
  /** Absent only on legacy snapshots; selects an immutable namespace. */
  parser?: string;
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
    /** Digest of the ordered (id, fingerprint) sequence. */
    digest?: string;
    sha256?: string;
  };
}

/** The manifest's key. */
export function manifestKey(commit: string, parser?: string): string {
  return `${snapshotNamespace(parser)}${commit}.manifest.json`;
}

/** The index's key. */
export function indexKey(commit: string, parser?: string): string {
  return `${snapshotNamespace(parser)}${commit}.index.jsonl`;
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
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function nonnegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function validRevision(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value); }
function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function validDigest(value: unknown, length: number): boolean { return typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value); }

export function parseManifest(text: string, where = 'the manifest'): SnapshotManifest {
  let manifest: SnapshotManifest;
  try { manifest = JSON.parse(text) as SnapshotManifest; }
  catch { throw new Error(`${where} is not JSON`); }
  if (!manifest || typeof manifest !== 'object' || !manifest.commit || !manifest.rows || !manifest.index) {
    throw new Error(`${where} does not describe a snapshot`);
  }
  if (manifest.format !== SNAPSHOT_FORMAT) throw new Error(`${where} is format ${manifest.format}; this reader knows format ${SNAPSHOT_FORMAT}`);
  if (!Array.isArray(manifest.rows.parts) || !manifest.rows.parts.length) throw new Error(`${where} names no parts`);
  if (!validRevision(manifest.commit) || !validDate(manifest.date) ||
    !positiveInteger(manifest.rows.count) || !positiveInteger(manifest.rows.bytes) || !positiveInteger(manifest.rows.partBytes) ||
    !positiveInteger(manifest.index.bytes) || !positiveInteger(manifest.index.entries) || manifest.rows.count !== manifest.index.entries) {
    throw new Error(`${where} has invalid revision, date, sizes or counts`);
  }
  const prefix = `${snapshotNamespace(manifest.parser)}${manifest.commit}`;
  if (manifest.index.key !== `${prefix}.index.jsonl` ||
    manifest.index.digest !== undefined && !validDigest(manifest.index.digest, 32) ||
    manifest.index.sha256 !== undefined && !validDigest(manifest.index.sha256, 64)) throw new Error(`${where} has an invalid index identity`);
  if (manifest.parser !== undefined && (!validDigest(manifest.index.digest, 32) || !validDigest(manifest.index.sha256, 64))) throw new Error(`${where} lacks parser-versioned index integrity`);
  const seen = new Set<string>();
  let total = 0;
  for (const part of manifest.rows.parts) {
    const suffix = part && typeof part.key === 'string' && part.key.startsWith(`${prefix}.rows.`) ? part.key.slice(`${prefix}.rows.`.length) : '';
    if (!part || !/^(?:g\d{4}\.)?\d{3,}\.jsonl$/.test(suffix) || !positiveInteger(part.bytes) || seen.has(part.key) ||
      (manifest.parser !== undefined || part.sha256 !== undefined) && !validDigest(part.sha256, 64)) throw new Error(`${where} has an invalid or duplicate row part`);
    seen.add(part.key);
    total += part.bytes;
  }
  if (!Number.isSafeInteger(total) || total !== manifest.rows.bytes) throw new Error(`${where} says the rows are ${manifest.rows.bytes} bytes, and its ${manifest.rows.parts.length} part(s) add up to ${total} — the snapshot is incomplete`);
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

/**
 * The vectors, as a file beside the rows.
 *
 * The vectors are the one part of the corpus that cannot be re-derived by
 * copying: they need the model, and a quarter of a million embeddings is about
 * four hours of GPU. So a snapshot that does not carry them leaves a rebuild
 * costing four hours, and one that carries them makes it a file copy.
 *
 * They are **fixed width and in the snapshot's order**: vector *i* belongs to
 * the *i*-th id in the snapshot's index, so a row's vector is at
 * `position × dims × 4` bytes and no second id list is needed.
 *
 * And they are **parts**, for the same reason the rows are: 853 MB cannot be
 * published in one object.
 */
export interface VectorsManifest {
  format: number;
  commit: string;
  parser?: string;
  /** How many floats per vector. Fixed by the model, not by the export. */
  dims: number;
  /** How many vectors the file holds — one per provision, placeholders included. */
  count: number;
  /** The total size, in bytes. */
  bytes: number;
  parts: {
    key: string;
    bytes: number;
    /** How many vectors this part holds. */
    count: number;
    /** The position of its first vector, in the snapshot's order. */
    from: number;
    /** Immutable vector bytes; required for parser-versioned exports. */
    sha256?: string;
  }[];
  /**
   * The index this file belongs to.
   *
   * The positions are meaningless without it — see `indexDigest` — so it is
   * required, and a consumer that cannot match it must not use the file.
   */
  index: {
    entries: number;
    /** A hash of the (id, fingerprint) sequence, in order. */
    digest: string;
  };
  /** How many provisions the index actually holds a vector for. */
  embedded: number;
  /**
   * How many it does not — the placeholders, which are written to the store
   * and deliberately not embedded. Their vectors are zeroes, and that is the
   * only position at which a zero vector is correct.
   */
  notEmbedded: number;
}

/**
 * The identity of an index: a hash of its provisions, in order.
 *
 * The vectors are **positional** — vector *i* belongs to the *i*-th id in the
 * index — so a vectors file is only correct against the *exact* index it was
 * exported from. A new revision adds and removes provisions, which shifts
 * every position after the first change, so yesterday's vectors against
 * today's index are vectors of *different provisions*. That is not an error
 * anywhere: the search returns provisions, ranked by somebody else's meaning,
 * and reads as a working search.
 *
 * So the vectors manifest carries this, and a consumer compares it against the
 * index it holds. It is a hash of the ids **and their fingerprints**, in
 * order, because the fingerprints are what say the corpus's text — a revision
 * that changed a provision without moving anything still makes the vectors
 * wrong for it.
 *
 * It is computed in megabyte chunks so that nothing has to hold the index: a
 * hash of the chunk hashes, over the count, which is the same value however
 * the work is divided.
 */
export class IndexDigester {
  private readonly chunks: string[] = [];
  private buffer = '';
  private count = 0;

  add(entry: { id: string; fp: string }): void {
    this.buffer += `${entry.id}\u0000${entry.fp}\n`;
    this.count++;
    if (this.buffer.length >= 1_000_000) {
      this.chunks.push(hash128(this.buffer));
      this.buffer = '';
    }
  }

  digest(): string {
    const hashes = this.buffer ? [...this.chunks, hash128(this.buffer)] : this.chunks;
    return hash128(`${this.count}\n${hashes.join('\n')}`);
  }
}

export function indexDigest(entries: Iterable<{ id: string; fp: string }>): string {
  const digester = new IndexDigester();
  for (const entry of entries) digester.add(entry);
  return digester.digest();
}

/** Positional vector bytes are unsafe unless every id and fingerprint agrees. */
export function assertVectorIndex(manifest: VectorsManifest, entries: Iterable<{ id: string; fp: string }>): void {
  let count = 0;
  const digester = new IndexDigester();
  for (const entry of entries) { digester.add(entry); count++; }
  if (count !== manifest.index.entries || digester.digest() !== manifest.index.digest) {
    throw new Error('vectors do not belong to this exact snapshot index and fingerprints');
  }
}

/** The vectors manifest's key. */
export function vectorsManifestKey(commit: string, parser?: string): string {
  return `${snapshotNamespace(parser)}${commit}.vectors.manifest.json`;
}

/** A vectors part's key. */
export function vectorsPartKey(commit: string, part: number, parser?: string): string {
  return `${snapshotNamespace(parser)}${commit}.vectors.${String(part).padStart(3, '0')}.f32`;
}

/**
 * A vectors manifest, checked.
 *
 * The check is the same one the rows get, and it is the one that matters: the
 * parts add up to the size the manifest claims, and the size is what the
 * *count* says it is. A vectors file that is short by a part is a file whose
 * last provisions have no vector, and a rebuild from it would produce an index
 * with holes in it that nothing would report.
 */
export function parseVectorsManifest(text: string, where = 'the vectors manifest'): VectorsManifest {
  let manifest: VectorsManifest;
  try {
    manifest = JSON.parse(text) as VectorsManifest;
  } catch {
    throw new Error(`${where} is not JSON`);
  }
  if (!manifest || typeof manifest !== 'object' || !manifest.commit || !Array.isArray(manifest.parts)) {
    throw new Error(`${where} does not describe a vectors file`);
  }
  if (manifest.format !== SNAPSHOT_FORMAT) {
    throw new Error(
      `${where} is format ${manifest.format}; this reader knows format ${SNAPSHOT_FORMAT}`,
    );
  }
  if (!manifest.index?.digest || !manifest.index.entries) {
    throw new Error(
      `${where} does not say which index it belongs to. The vectors are positional, so a ` +
        `file without that is a file that can only be trusted by accident.`,
    );
  }
  if (manifest.index.entries !== manifest.count) {
    throw new Error(
      `${where} belongs to an index of ${manifest.index.entries} provision(s) and holds ` +
        `${manifest.count} vector(s) — one of the two is not what it says it is`,
    );
  }
  if (!validRevision(manifest.commit) || !positiveInteger(manifest.count) || !positiveInteger(manifest.dims) ||
    !positiveInteger(manifest.bytes) || !validDigest(manifest.index.digest, 32) || !positiveInteger(manifest.index.entries) ||
    !nonnegativeInteger(manifest.embedded) || !nonnegativeInteger(manifest.notEmbedded) || manifest.embedded + manifest.notEmbedded !== manifest.count || !manifest.parts.length) {
    throw new Error(`${where} has invalid counts, dimensions or index digest`);
  }
  const prefix = `${snapshotNamespace(manifest.parser)}${manifest.commit}.vectors.`;
  const keys = new Set<string>();
  let position = 0;
  for (const part of manifest.parts) {
    const suffix = part && typeof part.key === 'string' && part.key.startsWith(prefix) ? part.key.slice(prefix.length) : '';
    if (!part || !/^\d{3,}\.f32$/.test(suffix) || keys.has(part.key) || !positiveInteger(part.count) ||
      !positiveInteger(part.bytes) || !nonnegativeInteger(part.from) || part.from !== position || part.bytes !== part.count * manifest.dims * 4 ||
      (manifest.parser !== undefined || part.sha256 !== undefined) && !validDigest(part.sha256, 64)) {
      throw new Error(`${where} has an invalid or duplicate vector part`);
    }
    keys.add(part.key);
    position += part.count;
  }
  if (position !== manifest.count) throw new Error(`${where} vector part counts are incomplete`);
  const expected = manifest.count * manifest.dims * 4;
  if (manifest.bytes !== expected) {
    throw new Error(
      `${where} says ${manifest.count} vector(s) of ${manifest.dims} floats are ` +
        `${manifest.bytes} bytes, and that is ${expected}`,
    );
  }
  const total = manifest.parts.reduce((sum, part) => sum + part.bytes, 0);
  if (total !== manifest.bytes) {
    throw new Error(
      `${where} says the vectors are ${manifest.bytes} bytes, and its ` +
        `${manifest.parts.length} part(s) add up to ${total} — the export is incomplete`,
    );
  }
  return manifest;
}
