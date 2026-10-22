import { describe, expect, it } from 'vitest';
import { R2SnapshotSource, type SnapshotBucket } from '../src/ingest/snapshot-source';
import type { PipelineRow } from '../src/ingest/pipeline';

/**
 * The snapshot, read from R2.
 *
 * The property that matters is that **the rows are read in pieces**: the
 * index says where a provision's row is, and the row is fetched by byte
 * range. A reader that pulled the whole file would make every cycle cost
 * three hundred and forty-seven megabytes, and the whole reason for the
 * snapshot is that it is not.
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

/** A bucket that remembers what it was asked for. */
function fakeBucket(files: Record<string, string>) {
  const reads: { key: string; offset?: number; length?: number }[] = [];
  const bucket = {
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      const content = files[key];
      if (content === undefined) return null;
      if (!options?.range) {
        reads.push({ key });
        return { async text() { return content; } };
      }
      reads.push({ key, offset: options.range.offset, length: options.range.length });
      return {
        async text() {
          return content.slice(options.range!.offset, options.range!.offset + options.range!.length);
        },
      };
    },
  };
  return { bucket: bucket as unknown as SnapshotBucket, reads };
}

describe('the snapshot in R2', () => {
  // The rows, and the index that points at their bytes — the offsets are
  // the real ones, because a range request that is the wrong length is
  // exactly the bug this is here to catch.
  const rowOne = JSON.stringify(row('a-1', 'one')) + '\n';
  const rowTwo = JSON.stringify(row('a-2', 'two')) + '\n';
  const files = {
    'abc123.index.jsonl':
      `{"id":"a-1","fp":"hash-1","off":0,"len":${rowOne.length}}\n` +
      `{"id":"a-2","fp":"hash-2","off":${rowOne.length},"len":${rowTwo.length}}\n`,
    'abc123.rows.jsonl': rowOne + rowTwo,
  };

  it('reads the index whole', async () => {
    const { bucket, reads } = fakeBucket(files);
    const source = new R2SnapshotSource(bucket, 'abc123');

    const index = await source.index();

    expect(index.size).toBe(2);
    expect(index.get('a-1')?.fp).toBe('hash-1');
    expect(index.get('a-2')?.off).toBe(rowOne.length);
    expect(reads).toEqual([{ key: 'abc123.index.jsonl' }]);
  });

  it('says so when the snapshot has no index', async () => {
    const { bucket } = fakeBucket({});
    const source = new R2SnapshotSource(bucket, 'abc123');
    await expect(source.index()).rejects.toThrow(/has no index/);
  });

  it('fetches a row by byte range, and only its bytes', async () => {
    const { bucket, reads } = fakeBucket(files);
    const source = new R2SnapshotSource(bucket, 'abc123');
    const index = await source.index();

    const found = await source.row('a-2', index.get('a-2')!);

    expect(found?.id).toBe('a-2');
    expect(found?.text).toBe('two');
    expect(reads[reads.length - 1]).toEqual({
      key: 'abc123.rows.jsonl',
      offset: rowOne.length,
      length: rowTwo.length,
    });
  });

  it('fetches several rows in the order they are given', async () => {
    const { bucket } = fakeBucket(files);
    const source = new R2SnapshotSource(bucket, 'abc123');
    const index = await source.index();

    const rows = await source.rows(['a-2', 'a-1'], index);

    expect(rows.map((r) => r.id)).toEqual(['a-2', 'a-1']);
  });

  it('skips an id the index does not have', async () => {
    const { bucket } = fakeBucket(files);
    const source = new R2SnapshotSource(bucket, 'abc123');
    const index = await source.index();

    const rows = await source.rows(['a-1', 'nope'], index);

    expect(rows.map((r) => r.id)).toEqual(['a-1']);
  });
});
