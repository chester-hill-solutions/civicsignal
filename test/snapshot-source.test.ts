import { describe, expect, it } from 'vitest';
import {
  SnapshotReader,
  linesOf,
  MAX_GAP_BYTES,
  type SnapshotBucket,
} from '../src/ingest/snapshot-source';
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

/** The rows file and the index that points at it, with the real offsets. */
function snapshotOf(rows: PipelineRow[]) {
  let offset = 0;
  const lines: string[] = [];
  const index: string[] = [];
  rows.forEach((r, position) => {
    const line = JSON.stringify(r) + '\n';
    lines.push(line);
    index.push(
      `{"id":${JSON.stringify(r.id)},"fp":"hash-${position}","off":${offset},"len":${new TextEncoder().encode(line).length}}`,
    );
    offset += new TextEncoder().encode(line).length;
  });
  return {
    'abc123.index.jsonl': index.join('\n') + '\n',
    'abc123.rows.jsonl': lines.join(''),
  };
}

describe('the snapshot in a bucket', () => {
  const rows = [row('a-1', 'one'), row('a-2', 'two')];
  const files = snapshotOf(rows);

  it('reads the index whole', async () => {
    const { bucket, reads } = fakeBucket(files);
    const source = new SnapshotReader(bucket, 'abc123');

    const index = await source.index();

    expect(index.size).toBe(2);
    expect(index.get('a-1')?.fp).toBe('hash-0');
    expect(reads).toEqual([{ key: 'abc123.index.jsonl' }]);
  });

  it('says so when the snapshot has no index', async () => {
    const { bucket } = fakeBucket({});
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
      key: 'abc123.rows.jsonl',
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

  /**
   * The rows come back in the order their entries were given, and an entry
   * that points at nothing is skipped rather than throwing.
   *
   * The caller is the diff, and a diff that hands over an entry has read it
   * out of the index — so an entry with no bytes behind it means the rows
   * file and the index disagree, and the row that is missing is one the
   * caller asked for. The cycle counts what came back against what it asked
   * for and stops loudly, which is why this must not silently return a
   * half-filled list.
   */
  it('skips an entry whose bytes are not there', async () => {
    const { bucket } = fakeBucket(files);
    const source = new SnapshotReader(bucket, 'abc123');
    const index = await source.index();

    const found = await source.rows([
      index.get('a-1')!,
      { id: 'gone', fp: '', off: 10_000, len: 100 },
    ]);

    expect(found.map((r) => r.id)).toEqual(['a-1']);
  });

  it('reads adjacent rows in one request', async () => {
    const many = [row('a-1', 'one'), row('a-2', 'two'), row('a-3', 'three')];
    const { bucket, reads } = fakeBucket(snapshotOf(many));
    const source = new SnapshotReader(bucket, 'abc123');
    const index = await source.index();

    const found = await source.rows(['a-1', 'a-2', 'a-3'].map((id) => index.get(id)!));

    expect(found.map((r) => r.text)).toEqual(['one', 'two', 'three']);
    const rowReads = reads.filter((read) => read.key.endsWith('.rows.jsonl'));
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
    const rowReads = reads.filter((read) => read.key.endsWith('.rows.jsonl'));
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
    expect(reads.filter((read) => read.key.endsWith('.rows.jsonl'))).toHaveLength(1);
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
