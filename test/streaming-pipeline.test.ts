import { describe, expect, it } from 'vitest';
import { runPipeline, type PipelineRow } from '../src/ingest/pipeline';
import { runStreamingPipeline } from '../src/ingest/streaming-pipeline';
import { FakeStore, row } from './helpers/corpus-store';

/**
 * The streamed cycle.
 *
 * `runPipeline` is the tested version and it takes the whole corpus at once.
 * The streamed one exists because a Worker cannot: the corpus is 277,857 rows
 * and a Worker has 128 MB. So these tests are about two things — that the
 * streamed version makes the *same decisions* as the array one, and that it
 * makes them without holding the corpus.
 */

/** The rows, one at a time, the way the corpus's tree arrives. */
async function* stream(rows: PipelineRow[]): AsyncGenerator<PipelineRow> {
  for (const r of rows) yield r;
}

const encoder = {
  async embed(documents: { title: string; text: string }[]) {
    return documents.map(() => new Array(768).fill(0.1));
  },
};

const next = { commit: 'def456', date: '2026-10-15' };
const now = new Date('2026-10-15T12:00:00Z');

describe('the streamed cycle', () => {
  it('embeds only what changed', async () => {
    const store = new FakeStore([row('a-1'), row('a-2'), row('a-3')]);
    const embedded: string[] = [];
    const counting = {
      async embed(documents: { title: string; text: string }[]) {
        embedded.push(...documents.map((d) => `${d.title}\n${d.text}`));
        return documents.map(() => new Array(768).fill(0.1));
      },
    };

    const run = await runStreamingPipeline({
      corpusId: 'statutes-canada',
      next,
      rows: stream([row('a-1'), row('a-2', { text: 'A different provision entirely.' }), row('a-4')]),
      store,
      encoder: counting,
      now,
    });

    expect(run.counts).toEqual({ added: 1, changed: 1, removed: 1, unchanged: 1 });
    expect(run.embedded).toBe(2);
    expect(embedded).toHaveLength(2);
    expect(embedded.join(' ')).toContain('A different provision entirely.');
  });

  it('costs nothing when nothing changed', async () => {
    const store = new FakeStore([row('a-1'), row('a-2')]);
    let calls = 0;
    const counting = {
      async embed(documents: { title: string; text: string }[]) {
        calls++;
        return documents.map(() => new Array(768).fill(0.1));
      },
    };

    const run = await runStreamingPipeline({
      corpusId: 'statutes-canada',
      next,
      rows: stream([row('a-1'), row('a-2')]),
      store,
      encoder: counting,
      now,
    });

    expect(calls).toBe(0);
    expect(run.embedded).toBe(0);
    expect(run.counts.unchanged).toBe(2);
    expect(run.ok).toBe(true);
  });

  /**
   * The removal is the one thing the streamed version has to get right on its
   * own: the row is not in the corpus any more, so nothing about it arrives.
   * What finds it is the store's own list — the fingerprints the corpus did
   * not mention.
   */
  it('finds the rows the corpus no longer mentions', async () => {
    const store = new FakeStore([row('a-1'), row('a-2'), row('a-3')]);

    const run = await runStreamingPipeline({
      corpusId: 'statutes-canada',
      next,
      rows: stream([row('a-1'), row('a-3')]),
      store,
      encoder,
      now,
    });

    expect(run.counts.removed).toBe(1);
    expect(store.rows.has('a-2')).toBe(false);
    expect(store.removed.map((r) => r.id)).toEqual(['a-2']);
  });

  /**
   * The property the whole rewrite is for.
   *
   * The array version reads the corpus into memory and then writes. The
   * streamed one writes *while it reads*, so the peak memory is a batch and
   * the store's fingerprints — not the corpus. If this test ever fails because
   * the writes happen at the end, the Worker port is broken and the array
   * version's memory is back.
   */
  it('writes as it reads, rather than after the whole corpus', async () => {
    const store = new FakeStore([]);
    const total = 20;
    let produced = 0;
    const writtenAfter: number[] = [];
    store.onUpsert = () => writtenAfter.push(produced);

    async function* corpus(): AsyncGenerator<PipelineRow> {
      for (let i = 0; i < total; i++) {
        produced++;
        yield row(`a-${i}`);
      }
    }

    await runStreamingPipeline({
      corpusId: 'statutes-canada',
      next,
      rows: corpus(),
      store,
      encoder,
      now,
      batchSize: 5,
    });

    // Four batches of five, and the first one went out after five rows had
    // been produced — not after all twenty.
    expect(writtenAfter).toEqual([5, 10, 15, 20]);
  });

  it('stores a placeholder without embedding it', async () => {
    const store = new FakeStore([]);
    const embedded: string[] = [];
    const counting = {
      async embed(documents: { title: string; text: string }[]) {
        embedded.push(...documents.map((d) => `${d.title}\n${d.text}`));
        return documents.map(() => new Array(768).fill(0.1));
      },
    };

    const run = await runStreamingPipeline({
      corpusId: 'statutes-canada',
      next,
      rows: stream([row('a-9', { status: 'placeholder', text: '[Amendment]' })]),
      store,
      encoder: counting,
      now,
    });

    expect(embedded).toHaveLength(0);
    expect(run.embedded).toBe(0);
    expect(store.rows.has('a-9')).toBe(true);
  });

  it('records what changed in the feed, including what was removed', async () => {
    const store = new FakeStore([row('a-1'), row('a-2')]);

    await runStreamingPipeline({
      corpusId: 'statutes-canada',
      next,
      rows: stream([row('a-1', { text: 'Changed.' }), row('a-3')]),
      store,
      encoder,
      now,
    });

    const byChange = Object.fromEntries(store.changes.map((c) => [c.change, c]));
    expect(byChange['added']?.rowId).toBe('a-3');
    expect(byChange['changed']?.rowId).toBe('a-1');
    expect(byChange['removed']?.rowId).toBe('a-2');
    expect(byChange['removed']?.instrument).toBe('Access to Information Act');
    expect(store.changes.every((c) => c.occurredAt === '2026-10-15')).toBe(true);
  });

  it('records the revision the store is now at', async () => {
    const store = new FakeStore([row('a-1')]);

    await runStreamingPipeline({
      corpusId: 'statutes-canada',
      next,
      rows: stream([row('a-1')]),
      store,
      encoder,
      now,
    });

    expect(store.states[0]).toMatchObject({
      corpusId: 'statutes-canada',
      commit: 'def456',
      asOf: '2026-10-15',
      rowCount: 1,
    });
  });

  it('fails loudly when the encoder returns the wrong number of vectors', async () => {
    const store = new FakeStore([]);
    const wrong = { async embed(_d: { title: string; text: string }[]) { return []; } };

    await expect(
      runStreamingPipeline({
        corpusId: 'statutes-canada',
        next,
        rows: stream([row('a-1')]),
        store,
        encoder: wrong,
        now,
      }),
    ).rejects.toThrow(/returned 0 vectors for 1 documents/);
  });

  /**
   * Parity with the tested version.
   *
   * The streamed version is a port, and a port is only as good as its
   * agreement with the thing it was ported from. Same corpus, same seed, two
   * runs: the same counts, the same rows left in the store, the same change
   * feed.
   */
  it('agrees with the array version, row for row', async () => {
    const seed = [row('a-1'), row('a-2'), row('a-3')];
    const corpus = [
      row('a-1'),
      row('a-2', { text: 'A different provision entirely.' }),
      row('a-4'),
    ];

    const arrayStore = new FakeStore(seed);
    const arrayRun = await runPipeline({
      corpusId: 'statutes-canada',
      previous: { commit: 'abc123', date: '2026-09-01' },
      next,
      rows: corpus,
      store: arrayStore,
      encoder,
      now,
    });

    const streamedStore = new FakeStore(seed);
    const streamedRun = await runStreamingPipeline({
      corpusId: 'statutes-canada',
      next,
      rows: stream(corpus),
      store: streamedStore,
      encoder,
      now,
    });

    expect(streamedRun.counts).toEqual(arrayRun.counts);
    expect(streamedRun.embedded).toBe(arrayRun.embedded);
    expect([...streamedStore.rows.keys()].sort()).toEqual([...arrayStore.rows.keys()].sort());
    expect(
      streamedStore.changes.map((c) => `${c.change}:${c.rowId}`).sort(),
    ).toEqual(arrayStore.changes.map((c) => `${c.change}:${c.rowId}`).sort());
    expect(streamedStore.states[0]).toEqual(arrayStore.states[0]);
  });
});
