import { describe, expect, it } from 'vitest';
import { runSnapshotPipeline } from '../src/ingest/snapshot-pipeline';
import type { R2SnapshotSource } from '../src/ingest/snapshot-source';
import type { PipelineRow } from '../src/ingest/pipeline';
import { fingerprint } from '../src/ingest/reconcile';
import { FakeStore, row } from './helpers/corpus-store';

/**
 * The cycle, over a snapshot.
 *
 * The property that matters is the **gap**: the old cycle compared two
 * revisions through GitHub, which names the files that differ and stops at
 * three hundred of them. This one compares two indexes, so a store that fell
 * behind yesterday and a store that fell behind a year ago are the same
 * amount of work.
 */
function rowOf(id: string, text: string): PipelineRow {
  return row(id, { text });
}

/** A snapshot with the given rows, and the fingerprints that go with them. */
function snapshotOf(rows: PipelineRow[]) {
  const index = new Map<string, { id: string; fp: string; off: number; len: number }>();
  rows.forEach((r, position) => {
    index.set(r.id, {
      id: r.id,
      // The real fingerprint: the diff compares fingerprints, so a snapshot
      // whose fingerprints are blank would say everything changed.
      fp: fingerprint(r),
      off: position,
      len: 1,
    });
  });
  return {
    index: async () => index,
    rows: async (ids: string[]) => rows.filter((r) => ids.includes(r.id)),
  } as unknown as R2SnapshotSource;
}

const encoder = {
  async embed(documents: { title: string; text: string }[]) {
    return documents.map(() => new Array(768).fill(0.1));
  },
};

const now = new Date('2026-10-15T12:00:00Z');

describe('the snapshot cycle', () => {
  it('writes only the rows that moved', async () => {
    const moved = rowOf('a-1', 'The new text.');
    const same = rowOf('a-2', 'Unchanged.');
    const store = new FakeStore([rowOf('a-1', 'The old text.'), same]);
    const source = snapshotOf([moved, same]);

    let calls = 0;
    const counting = {
      async embed(documents: { title: string; text: string }[]) {
        calls++;
        return documents.map(() => new Array(768).fill(0.1));
      },
    };

    const run = await runSnapshotPipeline({
      corpusId: 'statutes-canada',
      revision: { commit: 'new456', date: '2026-10-15' },
      source,
      store,
      encoder: counting,
      now,
    });

    expect(run.counts.changed).toBe(1);
    expect(run.counts.added).toBe(0);
    expect(run.counts.removed).toBe(0);
    expect(calls).toBe(1);
    expect(store.rows.get('a-1')?.row.text).toBe('The new text.');
  });

  it('removes what the corpus no longer holds', async () => {
    const store = new FakeStore([rowOf('a-1', 'Still here.'), rowOf('a-2', 'Gone.')]);
    const source = snapshotOf([rowOf('a-1', 'Still here.')]);

    const run = await runSnapshotPipeline({
      corpusId: 'statutes-canada',
      revision: { commit: 'new456', date: '2026-10-15' },
      source,
      store,
      encoder,
      now,
    });

    expect(run.counts.removed).toBe(1);
    expect(store.rows.has('a-2')).toBe(false);
  });

  it('adds what the corpus has and the store has never seen', async () => {
    const store = new FakeStore([]);
    const source = snapshotOf([rowOf('a-1', 'New to us.')]);

    const run = await runSnapshotPipeline({
      corpusId: 'statutes-canada',
      revision: { commit: 'new456', date: '2026-10-15' },
      source,
      store,
      encoder,
      now,
    });

    expect(run.counts.added).toBe(1);
    expect(store.rows.has('a-1')).toBe(true);
  });

  /**
   * The gap.
   *
   * A store fifty thousand provisions behind is not a harder cycle — it is
   * the same cycle with a longer list of rows to fetch, and no ceiling in
   * the comparison itself.
   */
  it('catches up from any distance', async () => {
    const held: PipelineRow[] = [];
    const head: PipelineRow[] = [];
    for (let i = 0; i < 50_000; i++) {
      held.push(rowOf(`old-${i}`, `Text ${i}.`));
      head.push(rowOf(`old-${i}`, `Text ${i}.`));
    }
    head.push(rowOf('brand-new', 'Never seen.'));

    const store = new FakeStore(held);
    const source = snapshotOf(head);

    const run = await runSnapshotPipeline({
      corpusId: 'statutes-canada',
      revision: { commit: 'new456', date: '2026-10-15' },
      source,
      store,
      encoder,
      now,
    });

    expect(run.counts.added).toBe(1);
    expect(run.counts.changed).toBe(0);
    expect(run.counts.removed).toBe(0);
  });

  it('records the revision the store is now at', async () => {
    const store = new FakeStore([]);
    const source = snapshotOf([]);

    await runSnapshotPipeline({
      corpusId: 'statutes-canada',
      revision: { commit: 'new456', date: '2026-10-15' },
      source,
      store,
      encoder,
      now,
    });

    expect(store.states[0]).toMatchObject({
      corpusId: 'statutes-canada',
      commit: 'new456',
      asOf: '2026-10-15',
    });
  });
});
