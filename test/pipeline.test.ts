import { describe, expect, it } from 'vitest';
import {
  embeddableText,
  runPipeline,
  type ChangeFeedEntry,
  type CorpusStore,
  type PipelineRow,
  type RemovedRow,
} from '../src/ingest/pipeline';
import { fingerprint, fingerprintsOf } from '../src/ingest/reconcile';

/**
 * The pipeline's behaviour.
 *
 * The expensive mistake is embedding everything: it costs an hour of CPU a
 * commit and produces a different index each time, so the index has no version
 * and "as of" means nothing. The dangerous mistake is embedding too little: a
 * provision that changed is never updated, and the product serves stale law
 * under a fresh date.
 */

function row(id: string, overrides: Partial<PipelineRow> = {}): PipelineRow {
  return {
    id,
    corpusId: 'statutes-canada',
    instrument: 'Access to Information Act',
    citation: 'A-1',
    section: id.split('-').pop() ?? '1',
    status: 'in-force',
    schedule: null,
    part: null,
    heading: 'Short title',
    text: 'This Act may be cited as the Access to Information Act.',
    source_url: 'https://laws-lois.justice.gc.ca/en/acts/A-1/section-1.html',
    in_force: 1,
    language: 'en',
    embedText: '',
    lastChanged: '2026-10-15',
    ...overrides,
  };
}

class FakeStore implements CorpusStore {
  rows = new Map<string, { row: PipelineRow; hash: string }>();
  removed: RemovedRow[] = [];
  runs: unknown[] = [];
  states: unknown[] = [];
  changes: ChangeFeedEntry[] = [];

  constructor(seed: PipelineRow[] = []) {
    for (const r of seed) this.rows.set(r.id, { row: r, hash: fingerprint(r) });
  }

  async fingerprints(): Promise<Map<string, string>> {
    return new Map([...this.rows].map(([id, v]) => [id, v.hash]));
  }
  async *fingerprintEntries() {
    yield* fingerprintsOf(new Map([...this.rows].map(([id, v]) => [id, v.hash])));
  }
  async upsert(rows: { row: PipelineRow; hash: string }[]): Promise<void> {
    for (const r of rows) this.rows.set(r.row.id, { row: r.row, hash: r.hash });
  }
  async remove(ids: string[]): Promise<RemovedRow[]> {
    const out: RemovedRow[] = [];
    for (const id of ids) {
      const existing = this.rows.get(id);
      if (existing) {
        out.push({
          id,
          instrument: existing.row.instrument,
          citation: existing.row.citation,
          section: existing.row.section,
          heading: existing.row.heading,
          status: existing.row.status,
          sourceUrl: existing.row.source_url,
        });
        this.rows.delete(id);
      }
    }
    this.removed = out;
    return out;
  }
  async recordRun(run: unknown): Promise<void> {
    this.runs.push(run);
  }
  async recordChanges(changes: ChangeFeedEntry[]): Promise<void> {
    this.changes.push(...changes);
  }
  async setState(state: unknown): Promise<void> {
    this.states.push(state);
  }
}

describe('the pipeline', () => {
  const previous = { commit: 'abc123', date: '2026-09-01' };
  const next = { commit: 'def456', date: '2026-10-15' };

  it('embeds only what changed', async () => {
    const seed = [row('a-1'), row('a-2'), row('a-3')];
    const store = new FakeStore(seed);
    const embedded: string[] = [];
    const encoder = {
      async embed(documents: { title: string; text: string }[]) {
        embedded.push(...documents.map((d) => `${d.title}\n${d.text}`));
        return documents.map(() => new Array(768).fill(0.1));
      },
    };

    // One provision's text changes; one is added; one goes.
    const rows = [row('a-1'), row('a-2', { text: 'A different provision entirely.' }), row('a-4')];

    const run = await runPipeline({
      corpusId: 'statutes-canada',
      previous,
      next,
      rows,
      store,
      encoder,
      now: new Date('2026-10-15T12:00:00Z'),
    });

    expect(run.counts).toEqual({ added: 1, changed: 1, removed: 1, unchanged: 1 });
    expect(run.embedded).toBe(2);
    expect(embedded).toHaveLength(2);
    expect(embedded.join(' ')).toContain('A different provision entirely.');
  });

  it('costs nothing when nothing changed', async () => {
    const seed = [row('a-1'), row('a-2')];
    const store = new FakeStore(seed);
    let calls = 0;
    const encoder = {
      async embed(documents: { title: string; text: string }[]) {
        calls++;
        return documents.map(() => new Array(768).fill(0.1));
      },
    };

    const run = await runPipeline({
      corpusId: 'statutes-canada',
      previous,
      next,
      rows: [row('a-1'), row('a-2')],
      store,
      encoder,
      now: new Date('2026-10-15T12:00:00Z'),
    });

    expect(calls).toBe(0);
    expect(run.embedded).toBe(0);
    expect(run.counts.unchanged).toBe(2);
    expect(run.ok).toBe(true);
  });

  /**
   * A placeholder is a gap in the consolidation — "[Amendment]". There are
   * eleven thousand of them and every one has the same text, so embedding them
   * puts eleven thousand identical vectors into the index. They are written, and
   * they are not embedded.
   */
  it('stores a placeholder without embedding it', async () => {
    const store = new FakeStore([]);
    const embedded: string[] = [];
    const encoder = {
      async embed(documents: { title: string; text: string }[]) {
        embedded.push(...documents.map((d) => `${d.title}\n${d.text}`));
        return documents.map(() => new Array(768).fill(0.1));
      },
    };
    const placeholder = row('a-9', { status: 'placeholder', text: '[Amendment]' });

    const run = await runPipeline({
      corpusId: 'statutes-canada',
      previous,
      next,
      rows: [placeholder],
      store,
      encoder,
      now: new Date('2026-10-15T12:00:00Z'),
    });

    expect(embedded).toHaveLength(0);
    expect(run.embedded).toBe(0);
    expect(store.rows.has('a-9')).toBe(true);
  });

  it('records what changed in the feed, including what was removed', async () => {
    const store = new FakeStore([row('a-1'), row('a-2')]);
    const encoder = { async embed(d: { title: string; text: string }[]) { return d.map(() => new Array(768).fill(0.1)); } };

    await runPipeline({
      corpusId: 'statutes-canada',
      previous,
      next,
      rows: [row('a-1', { text: 'Changed.' }), row('a-3')],
      store,
      encoder,
      now: new Date('2026-10-15T12:00:00Z'),
    });

    const byChange = Object.fromEntries(store.changes.map((c) => [c.change, c]));
    expect(byChange['added']?.rowId).toBe('a-3');
    expect(byChange['changed']?.rowId).toBe('a-1');
    expect(byChange['removed']?.rowId).toBe('a-2');
    // The removed entry says which provision it was, not just that something went.
    expect(byChange['removed']?.instrument).toBe('Access to Information Act');
    expect(store.changes.every((c) => c.occurredAt === '2026-10-15')).toBe(true);
  });

  it('records the revision the store is now at', async () => {
    const store = new FakeStore([row('a-1')]);
    const encoder = { async embed(d: { title: string; text: string }[]) { return d.map(() => new Array(768).fill(0.1)); } };

    await runPipeline({
      corpusId: 'statutes-canada',
      previous,
      next,
      rows: [row('a-1')],
      store,
      encoder,
      now: new Date('2026-10-15T12:00:00Z'),
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
    const encoder = { async embed(_d: { title: string; text: string }[]) { return []; } };

    await expect(
      runPipeline({
        corpusId: 'statutes-canada',
        previous,
        next,
        rows: [row('a-1')],
        store,
        encoder,
        now: new Date('2026-10-15T12:00:00Z'),
      }),
    ).rejects.toThrow(/returned 0 vectors for 1 documents/);
  });
});

describe('the embedded document', () => {
  /**
   * The title and the text are separate, because the encoder's own document
   * instruction is `title: {title} | text: {content}` — the model is told which
   * is which, and a title glued onto the front of the body is a different
   * document to the model.
   */
  it('puts the instrument and the heading in the title', () => {
    const document = embeddableText({
      instrument: 'Canada Labour Code',
      heading: 'Employee entitled to leave',
      text: '(1) Every employee is entitled to leave.',
    });
    expect(document.title).toContain('Canada Labour Code');
    expect(document.title).toContain('Employee entitled to leave');
    expect(document.text).toContain('(1) Every employee is entitled to leave.');
    expect(document.text).not.toContain('Canada Labour Code');
  });

  it('copes with a provision that has no heading', () => {
    const document = embeddableText({
      instrument: 'Canada Labour Code',
      heading: null,
      text: '(1) Every employee is entitled to leave.',
    });
    expect(document.title).toBe('Canada Labour Code');
  });
});
