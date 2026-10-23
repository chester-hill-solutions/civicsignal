/** The durable checkpoint used by the pipeline coordinator. Unlike a lease,
 * this never grants a second writer because elapsed time passed. The runtime
 * owns one object instance; its alarm resumes pending work after a restart. */
export interface CoordinatorStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
export interface CoordinatorStatus {
  pending: boolean;
  failures: number;
  lastError?: string;
}
export const COORDINATOR_ADMISSION_KEY = 'coordinator-admission-v1';
interface Admission { format: 1; revision: number; suspended: boolean }
export interface CoordinatorFailure {
  classification: 'encoder-http' | 'encoder-deadline' | 'attempt-budget-exhausted' | 'source-snapshot-mismatch' | 'storage' | 'unknown';
  encoderHttpStatus?: number;
}
/** Classify only known persisted signatures. Never return exception fragments,
 * addresses, response bodies, headers or credentials as diagnostic metadata. */
function lastFailure(checkpoint: CoordinatorStatus): CoordinatorFailure | null {
  if (checkpoint.failures === 0) return null;
  const message = typeof checkpoint.lastError === 'string' ? checkpoint.lastError.slice(0, 500) : '';
  const encoder = /^Error: the encoder returned ([3-5]\d{2}) at https?:\/\/[^\s]+: /.exec(message);
  if (encoder) {
    const encoderHttpStatus = Number(encoder[1]);
    // The encoder server emits this JSON error wrapper for model failures.
    // A gateway 504 or an unrelated timeout alone does not establish its cause.
    try {
      const body: unknown = JSON.parse(message.slice(encoder[0].length));
      if (body && typeof body === 'object' && !Array.isArray(body) && 'error' in body && typeof body.error === 'string' &&
          body.error.startsWith('the encoder failed: ') && /\bDEADLINE_EXCEEDED\b/.test(body.error)) {
        return { classification: 'encoder-deadline', encoderHttpStatus };
      }
    } catch { /* A truncated or unrecognized body remains only an HTTP failure. */ }
    return { classification: 'encoder-http', encoderHttpStatus };
  }
  if (/^Error: embedding attempt budget exhausted: \d+\/\d+ submitted, \d+ requested$/.test(message)) {
    return { classification: 'attempt-budget-exhausted' };
  }
  const mismatches = [
    'upstream source head differs from the controlled pipeline commit/date pin',
    'controlled pipeline requires the matching immutable snapshot commit/date/parser and index identity',
    'snapshot manifest revision or parser mismatch', 'snapshot index byte count mismatch',
    'snapshot index SHA-256 mismatch', 'snapshot index count mismatch', 'snapshot index fingerprint digest mismatch',
    'snapshot index order, fingerprint or offset is invalid',
  ];
  if (mismatches.some(signature => message === `Error: ${signature}`) ||
      /^Error: snapshot row (?:identity or fingerprint|date, corpus or language) mismatch: [A-Za-z0-9._-]+$/.test(message)) {
    return { classification: 'source-snapshot-mismatch' };
  }
  if (/^Error: D1_(?:ERROR|EXEC_ERROR): /.test(message) ||
      /^Error: SQLITE_(?:ERROR|BUSY|FULL|IOERR|NOMEM|CONSTRAINT|READONLY|CORRUPT)(?::|$)/.test(message)) {
    return { classification: 'storage' };
  }
  return { classification: 'unknown' };
}
export interface CoordinatorObservation {
  format: 1;
  revision: number;
  suspended: boolean;
  active: 'ingest' | 'vector-export' | null;
  queued: number;
  alarmHandlersActive: number;
  alarmAt: number | null;
  pending: boolean;
  failures: number;
  lastFailure: CoordinatorFailure | null;
  quiescent: boolean;
}
export class CoordinatorAdmissionError extends Error {
  constructor(readonly code: 'suspended' | 'stale-revision' | 'busy' | 'invalid-control', message: string,
    readonly status: 400 | 409 = 409) { super(message); this.name = 'CoordinatorAdmissionError'; }
}
function validRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new CoordinatorAdmissionError('invalid-control', 'A non-negative safe integer revision is required.', 400);
}
export class DurableSingleFlight<T extends { remaining?: boolean }> {
  private running: Promise<T> | null = null;
  private initialized: Promise<void> | null = null;
  private exclusiveTail: Promise<void> = Promise.resolve();
  private controlTail: Promise<void> = Promise.resolve();
  private active: CoordinatorObservation['active'] = null;
  private queued = 0;
  private alarmHandlersActive = 0;
  private failurePauseUncertain = false;
  constructor(private readonly storage: CoordinatorStorage, private readonly work: () => Promise<T>,
    private readonly now: () => number = Date.now, private readonly options: { suspendOnFailure?: boolean } = {}) {}

  initialize(): Promise<void> {
    this.initialized ??= this.control(async () => {
      const admission = await this.admission();
      const checkpoint = await this.checkpoint();
      // A persisted pause takes precedence over recovery, including after eviction.
      if (!admission.suspended && checkpoint.pending && await this.storage.getAlarm() === null) {
        try { await this.storage.setAlarm(this.now() + 1000); }
        catch (error) {
          if (this.options.suspendOnFailure) { await this.closeAfterFailure(); await this.storage.deleteAlarm(); }
          throw error;
        }
      }
    });
    return this.initialized;
  }

  async run(): Promise<T> {
    await this.initialize();
    const { task } = await this.control(async () => {
      await this.checkpoint();
      this.assertRunning(await this.admission());
      if (!this.running) this.running = this.enqueue('ingest', () => this.execute());
      // Wrap the Promise: the short control lock must never await external work.
      return { task: this.running };
    });
    try { return await task; }
    finally { if (this.running === task) this.running = null; }
  }

  /** Administrative vector reads share the writer queue. A request lost on
   * restart is retried by its caller; immutable artifacts make that safe.
   * Normal exports remain compatible. A paused backup read requires the exact
   * suspension revision and an idle queue; this does not attest backup parity. */
  async exclusive<R>(work: () => Promise<R>, suspensionRevision?: number): Promise<R> {
    if (suspensionRevision !== undefined) validRevision(suspensionRevision);
    await this.initialize();
    const { task } = await this.control(async () => {
      await this.assertExport(await this.admission(), suspensionRevision, 0);
      return { task: this.enqueue('vector-export', work, suspensionRevision) };
    });
    return task;
  }

  private async control<R>(work: () => Promise<R>): Promise<R> {
    const previous = this.controlTail;
    let release!: () => void;
    this.controlTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }

  private async admission(): Promise<Admission> {
    const value = await this.storage.get<unknown>(COORDINATOR_ADMISSION_KEY);
    if (value === undefined) return { format: 1, revision: 0, suspended: false };
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('format' in value) || value.format !== 1 ||
        !('suspended' in value) || typeof value.suspended !== 'boolean' || !('revision' in value) ||
        typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1) {
      throw new Error('Invalid persisted coordinator admission state.');
    }
    return { format: 1, revision: value.revision, suspended: value.suspended };
  }

  private async checkpoint(): Promise<CoordinatorStatus> {
    const value = await this.storage.get<unknown>('status');
    if (value === undefined) return { pending: false, failures: 0 };
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !('pending' in value) || typeof value.pending !== 'boolean' ||
        !('failures' in value) || typeof value.failures !== 'number' || !Number.isSafeInteger(value.failures) || value.failures < 0 ||
        ('lastError' in value && value.lastError !== undefined && (typeof value.lastError !== 'string' || value.lastError.length > 500))) {
      // Do not repair or stringify untrusted legacy state. The original value
      // remains available for separate, explicitly reviewed storage recovery.
      throw new Error('Invalid persisted coordinator checkpoint.');
    }
    return { pending: value.pending, failures: value.failures,
      ...('lastError' in value && typeof value.lastError === 'string' ? { lastError: value.lastError } : {}) };
  }

  private assertRunning(admission: Admission): void {
    if (admission.suspended || this.failurePauseUncertain) throw new CoordinatorAdmissionError('suspended', 'The pipeline coordinator is suspended.');
  }

  private async closeAfterFailure(): Promise<void> {
    this.failurePauseUncertain = true;
    const admission = await this.admission();
    if (!admission.suspended) await this.storage.put(COORDINATOR_ADMISSION_KEY, this.nextAdmission(admission, true));
    this.failurePauseUncertain = false;
  }

  private async assertExport(admission: Admission, revision: number | undefined, ownQueued: number): Promise<void> {
    await this.checkpoint();
    if (revision === undefined) { this.assertRunning(admission); return; }
    if (!admission.suspended || admission.revision !== revision) throw new CoordinatorAdmissionError('stale-revision', 'The current suspension revision is required.');
    if (this.active !== null || this.queued !== ownQueued || this.alarmHandlersActive !== 0 || await this.storage.getAlarm() !== null) {
      throw new CoordinatorAdmissionError('busy', 'The suspended coordinator must be drained before a backup export.');
    }
  }

  private enqueue<R>(kind: NonNullable<CoordinatorObservation['active']>, work: () => Promise<R>, revision?: number): Promise<R> {
    const previous = this.exclusiveTail;
    let release!: () => void;
    this.exclusiveTail = new Promise<void>((resolve) => { release = resolve; });
    this.queued++;
    return (async () => {
      let admitted = false;
      try {
        await previous;
        await this.control(async () => {
          const admission = await this.admission();
          if (kind === 'ingest') { await this.checkpoint(); this.assertRunning(admission); }
          else await this.assertExport(admission, revision, 1);
          this.queued--; admitted = true; this.active = kind;
        });
        return await work();
      } finally {
        await this.control(async () => {
          if (admitted) this.active = null;
          else this.queued--;
        });
        release();
      }
    })();
  }

  private async observation(admission: Admission): Promise<CoordinatorObservation> {
    const checkpoint = await this.checkpoint();
    const alarmAt = await this.storage.getAlarm();
    return { format: 1, revision: admission.revision, suspended: admission.suspended,
      active: this.active, queued: this.queued, alarmHandlersActive: this.alarmHandlersActive,
      alarmAt, pending: checkpoint.pending, failures: checkpoint.failures, lastFailure: lastFailure(checkpoint),
      quiescent: admission.suspended && this.active === null && this.queued === 0 && this.alarmHandlersActive === 0 && alarmAt === null };
  }

  async status(): Promise<CoordinatorObservation> {
    await this.initialize();
    return this.control(async () => this.observation(await this.admission()));
  }

  async suspend(expectedRevision: number): Promise<CoordinatorObservation> {
    validRevision(expectedRevision); await this.initialize();
    return this.control(async () => {
      let admission = await this.admission();
      await this.checkpoint();
      this.matchRevision(admission, expectedRevision);
      if (!admission.suspended) {
        admission = this.nextAdmission(admission, true);
        // Persist first. If deleting the alarm fails, the durable gate still
        // rejects work. The caller must not treat the failed response as idle.
        await this.storage.put(COORDINATOR_ADMISSION_KEY, admission);
      }
      await this.storage.deleteAlarm();
      this.failurePauseUncertain = false;
      return this.observation(admission);
    });
  }

  async resume(expectedRevision: number): Promise<CoordinatorObservation> {
    validRevision(expectedRevision); await this.initialize();
    return this.control(async () => {
      await this.checkpoint();
      const admission = await this.admission();
      this.matchRevision(admission, expectedRevision);
      if (!admission.suspended) throw new CoordinatorAdmissionError('stale-revision', 'The coordinator is not suspended.');
      if (!(await this.observation(admission)).quiescent) throw new CoordinatorAdmissionError('busy', 'The suspended coordinator is still draining.');
      const next = this.nextAdmission(admission, false);
      // Arm recovery while admission is still durably closed. A failed or
      // uncertain alarm write can leave only a paused gate, never open pending
      // work without recovery. Delivered alarms wait on this same control lock.
      if ((await this.checkpoint()).pending) await this.storage.setAlarm(this.now() + 1000);
      await this.storage.put(COORDINATOR_ADMISSION_KEY, next);
      this.failurePauseUncertain = false;
      return this.observation(next);
    });
  }

  private matchRevision(admission: Admission, expected: number): void {
    if (admission.revision !== expected) throw new CoordinatorAdmissionError('stale-revision', 'The coordinator admission revision changed.');
  }
  private nextAdmission(admission: Admission, suspended: boolean): Admission {
    if (admission.revision === Number.MAX_SAFE_INTEGER) throw new Error('Coordinator admission revision exhausted.');
    return { format: 1, revision: admission.revision + 1, suspended };
  }

  private async execute(): Promise<T> {
    let previous: CoordinatorStatus | undefined;
    let prepared = false;
    try {
      previous = await this.control(async () => {
        const state = await this.checkpoint();
        previous = state; // Keep the safe prior checkpoint if a setup write fails.
        await this.storage.put('status', { pending: true, failures: state.failures,
          ...(state.failures > 0 && typeof state.lastError === 'string' ? { lastError: state.lastError.slice(0, 500) } : {}) });
        // Admission may have closed after dequeue. Already admitted work drains,
        // but every alarm change still observes the persistent gate.
        if (!(await this.admission()).suspended) await this.storage.setAlarm(this.now() + 5 * 60_000);
        return state;
      });
      prepared = true;
      const result = await this.work();
      await this.control(async () => {
        await this.storage.put('status', { pending: !!result.remaining, failures: 0 });
        if (result.remaining && !(await this.admission()).suspended) await this.storage.setAlarm(this.now() + 1000);
        else await this.storage.deleteAlarm();
      });
      return result;
    } catch (error) {
      if (!prepared && !this.options.suspendOnFailure) throw error;
      await this.control(async () => {
        if (this.options.suspendOnFailure) {
          // Close admission before diagnostic/checkpoint writes or retry-alarm
          // handling. A later storage failure must not undo a successful pause.
          // If this put is uncertain, this instance also refuses further work;
          // reconstruction can rely only on what actually persisted.
          await this.closeAfterFailure();
        }
        // A malformed checkpoint was never admitted as diagnostic input and
        // must remain untouched for separate storage recovery.
        const failures = Math.min(Number.MAX_SAFE_INTEGER, (previous?.failures ?? 0) + 1);
        if (previous) await this.storage.put('status', { pending: true, failures, lastError: String(error).slice(0, 500) });
        if (!(await this.admission()).suspended) await this.storage.setAlarm(this.now() + Math.min(60 * 60_000, 30_000 * 2 ** Math.min(failures - 1, 7)));
        else await this.storage.deleteAlarm();
      });
      throw error;
    }
  }

  async alarm(): Promise<void> {
    this.alarmHandlersActive++;
    try {
      await this.initialize();
      const start = await this.control(async () => {
        const checkpoint = await this.checkpoint();
        if ((await this.admission()).suspended || this.failurePauseUncertain) { await this.storage.deleteAlarm(); return false; }
        if (!checkpoint.pending) return false;
        if (this.running) {
          await this.storage.setAlarm(this.now() + 5 * 60_000);
          return false;
        }
        return true;
      });
      if (start) {
        try { await this.run(); }
        catch { /* Recovery was persisted, or admission closed before run. */ }
      }
    } finally { this.alarmHandlersActive--; }
  }
}
