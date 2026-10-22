import { describe, expect, it } from 'vitest';
import { diffSnapshot, parseSnapshotIndex } from '../src/ingest/snapshot-diff';

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
