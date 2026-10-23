import { SNAPSHOT_PARSER_VERSION, type SnapshotManifest } from '../../src/ingest/snapshot-format';
import type { CorpusRevision } from '../../src/ingest/source';
import type { CoordinatorStorage } from './single-flight';

export interface PipelineControlEnv {
  PIPELINE_PINNED_COMMIT?: string;
  PIPELINE_PINNED_DATE?: string;
  PIPELINE_EMBEDDING_ATTEMPT_CAP?: string;
}
export interface PipelineControl {
  commit: string;
  date: string;
  parser: string;
  cap: number;
}
interface AttemptRecord extends PipelineControl { format: 1; submitted: number }
export const ATTEMPT_BUDGET_KEY = 'embedding-attempt-budget-v1';
const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

export function pipelineControl(env: PipelineControlEnv): PipelineControl | undefined {
  const { PIPELINE_PINNED_COMMIT: commit, PIPELINE_PINNED_DATE: date, PIPELINE_EMBEDDING_ATTEMPT_CAP: capText } = env;
  if (commit === undefined && date === undefined && capText === undefined) return undefined;
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit) || typeof date !== 'string' || !validDate(date) ||
    typeof capText !== 'string' || !/^[1-9]\d*$/.test(capText) || !Number.isSafeInteger(Number(capText))) {
    throw new Error('controlled pipeline requires PIPELINE_PINNED_COMMIT (full SHA), PIPELINE_PINNED_DATE (valid YYYY-MM-DD), and PIPELINE_EMBEDDING_ATTEMPT_CAP (positive integer) together');
  }
  return { commit, date, parser: SNAPSHOT_PARSER_VERSION, cap: Number(capText) };
}

/** Reservations are never refunded: a failed or uncertain HTTP request may
 * already have spent model work. This key survives slices, alarms and restarts.
 * There is deliberately no reset/increase operation. One corpus coordinator
 * serializes all callers; this local queue also serializes concurrent sends. */
export class DurableAttemptBudget {
  private tail: Promise<void> = Promise.resolve();
  private initialized: Promise<void> | null = null;
  constructor(private readonly storage: Pick<CoordinatorStorage, 'get' | 'put'>,
    readonly control: PipelineControl | undefined) {}

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
  private checked(value: unknown): AttemptRecord {
    const record = value as AttemptRecord | undefined;
    const control = this.control;
    if (!control || !record || record.format !== 1 || record.commit !== control.commit || record.date !== control.date ||
      record.parser !== control.parser || record.cap !== control.cap || !Number.isSafeInteger(record.submitted) ||
      record.submitted < 0 || record.submitted > record.cap) {
      throw new Error('persisted embedding budget identity/cap differs or is invalid; controls cannot be removed, changed, reset or increased on this coordinator');
    }
    return record;
  }
  initialize(): Promise<void> {
    this.initialized ??= this.exclusive(async () => {
      const existing = await this.storage.get<unknown>(ATTEMPT_BUDGET_KEY);
      if (existing !== undefined) { this.checked(existing); return; }
      if (this.control) await this.storage.put(ATTEMPT_BUDGET_KEY, { format: 1, ...this.control, submitted: 0 } satisfies AttemptRecord);
    });
    return this.initialized;
  }
  async status() {
    await this.initialize();
    if (!this.control) return { controlled: false as const };
    return this.exclusive(async () => {
      const record = this.checked(await this.storage.get<unknown>(ATTEMPT_BUDGET_KEY));
      return { controlled: true as const, ...record, remaining: record.cap - record.submitted };
    });
  }
  assertHead(head: CorpusRevision): void {
    const control = this.control;
    if (control && (head.commit !== control.commit || head.date !== control.date)) {
      throw new Error('upstream source head differs from the controlled pipeline commit/date pin');
    }
  }
  assertSnapshot(manifest: SnapshotManifest): void {
    const control = this.control;
    if (control && (manifest.commit !== control.commit || manifest.date !== control.date || manifest.parser !== control.parser ||
      !/^[a-f0-9]{32}$/.test(manifest.index.digest ?? '') || !/^[a-f0-9]{64}$/.test(manifest.index.sha256 ?? ''))) {
      throw new Error('controlled pipeline requires the matching immutable snapshot commit/date/parser and index identity');
    }
  }
  private async reserve(count: number): Promise<void> {
    await this.initialize();
    if (!this.control) return;
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('controlled encoder request must contain documents');
    await this.exclusive(async () => {
      const record = this.checked(await this.storage.get<unknown>(ATTEMPT_BUDGET_KEY));
      if (count > record.cap - record.submitted) {
        throw new Error(`embedding attempt budget exhausted: ${record.submitted}/${record.cap} submitted, ${count} requested`);
      }
      await this.storage.put(ATTEMPT_BUDGET_KEY, { ...record, submitted: record.submitted + count });
    });
  }
  /** Guard the actual HTTP boundary, so every retry spends its own allowance. */
  async sendEncoder(request: Request, dependencies: {
    head(): Promise<CorpusRevision>;
    snapshot(): Promise<SnapshotManifest>;
    send(request: Request): Promise<Response>;
  }): Promise<Response> {
    await this.initialize();
    if (!this.control) return dependencies.send(request);
    const body = await request.clone().json() as { texts?: unknown; titles?: unknown };
    if (!Array.isArray(body.texts) || !body.texts.length || !body.texts.every((text) => typeof text === 'string') ||
      !Array.isArray(body.titles) || body.titles.length !== body.texts.length || !body.titles.every((title) => typeof title === 'string')) {
      throw new Error('controlled encoder request must contain matching text/title document arrays');
    }
    this.assertHead(await dependencies.head());
    this.assertSnapshot(await dependencies.snapshot());
    await this.reserve(body.texts.length);
    return dependencies.send(request);
  }
}
