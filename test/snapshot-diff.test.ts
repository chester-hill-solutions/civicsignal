import { describe, expect, it } from 'vitest';
import {
  diffSnapshot,
  diffSnapshotStream,
  parseSnapshotIndex,
  type SnapshotDiffBatch,
  type SnapshotIndexEntry,
} from '../src/ingest/snapshot-diff';
import { fingerprintsOf } from '../src/ingest/reconcile';

/**
 * The diff, between a store and a snapshot.
 *
 * The point of this is the **gap**: the old reconciliation compared two
 * revisions through GitHub, which names the files that differ and stops at
 * three hundred of them. This compares two index files, so a store that fell
 * behind yesterday and a store that fell behind a year ago are the same
 * amount of work.
 *
 * That is worth a test of its own — not "the diff is correct" but "the diff
 * does not care how far behind the store is".
 */
describe('the snapshot diff', () => {
  const store = new Map([
    ['a-1', 'hash-1'],
    ['a-2', 'hash-2'],
    ['a-3', 'hash-3'],
  ]);
  const snapshot = new Map([
    ['a-1', 'hash-1'],
    ['a-2', 'hash-CHANGED'],
    ['a-4', 'hash-4'],
  ]);

  it('separates what moved, what went and what came', () => {
    const diff = diffSnapshot(store, snapshot);
    expect(diff.changed).toEqual(['a-2']);
    expect(diff.gone).toEqual(['a-3']);
    expect(diff.came).toEqual(['a-4']);
  });

  it('says nothing when the two are the same corpus', () => {
    const diff = diffSnapshot(store, new Map(store));
    expect(diff.changed).toEqual([]);
    expect(diff.gone).toEqual([]);
    expect(diff.came).toEqual([]);
  });

  /**
   * The gap.
   *
   * A store that is a thousand provisions behind is not a harder diff — it is
   * the same diff with a longer list. There is no ceiling in the comparison
   * itself, which is the whole reason the snapshot is worth building.
   */
  it('does not care how far behind the store is', () => {
    const behind = new Map<string, string>();
    for (let i = 0; i < 50_000; i++) behind.set(`old-${i}`, `hash-${i}`);
    behind.set('a-1', 'hash-1');
    behind.set('a-2', 'hash-OLD');
    behind.set('a-3', 'hash-3');

    const head = new Map<string, string>();
    for (let i = 0; i < 50_000; i++) head.set(`old-${i}`, `hash-${i}`);
    head.set('a-1', 'hash-1');
    head.set('a-2', 'hash-CHANGED');
    head.set('a-9', 'hash-9');

    const diff = diffSnapshot(behind, head);
    expect(diff.changed).toEqual(['a-2']);
    expect(diff.gone).toEqual(['a-3']);
    expect(diff.came).toEqual(['a-9']);
  });

  it('reads an index from its lines', () => {
    const index = parseSnapshotIndex(
      '{"id":"a-1","fp":"hash-1","off":0,"len":100}\n{"id":"a-2","fp":"hash-2","off":100,"len":120}\n',
    );
    expect(index.get('a-1')).toBe('hash-1');
    expect(index.get('a-2')).toBe('hash-2');
    expect(index.size).toBe(2);
  });

  it('ignores the blank lines a file ends with', () => {
    const index = parseSnapshotIndex('{"id":"a-1","fp":"hash-1","off":0,"len":100}\n\n');
    expect(index.size).toBe(1);
  });
});

/**
 * The same diff, as a merge.
 *
 * The merge exists because the maps do not fit: an index of a quarter of a
 * million provisions held as objects is eighty megabytes, and the store's
 * fingerprints are thirty more, against a Worker's hundred and twenty-eight.
 *
 * So these are the two properties the merge has to have — it must reach the
 * same answer as the map, and it must not read anything it has not been
 * asked for yet.
 */
describe('the snapshot diff, streamed', () => {
  function entriesOf(map: Map<string, string>): SnapshotIndexEntry[] {
    let offset = 0;
    return [...map].map(([id, fp]) => {
      const entry = { id, fp, off: offset, len: 10 };
      offset += 10;
      return entry;
    });
  }

  async function* asStream<T>(items: readonly T[]): AsyncGenerator<T> {
    for (const item of items) yield item;
  }

  async function collect(
    batches: AsyncIterable<SnapshotDiffBatch>,
  ): Promise<{ changed: string[]; gone: string[]; came: string[] }> {
    const out = { changed: [] as string[], gone: [] as string[], came: [] as string[] };
    for await (const batch of batches) {
      out.changed.push(...batch.changed.map((entry) => entry.id));
      out.came.push(...batch.came.map((entry) => entry.id));
      out.gone.push(...batch.gone);
    }
    return out;
  }

  const store = new Map([
    ['a-1', 'hash-1'],
    ['a-2', 'hash-2'],
    ['a-3', 'hash-3'],
    ['c-1', 'hash-c1'],
  ]);
  const snapshot = new Map([
    ['a-1', 'hash-1'],
    ['a-2', 'hash-CHANGED'],
    ['a-4', 'hash-4'],
    ['c-1', 'hash-c1'],
  ]);

  it('reaches the same answer as the map', async () => {
    const merged = await collect(
      diffSnapshotStream(asStream(entriesOf(snapshot)), fingerprintsOf(store)),
    );
    const map = diffSnapshot(store, snapshot);

    expect(merged.changed).toEqual(map.changed);
    expect(merged.gone).toEqual(map.gone);
    expect(merged.came).toEqual(map.came);
  });

  it('reaches the same answer when the store is far behind', async () => {
    const behind = new Map<string, string>();
    const head = new Map<string, string>();
    for (let i = 0; i < 50_000; i++) {
      const id = `old-${String(i).padStart(6, '0')}`;
      behind.set(id, `hash-${i}`);
      head.set(id, `hash-${i}`);
    }
    behind.set('zz-1', 'hash-old');
    head.set('zz-1', 'hash-new');
    head.set('zz-2', 'hash-2');

    const merged = await collect(
      diffSnapshotStream(asStream(entriesOf(head)), fingerprintsOf(behind)),
    );
    const map = diffSnapshot(behind, head);

    expect(merged.changed).toEqual(map.changed);
    expect(merged.gone).toEqual(map.gone);
    expect(merged.came).toEqual(map.came);
    expect(merged.changed).toEqual(['zz-1']);
    expect(merged.came).toEqual(['zz-2']);
    expect(merged.gone).toEqual([]);
  });

  /**
   * The batching, and the batch that carries no work.
   *
   * The last batch goes out even when it holds nothing to do, because the
   * count of what the two sides *agreed* on is part of what the diff says —
   * and a cycle that found nothing still has to know how big the corpus is.
   */
  it('yields in the batches it was asked for', async () => {
    const work: number[] = [];
    let agreed = 0;
    for await (const batch of diffSnapshotStream(
      asStream(entriesOf(snapshot)),
      fingerprintsOf(store),
      { batchSize: 1 },
    )) {
      work.push(batch.changed.length + batch.came.length + batch.gone.length);
      agreed += batch.same;
    }
    expect(work).toEqual([1, 1, 1, 0]);
    expect(agreed).toBe(2);
  });

  /**
   * The memory property, stated as behaviour.
   *
   * A merge reads the index until it has something to say; a scan reads all
   * of it. With a hundred thousand provisions on one side and nothing on the
   * other, the first batch of ten must cost ten.
   */
  it('does not read the whole index to produce the first batch', async () => {
    const many = new Map<string, string>();
    for (let i = 0; i < 100_000; i++) many.set(`a-${String(i).padStart(6, '0')}`, `hash-${i}`);

    let read = 0;
    async function* counted(): AsyncGenerator<SnapshotIndexEntry> {
      for (const entry of entriesOf(many)) {
        read++;
        yield entry;
      }
    }

    const stream = diffSnapshotStream(counted(), fingerprintsOf(new Map()), { batchSize: 10 });
    const first = await stream.next();

    expect(first.value?.came).toHaveLength(10);
    expect(read).toBeLessThan(100);
  });

  it('handles a store that holds nothing', async () => {
    const merged = await collect(
      diffSnapshotStream(asStream(entriesOf(snapshot)), fingerprintsOf(new Map())),
    );
    expect(merged.came).toEqual([...snapshot.keys()]);
    expect(merged.gone).toEqual([]);
  });

  it('handles a snapshot that holds nothing', async () => {
    const merged = await collect(
      diffSnapshotStream(asStream([]), fingerprintsOf(store)),
    );
    expect(merged.gone).toEqual([...store.keys()]);
    expect(merged.came).toEqual([]);
  });
});
