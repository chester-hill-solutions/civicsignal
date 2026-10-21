import { describe, expect, it } from 'vitest';
import { rowsForFile } from '../src/ingest/corpus-rows';
import { runIncrementalPipeline } from '../src/ingest/incremental-pipeline';
import type { CorpusSource, ChangedFile } from '../src/ingest/source';
import { FakeStore } from './helpers/corpus-store';

/**
 * The incremental cycle.
 *
 * The whole corpus does not fit in a Worker, so the cycle works on the files
 * that changed — and everything hard about that is in the **before**: a
 * provision that is no longer in the corpus is a provision that *was* in the
 * file at the revision the store holds, and the only way to find it is to
 * fetch that file again.
 *
 * These tests are about that, and about the two ways it can go wrong: a
 * comparison that was cut short, and a provision that moved from one file to
 * another.
 */

/** A source that knows about two revisions of two files. */
class FakeSource implements CorpusSource {
  /** The files, by revision. */
  revisions = new Map<string, Map<string, string>>();
  /** The files that changed, as the comparison reports them. */
  changed: ChangedFile[] = [];
  /** True when the comparison was cut short. */
  truncated = false;
  /** The revisions the source was asked about. */
  asked: { base: string; head: string }[] = [];

  async head() {
    return { commit: 'new456', date: '2026-10-15' };
  }
  async *instruments() {
    // The incremental cycle does not stream the tree.
  }
  async changedFiles(base: string, head: string) {
    this.asked.push({ base, head });
    return { files: this.changed, truncated: this.truncated };
  }
  async fileAt(path: string, revision: string): Promise<string | null> {
    return this.revisions.get(revision)?.get(path) ?? null;
  }
}

const encoder = {
  async embed(documents: { title: string; text: string }[]) {
    return documents.map(() => new Array(768).fill(0.1));
  },
};

const previous = { commit: 'old123', date: '2026-09-01', rowCount: 2 };
const next = { commit: 'new456', date: '2026-10-15' };
const now = new Date('2026-10-15T12:00:00Z');

const PATH = 'eng/acts/A-1.xml';

/** The rows of a file, as the cycle parses them. */
function rowsOf(xml: string) {
  return rowsForFile({ path: PATH, content: xml, date: '2026-10-15' });
}

describe('the incremental cycle', () => {
  it('embeds only what changed', async () => {
    const oldXml = statute('This Act may be cited as the Access to Information Act.');
    const newXml = statute('This Act may be cited as the Access to Information Act, R.S.C. 1985.');
    const store = new FakeStore(rowsOf(oldXml));
    const source = new FakeSource();
    source.changed = [{ path: PATH, status: 'modified' }];
    source.revisions.set('old123', new Map([[PATH, oldXml]]));
    source.revisions.set('new456', new Map([[PATH, newXml]]));

    const embedded: string[] = [];
    const counting = {
      async embed(documents: { title: string; text: string }[]) {
        embedded.push(...documents.map((d) => `${d.title}\n${d.text}`));
        return documents.map(() => new Array(768).fill(0.1));
      },
    };

    const run = await runIncrementalPipeline({
      corpusId: 'statutes-canada',
      previous,
      next,
      source,
      store,
      encoder: counting,
      now,
    });

    expect(run.counts.changed).toBe(1);
    expect(run.embedded).toBe(1);
    expect(embedded.join(' ')).toContain('R.S.C. 1985.');
  });

  /**
   * The removals.
   *
   * A provision that is no longer in the corpus has to be found, and nothing
   * about it arrives with the new file — it is only in the old one. That is
   * why the cycle fetches the changed files twice.
   */
  it('finds the provisions that went', async () => {
    const oldXml = statute(
      'This Act may be cited as the Access to Information Act.',
      'A second provision, which the new file will not have.',
    );
    const newXml = statute('This Act may be cited as the Access to Information Act.');
    const store = new FakeStore(rowsOf(oldXml));
    const source = new FakeSource();
    source.changed = [{ path: PATH, status: 'modified' }];
    source.revisions.set('old123', new Map([[PATH, oldXml]]));
    source.revisions.set('new456', new Map([[PATH, newXml]]));

    const run = await runIncrementalPipeline({
      corpusId: 'statutes-canada',
      previous,
      next,
      source,
      store,
      encoder,
      now,
    });

    expect(run.counts.removed).toBe(1);
    expect(store.rows.size).toBe(1);
  });

  it('costs nothing when the file did not change', async () => {
    const xml = statute('This Act may be cited as the Access to Information Act.');
    const store = new FakeStore(rowsOf(xml));
    const source = new FakeSource();
    source.changed = [{ path: PATH, status: 'modified' }];
    source.revisions.set('old123', new Map([[PATH, xml]]));
    source.revisions.set('new456', new Map([[PATH, xml]]));

    let calls = 0;
    const counting = {
      async embed(documents: { title: string; text: string }[]) {
        calls++;
        return documents.map(() => new Array(768).fill(0.1));
      },
    };

    const run = await runIncrementalPipeline({
      corpusId: 'statutes-canada',
      previous,
      next,
      source,
      store,
      encoder: counting,
      now,
    });

    expect(calls).toBe(0);
    expect(run.embedded).toBe(0);
    expect(run.counts.unchanged).toBe(1);
  });

  /**
   * A provision that moved from one file to another is not a removal.
   *
   * It is gone from the old file and it is in the new one, and a cycle that
   * looked at each file on its own would delete it and then re-add it.
   */
  it('does not remove a provision that moved to another file', async () => {
    const xml = statute('This Act may be cited as the Access to Information Act.');
    const store = new FakeStore(rowsOf(xml));
    const source = new FakeSource();
    source.changed = [
      { path: PATH, status: 'removed' },
      { path: 'eng/acts/A-2.xml', status: 'added' },
    ];
    source.revisions.set('old123', new Map([[PATH, xml]]));
    source.revisions.set('new456', new Map([['eng/acts/A-2.xml', xml]]));

    const run = await runIncrementalPipeline({
      corpusId: 'statutes-canada',
      previous,
      next,
      source,
      store,
      encoder,
      now,
    });

    expect(run.counts.removed).toBe(0);
    expect(run.counts.added).toBe(0);
    expect(store.rows.size).toBe(1);
  });

  /**
   * The comparison that was cut short.
   *
   * GitHub names at most 300 files and does not say that it has stopped early.
   * A cycle that trusted a truncated list would leave part of the corpus
   * stale and say nothing — so it stops, loudly.
   */
  it('stops when the comparison was cut short', async () => {
    const store = new FakeStore([]);
    const source = new FakeSource();
    source.truncated = true;

    await expect(
      runIncrementalPipeline({
        corpusId: 'statutes-canada',
        previous,
        next,
        source,
        store,
        encoder,
        now,
      }),
    ).rejects.toThrow(/the change list is incomplete/);
  });

  it('compares against the revision the store is at', async () => {
    const store = new FakeStore([]);
    const source = new FakeSource();

    await runIncrementalPipeline({
      corpusId: 'statutes-canada',
      previous,
      next,
      source,
      store,
      encoder,
      now,
    });

    expect(source.asked).toEqual([{ base: 'old123', head: 'new456' }]);
  });

  it('records the revision the store is now at', async () => {
    const store = new FakeStore([]);
    const source = new FakeSource();

    await runIncrementalPipeline({
      corpusId: 'statutes-canada',
      previous,
      next,
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
 * A statute with the given sections, in the shape the corpus really has.
 *
 * The cycle's parsing is the real one — a test that fed it rows directly
 * would be testing the reconciliation and nothing else.
 */
function statute(...texts: string[]): string {
  const body = texts
    .map(
      (text, index) => `
    <Section lims:id="${177 + index}">
      <MarginalNote>Short title</MarginalNote>
      <Label>${index + 1}</Label>
      <Text>${text}</Text>
    </Section>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<Statute lims:pit-date="2026-06-14" in-force="yes" xml:lang="en" xmlns:lims="http://justice.gc.ca/lims">
  <Identification>
    <LongTitle>An Act to extend the present laws of Canada</LongTitle>
    <ShortTitle>Access to Information Act</ShortTitle>
    <RunningHead>Access to Information</RunningHead>
    <Chapter><ConsolidatedNumber official="yes">A-1</ConsolidatedNumber></Chapter>
  </Identification>
  <Body>${body}
  </Body>
</Statute>`;
}
