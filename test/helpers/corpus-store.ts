import { fingerprint } from '../../src/ingest/reconcile';
import type {
  ChangeFeedEntry,
  CorpusStore,
  PipelineRow,
  RemovedRow,
} from '../../src/ingest/pipeline';

/**
 * The test doubles for the pipeline.
 *
 * The store is the interesting one: the reconciliation is only as good as
 * what it is compared against, and the cheapest way to be sure the comparison
 * is fair is to have **one** store double rather than two that drift.
 */

export function row(id: string, overrides: Partial<PipelineRow> = {}): PipelineRow {
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

/** A store that remembers what it was asked to do. */
export class FakeStore implements CorpusStore {
  rows = new Map<string, { row: PipelineRow; hash: string }>();
  removed: RemovedRow[] = [];
  runs: unknown[] = [];
  states: unknown[] = [];
  changes: ChangeFeedEntry[] = [];
  /** Called on every write, with the number of rows written. */
  onUpsert?: (rows: number) => void;

  constructor(seed: PipelineRow[] = []) {
    for (const r of seed) this.rows.set(r.id, { row: r, hash: fingerprint(r) });
  }

  async fingerprints(): Promise<Map<string, string>> {
    return new Map([...this.rows].map(([id, v]) => [id, v.hash]));
  }
  async upsert(rows: { row: PipelineRow; hash: string }[]): Promise<void> {
    for (const r of rows) this.rows.set(r.row.id, { row: r.row, hash: r.hash });
    this.onUpsert?.(rows.length);
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
