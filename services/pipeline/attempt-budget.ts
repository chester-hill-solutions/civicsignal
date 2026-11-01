import { SNAPSHOT_PARSER_VERSION, type SnapshotManifest } from '../../src/ingest/snapshot-format';
import type { CorpusRevision } from '../../src/ingest/source';
import { COORDINATOR_ADMISSION_KEY, type CoordinatorStorage } from './single-flight';
import { readRecoveryReceipt, STAGE_RECOVERY_PLAN as recoveryPlan, STAGE_RECOVERY_PLAN_SHA256,
  type StageRecoveryAuthorization, type StageRecoveryReceipt } from './staging-recovery-plan';

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
interface AttemptRecord extends PipelineControl { format: 1; submitted: number; recovery?: StageRecoveryReceipt }
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
 * Ordinary callers have no reset/increase operation. The fixed stage-only
 * recovery candidate is a separately approved, one-time additive allowance.
 * One corpus coordinator
 * serializes all callers; this local queue also serializes concurrent sends. */
export class DurableAttemptBudget {
  private tail: Promise<void> = Promise.resolve();
  private initialized: Promise<void> | null = null;
  constructor(private readonly storage: Pick<CoordinatorStorage, 'get' | 'put'> & Partial<Pick<CoordinatorStorage, 'getAlarm'>>,
    readonly control: PipelineControl | undefined, private readonly recovery?: StageRecoveryAuthorization) {}

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
  private checked(value: unknown, control = this.control, original = false): AttemptRecord {
    const record = value as AttemptRecord | undefined;
    if (!control || !record || record.format !== 1 || record.commit !== control.commit || record.date !== control.date ||
      record.parser !== control.parser || record.cap !== control.cap || !Number.isSafeInteger(record.submitted) ||
      record.submitted < 0 || record.submitted > record.cap) {
      throw new Error('persisted embedding budget identity/cap differs or is invalid; controls cannot be removed, changed, reset or increased on this coordinator');
    }
    const normalized: AttemptRecord = { format: 1, commit: record.commit, date: record.date, parser: record.parser,
      cap: record.cap, submitted: record.submitted };
    if (original) {
      if (record.recovery !== undefined) throw new Error('The original staging budget already has a recovery receipt.');
    } else if (this.recovery) {
      return { ...normalized, recovery: readRecoveryReceipt(record.recovery, record.submitted) };
    } else if (record.recovery !== undefined) {
      throw new Error('The compiled staging recovery authorization is required for this budget.');
    }
    return normalized;
  }
  initialize(): Promise<void> {
    this.initialized ??= this.exclusive(async () => {
      const existing = await this.storage.get<unknown>(ATTEMPT_BUDGET_KEY);
      if (this.recovery) {
        const control = this.control;
        if (this.recovery.coordinatorId !== recoveryPlan.coordinatorId ||
            !['extend', 'verify'].includes(this.recovery.mode) || !control ||
            control.commit !== recoveryPlan.commit || control.date !== recoveryPlan.date ||
            control.parser !== recoveryPlan.parser || control.cap !== recoveryPlan.totalCap) {
          throw new Error('The exact compiled staging recovery identity and controls are required.');
        }
        // No absent record is ever initialized through this authorization path.
        const old = existing as AttemptRecord | undefined;
        if (old?.cap === recoveryPlan.originalCap) {
          const prior = this.checked(existing, { ...control, cap: recoveryPlan.originalCap }, true);
          if (this.recovery.mode !== 'extend' || prior.submitted !== recoveryPlan.originalSubmitted) {
            throw new Error('The exact exhausted original staging budget is required.');
          }
          const admission = await this.storage.get<unknown>(COORDINATOR_ADMISSION_KEY);
          if (!admission || typeof admission !== 'object' || Array.isArray(admission) ||
              !('format' in admission) || admission.format !== 1 ||
              !('revision' in admission) || admission.revision !== recoveryPlan.initialAdmissionRevision ||
              !('suspended' in admission) || admission.suspended !== true || !this.storage.getAlarm ||
              await this.storage.getAlarm() !== null) {
            throw new Error('The exact paused staging admission with no alarm is required.');
          }
          // One key write atomically retains spent attempts and records the
          // fixed allowance/call ceiling. The coordinator constructor barrier
          // and this queue exclude concurrent admission/reservation here.
          await this.storage.put(ATTEMPT_BUDGET_KEY, { ...prior, cap: recoveryPlan.totalCap,
            recovery: { plan: recoveryPlan, planSha256: STAGE_RECOVERY_PLAN_SHA256, reservedCalls: 0 } });
        } else this.checked(existing);
        return;
      }
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
    if (this.recovery && manifest.index.digest !== recoveryPlan.indexDigest) throw new Error('The exact staging recovery snapshot index is required.');
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
      if (record.recovery && (count > recoveryPlan.maxDocumentsPerCall || record.recovery.reservedCalls >= recoveryPlan.maxCalls)) {
        throw new Error('The authorized staging recovery call or document-per-call ceiling is exhausted.');
      }
      await this.storage.put(ATTEMPT_BUDGET_KEY, { ...record, submitted: record.submitted + count,
        ...(record.recovery ? { recovery: { ...record.recovery, reservedCalls: record.recovery.reservedCalls + 1 } } : {}) });
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
