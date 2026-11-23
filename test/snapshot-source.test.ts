import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprint } from '../src/ingest/reconcile';
import {
  SnapshotReader,
  linesOf,
  MAX_GAP_BYTES,
  type SnapshotBucket,
} from '../src/ingest/snapshot-source';
import {
  cutRows,
  DEFAULT_PART_BYTES,
  IndexDigester,
  indexKey,
  manifestKey,
  partKey,
  SNAPSHOT_FORMAT,
  SNAPSHOT_PARSER_VERSION,
} from '../src/ingest/snapshot-format';
import type { PipelineRow } from '../src/ingest/pipeline';

/**
 * The snapshot, read from a bucket.
 *
 * Three properties matter, and each of them is a way to get a wrong provision
 * rather than an error:
 *
 *   1. **the rows are read in pieces** — the index says where a provision's
 *      row is, and the row is fetched by byte range. A reader that pulled the
 *      whole file would make every cycle cost three hundred and forty-seven
 *      megabytes.
 *   2. **adjacent rows are one request** — otherwise filling a real gap is
 *      two hundred thousand round trips.
 *   3. **the slicing is by byte** — half the corpus is French, and slicing
 *      decoded text by character position lands mid-character and hands back
 *      a provision with its accents mangled.
 */
function row(id: string, text: string): PipelineRow {
  return {
    id,
    corpusId: 'statutes-canada',
    instrument: 'Access to Information Act',
    citation: 'A-1',
    section: id,
    status: 'in-force',
    schedule: null,
    part: null,
    heading: 'Short title',
    text,
    source_url: 'https://laws-lois.justice.gc.ca/en/acts/A-1/section-1.html',
    in_force: 1,
    language: 'en',
    embedText: '',
    lastChanged: '2026-10-15',
  };
}

/** A bucket over strings, cut on bytes — as the real one is. */
function fakeBucket(files: Record<string, string>) {
  const reads: { key: string; offset?: number; length?: number }[] = [];
  const encoded = new Map(
    Object.entries(files).map(([key, value]) => [key, new TextEncoder().encode(value)]),
  );
  const bucket = {
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      const bytes = encoded.get(key);
      if (!bytes) return null;
      if (!options?.range) {
        reads.push({ key });
        return {
          async arrayBuffer() {
            return bytes.slice().buffer;
          },
          // Delivered in two chunks, so every read of the index goes through
          // a chunk boundary.
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              const half = Math.ceil(bytes.length / 2);
              controller.enqueue(bytes.slice(0, half));
              controller.enqueue(bytes.slice(half));
              controller.close();
            },
          }),
        };
      }
      const { offset, length } = options.range;
      reads.push({ key, offset, length });
      const slice = bytes.subarray(offset, offset + length);
      return {
        async arrayBuffer() {
          return slice.slice().buffer;
        },
      };
    },
  };
  return { bucket: bucket as unknown as SnapshotBucket, reads };
}

/**
 * A snapshot, as it is on disk: a manifest, an index, and the rows in parts.
 *
 * The parts are cut by the format's own `cutRows`, so these tests exercise the
 * cutting the builder uses rather than a second implementation of it.
 */
function snapshotOf(rows: PipelineRow[], partBytes?: number) {
  const lines = rows.map((row) => JSON.stringify(row) + '\n');
  let offset = 0;
  const index: string[] = [];
  lines.forEach((line, position) => {
    const len = new TextEncoder().encode(line).length;
    index.push(
      `{"id":${JSON.stringify(rows[position]!.id)},"fp":${JSON.stringify(fingerprint(rows[position]!))},"off":${offset},"len":${len}}`,
    );
    offset += len;
  });

  const files: Record<string, string> = { [indexKey('abc123')]: index.join('\n') + '\n' };
  const parts: { key: string; bytes: number }[] = [];
  for (const part of cutRows(lines, partBytes)) {
    const key = partKey('abc123', parts.length);
    files[key] = part.lines.join('');
    parts.push({ key, bytes: part.bytes });
  }
  files[manifestKey('abc123')] = JSON.stringify({
    format: SNAPSHOT_FORMAT,
    commit: 'abc123',
    date: '2026-10-15',
    rows: {
      count: rows.length,
      bytes: offset,
      partBytes: partBytes ?? DEFAULT_PART_BYTES,
      parts,
    },
    index: {
      key: indexKey('abc123'),
      bytes: new TextEncoder().encode(index.join('\n') + '\n').length,
      entries: rows.length,
    },
  });
  return files;
}

it('verifies a downloaded snapshot CLI against exact independently pinned manifest bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-manifest-pin-'));
  const commit = 'a'.repeat(40);
  const parser = SNAPSHOT_PARSER_VERSION;
  const manifestPath = join(directory, manifestKey(commit, parser));
  const rowsPath = `snapshots/${parser}/${partKey(commit, 0)}`;
  const indexPath = indexKey(commit, parser);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const writeCandidate = async (text: string) => {
    const provision = row('a-1', text);
    const rowBytes = JSON.stringify(provision) + '\n';
    const entry = { id: provision.id, fp: fingerprint(provision), off: 0, len: Buffer.byteLength(rowBytes) };
    const indexBytes = JSON.stringify(entry) + '\n';
    const digester = new IndexDigester();
    digester.add(entry);
    const manifest = JSON.stringify({
      format: SNAPSHOT_FORMAT, commit, parser, date: '2026-10-15',
      rows: { count: 1, bytes: entry.len, partBytes: DEFAULT_PART_BYTES,
        parts: [{ key: rowsPath, bytes: entry.len, sha256: hash(rowBytes) }] },
      index: { key: indexPath, bytes: Buffer.byteLength(indexBytes), entries: 1,
        digest: digester.digest(), sha256: hash(indexBytes) },
    });
    await writeFile(manifestPath, manifest);
    await writeFile(join(directory, rowsPath), rowBytes);
    await writeFile(join(directory, indexPath), indexBytes);
    return hash(manifest);
  };
  const check = (...options: string[]) => spawnSync('bun', ['scripts/publish-snapshot.ts', '--commit', commit, '--dir', directory, ...options],
    { encoding: 'utf8', timeout: 10_000 });
  try {
    await mkdir(dirname(manifestPath), { recursive: true });
    const reference = await writeCandidate('Independently checked provision');
    const flag = '--reference-manifest-sha256';
    expect(check(flag, reference)).toMatchObject({ status: 0, stdout: expect.stringContaining(reference) });
    expect(check(flag)).toMatchObject({ status: 1, stderr: expect.stringContaining('usage:') });
    expect(check(flag, reference, flag, reference)).toMatchObject({ status: 1, stderr: expect.stringContaining('usage:') });
    const changed = await writeCandidate('Different provision with a new index and matching manifest');
    expect(changed).not.toBe(reference);
    expect(check()).toMatchObject({ status: 0 });
    expect(check(flag, reference)).toMatchObject({
      status: 1, stdout: '', stderr: expect.stringContaining('snapshot manifest differs from the pinned reference SHA-256'),
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

describe('the snapshot in a bucket', () => {
  const rows = [row('a-1', 'one'), row('a-2', 'two')];
  const files = snapshotOf(rows);

  it('reads the index whole', async () => {
    const { bucket, reads } = fakeBucket(files);
    const source = new SnapshotReader(bucket, 'abc123');

    const index = await source.index();

    expect(index.size).toBe(2);
    expect(index.get('a-1')?.fp).toBe(fingerprint(rows[0]!));
    // The manifest first — it is what says where the rest is — and then the
    // index, whole. The manifest is read once and remembered.
    expect(reads.map((read) => read.key)).toEqual([
      'abc123.manifest.json',
      'abc123.index.jsonl',
      'abc123.index.jsonl',
    ]);
  });

  it('reads the manifest once, however much is read', async () => {
    const { bucket, reads } = fakeBucket(files);
    const source = new SnapshotReader(bucket, 'abc123');

    await source.index();
    await source.index();

    expect(reads.filter((read) => read.key.endsWith('.manifest.json'))).toHaveLength(1);
  });

  it('says so when the snapshot has no manifest', async () => {
    const { bucket } = fakeBucket({});
    const source = new SnapshotReader(bucket, 'abc123');
    await expect(source.index()).rejects.toThrow(/has no manifest/);
  });

  it('says so when the manifest names an index that is not there', async () => {
    const { bucket } = fakeBucket({ 'abc123.manifest.json': files['abc123.manifest.json']! });
    const source = new SnapshotReader(bucket, 'abc123');
    await expect(source.index()).rejects.toThrow(/has no index/);
  });

  /**
   * The index as a cursor.
   *
   * The diff is a merge against this stream, so the order has to be the
   * file's — which is id order, which is what D1's `ORDER BY id` gives back.
   * An index read in the wrong order would make the merge produce a changed
   * provision for every one that moved past another.
   */
  it('streams the index in the order the file has it', async () => {
    const { bucket } = fakeBucket(files);
    const source = new SnapshotReader(bucket, 'abc123');

    const entries: string[] = [];
    for await (const entry of source.indexEntries()) entries.push(entry.id);

    expect(entries).toEqual(['a-1', 'a-2']);
  });

  it('fetches a row by byte range, and only its bytes', async () => {
    const { bucket, reads } = fakeBucket(files);
    const source = new SnapshotReader(bucket, 'abc123');
    const index = await source.index();

    const found = await source.row('a-2', index.get('a-2')!);

    expect(found?.id).toBe('a-2');
    expect(found?.text).toBe('two');
    expect(reads[reads.length - 1]).toMatchObject({
      key: 'abc123.rows.000.jsonl',
      offset: new TextEncoder().encode(JSON.stringify(rows[0]) + '\n').length,
    });
  });

  it('fetches several rows in the order they are given', async () => {
    const { bucket } = fakeBucket(files);
    const source = new SnapshotReader(bucket, 'abc123');
    const index = await source.index();

    const found = await source.rows([index.get('a-2')!, index.get('a-1')!]);

    expect(found.map((r) => r.id)).toEqual(['a-2', 'a-1']);
  });

  /** A truncated range must stop the cycle before a partial write can land. */
  it('refuses an entry whose bytes are not there', async () => {
    const { bucket } = fakeBucket(files);
    const source = new SnapshotReader(bucket, 'abc123');
    const index = await source.index();

    await expect(source.rows([
      index.get('a-1')!,
      { id: 'gone', fp: '', off: 10_000, len: 100 },
    ])).rejects.toThrow(/truncated snapshot row/);
  });

  it('reads adjacent rows in one request', async () => {
    const many = [row('a-1', 'one'), row('a-2', 'two'), row('a-3', 'three')];
    const { bucket, reads } = fakeBucket(snapshotOf(many));
    const source = new SnapshotReader(bucket, 'abc123');
    const index = await source.index();

    const found = await source.rows(['a-1', 'a-2', 'a-3'].map((id) => index.get(id)!));

    expect(found.map((r) => r.text)).toEqual(['one', 'two', 'three']);
    const rowReads = reads.filter((read) => read.key.includes('.rows.'));
    expect(rowReads).toHaveLength(1);
  });

  it('does not read across a gap it would not spend', async () => {
    // Three rows, with a provision between the first and the last that is
    // wider than the gap worth reading over.
    const far = row('a-2', 'x'.repeat(MAX_GAP_BYTES + 1000));
    const { bucket, reads } = fakeBucket(snapshotOf([row('a-1', 'one'), far, row('a-3', 'three')]));
    const source = new SnapshotReader(bucket, 'abc123');
    const index = await source.index();

    const found = await source.rows(['a-1', 'a-3'].map((id) => index.get(id)!));

    expect(found.map((r) => r.text)).toEqual(['one', 'three']);
    const rowReads = reads.filter((read) => read.key.includes('.rows.'));
    expect(rowReads).toHaveLength(2);
  });

  it('cuts rows out of a merged range on bytes, not on characters', async () => {
    // Éditeur officiel: two bytes per accent. A reader that slices the
    // decoded text by byte offset lands in the middle of a character.
    const one = row('a-1', 'Éditeur officiel du Québec');
    const two = row('a-2', 'Règlement sur les émissions');
    const { bucket, reads } = fakeBucket(snapshotOf([one, two]));
    const source = new SnapshotReader(bucket, 'abc123');
    const index = await source.index();

    const found = await source.rows(['a-1', 'a-2'].map((id) => index.get(id)!));

    expect(found.map((r) => r.text)).toEqual([
      'Éditeur officiel du Québec',
      'Règlement sur les émissions',
    ]);
    expect(reads.filter((read) => read.key.includes('.rows.'))).toHaveLength(1);
  });

  /**
   * The parts, which exist because a single object cannot be published.
   *
   * The offsets in the index are **global** — they are what the builder wrote
   * as it streamed the rows — so a reader has to work out which part a row is
   * in and where it is inside it. Getting that wrong reads a different
   * provision, quietly, which is the failure mode this whole format is built
   * to avoid.
   */
  it('reads a row out of the part that holds it', async () => {
    const rows = [row('a-1', 'one'), row('a-2', 'two'), row('a-3', 'three')];
    // A part size that puts each row in its own part.
    const files = snapshotOf(rows, 1);
    const { bucket, reads } = fakeBucket(files);
    const source = new SnapshotReader(bucket, 'abc123');

    const manifest = await source.manifest();
    expect(manifest.rows.parts).toHaveLength(3);

    const index = await source.index();
    const found = await source.rows([index.get('a-3')!]);

    expect(found.map((r) => r.text)).toEqual(['three']);
    const read = reads[reads.length - 1]!;
    expect(read.key).toBe('abc123.rows.002.jsonl');
    // The row is at the start of the third part, not at its global offset.
    expect(read.offset).toBe(0);
  });

  it('reads rows from two parts without confusing them', async () => {
    const rows = [row('a-1', 'one'), row('a-2', 'two'), row('a-3', 'three')];
    const { bucket } = fakeBucket(snapshotOf(rows, 1));
    const source = new SnapshotReader(bucket, 'abc123');
    const index = await source.index();

    const found = await source.rows([index.get('a-1')!, index.get('a-3')!]);

    expect(found.map((r) => r.text)).toEqual(['one', 'three']);
  });
});

/**
 * The lines of a byte stream.
 *
 * The index is read this way so it is never in memory at once: twenty-four
 * megabytes of text, split into a quarter of a million lines, is fifty-four
 * megabytes — against a Worker's hundred and twenty-eight, with the store's
 * fingerprints still to come.
 *
 * Splitting a stream by lines has one way to go quietly wrong, and it is a
 * French one: a chunk boundary in the middle of a two-byte accent. A decoder
 * that is not told it is streaming turns the halves into replacement
 * characters, and the row's id is then a provision that does not exist.
 */
describe('the lines of a stream', () => {
  async function* chunksOf(...chunks: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) {
      yield typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    }
  }

  async function lines(...chunks: (string | Uint8Array)[]): Promise<string[]> {
    const out: string[] = [];
    for await (const line of linesOf(chunksOf(...chunks))) out.push(line);
    return out;
  }

  it('reads the lines a stream has', async () => {
    expect(await lines('one\ntwo\nthree\n')).toEqual(['one', 'two', 'three']);
  });

  it('holds a line together across a chunk boundary', async () => {
    expect(await lines('on', 'e\ntw', 'o\n')).toEqual(['one', 'two']);
  });

  it('keeps the last line when the file does not end with a newline', async () => {
    expect(await lines('one\ntwo')).toEqual(['one', 'two']);
  });

  it('does not invent a line for a trailing newline', async () => {
    expect(await lines('one\n')).toEqual(['one']);
  });

  it('completes an accent that a chunk boundary cut in half', async () => {
    const text = 'Éditeur officiel du Québec\nRèglement\n';
    const bytes = new TextEncoder().encode(text);
    // Cut one byte into the É, and one byte into the è.
    const first = bytes.indexOf(0xc3);
    const second = bytes.indexOf(0xc3, first + 1) + 1;

    expect(await lines(bytes.subarray(0, first), bytes.subarray(first, second), bytes.subarray(second))).toEqual([
      'Éditeur officiel du Québec',
      'Règlement',
    ]);
  });
});
