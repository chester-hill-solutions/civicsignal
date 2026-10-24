import { describe, expect, it } from 'vitest';
import { runSnapshotPipeline } from '../src/ingest/snapshot-pipeline';
import type { SnapshotSource } from '../src/ingest/snapshot-source';
import type { SnapshotIndexEntry } from '../src/ingest/snapshot-diff';
import { EMBED_BATCH, type PipelineRow } from '../src/ingest/pipeline';
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
type R2Source = SnapshotSource;

function snapshotOf(rows: PipelineRow[]): SnapshotSource {
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
    revision: 'new456',
    index: async () => index,
    // The merge needs the index in id order, which is the order the file is
    // written in and the order D1 pages the store's fingerprints in.
    async *indexEntries() {
      for (const entry of [...index.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        yield entry;
      }
    },
    row: async (id: string) => rows.find((r) => r.id === id) ?? null,
    rows: async (entries: SnapshotIndexEntry[]) =>
      rows.filter((r) => entries.some((entry) => entry.id === r.id)),
  } as unknown as SnapshotSource;
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

/**
 * The budget, and what makes a store that is far behind not a special case.
 *
 * Two hundred thousand provisions cannot be fetched, embedded and written in
 * one invocation — the encoder alone would take hours. So a cycle writes what
 * it can and stops, and nothing has to be remembered for the next one to
 * continue: **the fingerprints are the progress**. A provision that has been
 * written no longer differs from the snapshot, so the next diff does not
 * mention it.
 *
 * The other half of that is the state. Until the diff has been exhausted the
 * store is at *no* revision — it is part of the way from one to another — and
 * a cycle that claimed one would make the next cycle skip the rest of the gap.
 */
describe('a cycle with a budget', () => {
  const corpus = ['a-1', 'a-2', 'a-3', 'a-4', 'a-5'].map((id) => rowOf(id, `Text ${id}.`));

  function options(store: FakeStore, source: R2Source) {
    return {
      corpusId: 'statutes-canada',
      revision: { commit: 'new456', date: '2026-10-15' },
      source,
      store,
      encoder,
      now,
    };
  }

  it('writes what it can and says there is more', async () => {
    const store = new FakeStore([]);
    const run = await runSnapshotPipeline({ ...options(store, snapshotOf(corpus)), maxRows: 2 });

    expect(run.remaining).toBe(true);
    expect(run.counts.added).toBe(2);
    expect(store.rows.size).toBe(2);
  });

  it('claims no revision until it is at one', async () => {
    const store = new FakeStore([]);
    await runSnapshotPipeline({ ...options(store, snapshotOf(corpus)), maxRows: 2 });

    expect(store.states).toHaveLength(0);
  });

  it('continues from the fingerprints, remembering nothing', async () => {
    const store = new FakeStore([]);
    const source = snapshotOf(corpus);

    const first = await runSnapshotPipeline({ ...options(store, source), maxRows: 2 });
    const second = await runSnapshotPipeline({ ...options(store, source), maxRows: 2 });
    const third = await runSnapshotPipeline({ ...options(store, source), maxRows: 2 });

    expect([first.remaining, second.remaining]).toEqual([true, true]);
    expect(third.remaining).toBeFalsy();
    expect(store.rows.size).toBe(5);
    expect(store.states).toHaveLength(1);
    expect(store.states[0]).toMatchObject({ commit: 'new456', rowCount: 5 });
  });

  it('does nothing at all when the store is already at the snapshot', async () => {
    const store = new FakeStore(corpus);
    const run = await runSnapshotPipeline({ ...options(store, snapshotOf(corpus)), maxRows: 2 });

    expect(run.counts.added).toBe(0);
    expect(run.counts.changed).toBe(0);
    expect(run.counts.unchanged).toBe(5);
    expect(run.remaining).toBeFalsy();
    expect(store.rows.size).toBe(5);
  });

  it('stops loudly when the snapshot has no row for a provision its index names', async () => {
    const store = new FakeStore([]);
    const source = snapshotOf(corpus);
    // An index that names a provision whose row is not in the file.
    const truncated = {
      ...source,
      rows: async (entries: SnapshotIndexEntry[]) =>
        (await source.rows(entries)).slice(0, entries.length - 1),
    } as unknown as R2Source;

    await expect(
      runSnapshotPipeline({ ...options(store, truncated) }),
    ).rejects.toThrow(/has no row for/);
  });

  it('keeps the row budget, placeholders, removals and publication boundary across provider-sized writes', async () => {
    const active = Array.from({ length: EMBED_BATCH }, (_, i) =>
      rowOf(`a-${String(i).padStart(3, '0')}`, `Provision ${i}.`));
    const placeholder = row('p-placeholder', { status: 'placeholder', text: '[Reserved]' });
    const same = rowOf('s-same', 'Unchanged.'), gone = rowOf('z-gone', 'Removed later.');
    const store = new FakeStore([same, gone]);
    const source = snapshotOf([...active, placeholder, same]);
    const submitted: string[] = [];
    const counting = { async embed(documents: { title: string; text: string }[]) {
      submitted.push(...documents.map(document => document.text));
      return documents.map(() => [0.1, 0.2]);
    } };
    const first = await runSnapshotPipeline({ ...options(store, source), encoder: counting, maxRows: EMBED_BATCH + 1 });
    expect(first).toMatchObject({ remaining: true, embedded: EMBED_BATCH,
      counts: { added: EMBED_BATCH + 1, removed: 0 } });
    expect(store.rows.has(placeholder.id)).toBe(true); expect(store.rows.has(gone.id)).toBe(true);
    expect(store.states).toHaveLength(0);
    expect(submitted).toEqual(active.map(value => value.text));

    const second = await runSnapshotPipeline({ ...options(store, source), encoder: counting, maxRows: EMBED_BATCH + 1 });
    expect(second).toMatchObject({ remaining: false, embedded: 0,
      counts: { added: 0, changed: 0, removed: 1, unchanged: EMBED_BATCH + 2 } });
    expect(store.rows.has(gone.id)).toBe(false);
    expect(store.states).toHaveLength(1);
    expect(store.states[0]).toMatchObject({ commit: 'new456', rowCount: EMBED_BATCH + 2 });
    expect(store.changes).toHaveLength(EMBED_BATCH + 2);
    expect(submitted).toHaveLength(EMBED_BATCH);
  });
});
