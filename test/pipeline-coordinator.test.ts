import { describe, expect, it } from 'vitest';
import { COORDINATOR_ADMISSION_KEY, DurableSingleFlight, type CoordinatorStorage, type CoordinatorStatus } from '../services/pipeline/single-flight';

function storage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const value: CoordinatorStorage = {
    async get<T>(key: string) { return data.get(key) as T | undefined; },
    async put(key, entry) { data.set(key, entry); },
    async delete(key) { return data.delete(key); },
    async getAlarm() { return alarm; },
    async setAlarm(time) { alarm = time; },
    async deleteAlarm() { alarm = null; },
  };
  return { value, data, alarm: () => alarm, consumeAlarm: () => { alarm = null; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('durable corpus single writer', () => {
  it('joins overlapping cron/manual calls across a long await and never grants an expiring lease', async () => {
    const s = storage();
    const job = deferred<{ remaining: boolean }>();
    let calls = 0;
    let now = 0;
    const runner = new DurableSingleFlight(s.value, async () => { calls++; return job.promise; }, () => now);
    const requests = Array.from({ length: 8 }, () => runner.run());
    await tick();
    expect(calls).toBe(1);
    now = 20 * 60_000; // waiting longer does not authorize a new writer
    s.consumeAlarm();
    await runner.alarm();
    expect(s.alarm()).toBe(now + 5 * 60_000);
    const more = runner.run();
    expect(calls).toBe(1);
    job.resolve({ remaining: false });
    expect(await Promise.all([...requests, more])).toEqual(Array(9).fill({ remaining: false }));
    expect(s.alarm()).toBeNull();
    expect(s.data.get('status')).toEqual({ pending: false, failures: 0 });
  });

  it('persists failure recovery and lets one alarm retry the interrupted unit', async () => {
    const s = storage();
    let calls = 0;
    const runner = new DurableSingleFlight(s.value, async () => {
      calls++;
      if (calls === 1) throw new Error('encoder unavailable');
      return { remaining: false };
    }, () => 1000);
    await expect(runner.run()).rejects.toThrow('encoder unavailable');
    expect(s.data.get('status')).toMatchObject({ pending: true, failures: 1, lastError: 'Error: encoder unavailable' });
    expect(s.alarm()).toBe(31_000);
    s.consumeAlarm();
    await runner.alarm();
    expect(calls).toBe(2);
    expect(s.alarm()).toBeNull();
  });

  it('restores a missing alarm for a pending checkpoint after object restart', async () => {
    const s = storage();
    await s.value.put('status', { pending: true, failures: 1 } satisfies CoordinatorStatus);
    let calls = 0;
    const restarted = new DurableSingleFlight(s.value, async () => { calls++; return { remaining: false }; }, () => 1000);
    await restarted.initialize();
    expect(s.alarm()).toBe(2000);
    s.consumeAlarm();
    await restarted.alarm();
    expect(calls).toBe(1);
    expect(s.data.get('status')).toEqual({ pending: false, failures: 0 });
  });

  it('continues bounded catch-up slices by alarm until the entire revision is complete', async () => {
    const s = storage();
    let calls = 0;
    const runner = new DurableSingleFlight(s.value, async () => ({ remaining: ++calls < 3 }), () => 1000);
    expect((await runner.run()).remaining).toBe(true);
    expect(s.alarm()).toBe(2000);
    s.consumeAlarm();
    await runner.alarm();
    expect(s.alarm()).toBe(2000);
    s.consumeAlarm();
    await runner.alarm();
    expect(calls).toBe(3);
    expect(s.alarm()).toBeNull();
  });
  it('serializes administrative vector reads with a long writer and releases the queue on failure', async () => {
    const s = storage();
    const job = deferred<{ remaining: boolean }>();
    const order: string[] = [];
    const runner = new DurableSingleFlight(s.value, async () => { order.push('write'); return job.promise; });
    const writing = runner.run();
    const reading = runner.exclusive(async () => { order.push('export'); throw new Error('read failed'); });
    const rejected = expect(reading).rejects.toThrow('read failed');
    await tick();
    expect(order).toEqual(['write']);
    job.resolve({ remaining: false });
    await writing; await rejected;
    expect(await runner.exclusive(async () => 'next')).toBe('next');
    expect(order).toEqual(['write', 'export']);
  });

});

describe('durable coordinator admission', () => {
  it('persists suspension promptly during external I/O, refuses new joins, and drains without a continuation alarm', async () => {
    const s = storage(), job = deferred<{ remaining: boolean }>();
    let calls = 0;
    const runner = new DurableSingleFlight(s.value, async () => { calls++; return job.promise; }, () => 1000);
    const running = runner.run(); await tick();
    expect(await runner.status()).toMatchObject({ active: 'ingest', queued: 0, pending: true, alarmAt: 301000 });
    expect(await runner.suspend(0)).toMatchObject({ revision: 1, suspended: true, active: 'ingest', alarmAt: null, quiescent: false });
    await expect(runner.run()).rejects.toMatchObject({ code: 'suspended' });
    await runner.alarm(); expect(calls).toBe(1);
    job.resolve({ remaining: true }); await running;
    expect(await runner.status()).toMatchObject({ revision: 1, suspended: true, pending: true, active: null, queued: 0, alarmHandlersActive: 0, alarmAt: null, quiescent: true });
    const restarted = new DurableSingleFlight(s.value, async () => { calls++; return { remaining: false }; }, () => 1000);
    await restarted.initialize(); await restarted.alarm();
    expect(calls).toBe(1); expect(s.alarm()).toBeNull();
    expect(await restarted.resume(1)).toMatchObject({ revision: 2, suspended: false, pending: true, alarmAt: 2000, quiescent: false });
    s.consumeAlarm(); await restarted.alarm();
    expect(calls).toBe(2); expect(s.data.get('status')).toEqual({ pending: false, failures: 0 });
  });

  it('preserves failed work and unrelated outbox/budget state while suppressing recovery after pause', async () => {
    const s = storage(), job = deferred<{ remaining: boolean }>();
    const budget = { submitted: 7, cap: 1112 }, outbox = { pending: ['committed-row-vector'] };
    s.data.set('embedding-attempt-budget-v1', budget); s.data.set('fixture-outbox', outbox);
    const runner = new DurableSingleFlight(s.value, () => job.promise);
    const running = runner.run(), failed = expect(running).rejects.toThrow('private-provider-error'); await tick();
    await runner.suspend(0); job.reject(new Error('private-provider-error')); await failed;
    expect(s.data.get('status')).toMatchObject({ pending: true, failures: 1 });
    expect(await runner.status()).toMatchObject({ suspended: true, failures: 1, alarmAt: null, quiescent: true });
    expect(JSON.stringify(await runner.status())).not.toContain('private-provider-error');
    expect(s.data.get('embedding-attempt-budget-v1')).toBe(budget); expect(s.data.get('fixture-outbox')).toBe(outbox);
  });

  it('rejects a previously queued writer at dequeue without manufacturing a pending checkpoint', async () => {
    const s = storage(), read = deferred<void>(); let writes = 0;
    const runner = new DurableSingleFlight(s.value, async () => { writes++; return { remaining: false }; });
    const exporting = runner.exclusive(() => read.promise); await tick();
    const writing = runner.run(), rejected = expect(writing).rejects.toMatchObject({ code: 'suspended' }); await tick();
    expect(await runner.suspend(0)).toMatchObject({ active: 'vector-export', queued: 1, pending: false, quiescent: false });
    read.resolve(); await exporting; await rejected;
    expect(writes).toBe(0); expect(s.data.has('status')).toBe(false);
    expect(await runner.status()).toMatchObject({ queued: 0, active: null, pending: false, quiescent: true });
  });

  it('keeps ordinary export compatibility but requires the exact drained suspension for backup reads', async () => {
    const s = storage(), read = deferred<string>();
    const runner = new DurableSingleFlight(s.value, async () => ({ remaining: false }));
    expect(await runner.exclusive(async () => 'ordinary')).toBe('ordinary');
    await expect(runner.exclusive(async () => 'invalid claim', 0)).rejects.toMatchObject({ code: 'stale-revision' });
    await runner.suspend(0);
    await expect(runner.exclusive(async () => 'missing revision')).rejects.toMatchObject({ code: 'suspended' });
    await expect(runner.exclusive(async () => 'stale revision', 0)).rejects.toMatchObject({ code: 'stale-revision' });
    const exporting = runner.exclusive(() => read.promise, 1); await tick();
    await expect(runner.exclusive(async () => 'overlapping backup', 1)).rejects.toMatchObject({ code: 'busy' });
    await expect(runner.resume(1)).rejects.toMatchObject({ code: 'busy' });
    expect(await runner.status()).toMatchObject({ active: 'vector-export', quiescent: false });
    read.resolve('immutable receipt'); expect(await exporting).toBe('immutable receipt');
    expect(await runner.resume(1)).toMatchObject({ revision: 2, suspended: false, alarmAt: null });
    await expect(runner.exclusive(async () => 'old revision', 1)).rejects.toMatchObject({ code: 'stale-revision' });
    expect(await runner.exclusive(async () => 'ordinary again')).toBe('ordinary again');
  });

  it('uses monotonic revisions for competing controls and lost-response replay', async () => {
    const s = storage(), runner = new DurableSingleFlight(s.value, async () => ({ remaining: false }));
    const competing = await Promise.allSettled([runner.suspend(0), runner.suspend(0)]);
    expect(competing.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(competing.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(await runner.suspend(1)).toMatchObject({ revision: 1, suspended: true });
    await runner.resume(1); await runner.suspend(2);
    await expect(runner.resume(1)).rejects.toMatchObject({ code: 'stale-revision' });
    await expect(runner.suspend(0)).rejects.toMatchObject({ code: 'stale-revision' });
    expect(await runner.status()).toMatchObject({ revision: 3, suspended: true, quiescent: true });
  });

  it('remains fail-closed if alarm deletion fails after suspension has committed', async () => {
    const s = storage(); s.data.set('status', { pending: true, failures: 2 });
    const original = s.value.deleteAlarm; let fail = true;
    s.value.deleteAlarm = async () => { if (fail) throw new Error('uncertain alarm deletion'); return original(); };
    let calls = 0;
    const runner = new DurableSingleFlight(s.value, async () => { calls++; return { remaining: false }; }, () => 1000);
    await expect(runner.suspend(0)).rejects.toThrow('uncertain alarm deletion');
    expect(s.data.get(COORDINATOR_ADMISSION_KEY)).toEqual({ format: 1, revision: 1, suspended: true });
    await expect(runner.run()).rejects.toMatchObject({ code: 'suspended' });
    expect(await runner.status()).toMatchObject({ suspended: true, pending: true, failures: 2, alarmAt: 2000, quiescent: false });
    fail = false;
    expect(await runner.suspend(1)).toMatchObject({ revision: 1, quiescent: true, alarmAt: null });
    expect(calls).toBe(0); expect(s.data.get('status')).toEqual({ pending: true, failures: 2 });
  });

  it('serializes a completion rearm already in progress before acknowledging suspension', async () => {
    const s = storage(), job = deferred<{ remaining: boolean }>(), arming = deferred<void>(), finishArm = deferred<void>();
    const set = s.value.setAlarm; let sets = 0;
    s.value.setAlarm = async (time) => { if (++sets === 2) { arming.resolve(); await finishArm.promise; } await set(time); };
    const runner = new DurableSingleFlight(s.value, () => job.promise, () => 1000);
    const running = runner.run(); await tick(); job.resolve({ remaining: true }); await arming.promise;
    const pausing = runner.suspend(0); finishArm.resolve();
    await running; expect(await pausing).toMatchObject({ suspended: true, alarmAt: null });
    expect(await runner.status()).toMatchObject({ quiescent: true, alarmAt: null, pending: true });
    expect(sets).toBe(2);
  });

  it('does not confuse an executing alarm with its consumed alarm timestamp', async () => {
    const s = storage(), job = deferred<{ remaining: boolean }>();
    s.data.set('status', { pending: true, failures: 0 });
    const runner = new DurableSingleFlight(s.value, () => job.promise);
    const alarming = runner.alarm(); await tick(); await runner.suspend(0);
    expect(await runner.status()).toMatchObject({ alarmAt: null, active: 'ingest', alarmHandlersActive: 1, quiescent: false });
    job.resolve({ remaining: false }); await alarming;
    expect(await runner.status()).toMatchObject({ alarmAt: null, alarmHandlersActive: 0, quiescent: true });
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid control revision %s without writes', async (revision) => {
    const s = storage(), runner = new DurableSingleFlight(s.value, async () => ({ remaining: false }));
    await expect(runner.suspend(revision)).rejects.toMatchObject({ code: 'invalid-control', status: 400 });
    await expect(runner.resume(revision)).rejects.toMatchObject({ code: 'invalid-control' });
    expect(s.data.size).toBe(0); expect(s.alarm()).toBeNull();
  });

  it('refuses corrupt persisted admission state without overwriting checkpoints', async () => {
    const s = storage(); s.data.set(COORDINATOR_ADMISSION_KEY, { format: 1, revision: 0, suspended: false });
    s.data.set('status', { pending: true, failures: 4 }); let calls = 0;
    const runner = new DurableSingleFlight(s.value, async () => { calls++; return { remaining: false }; });
    await expect(runner.run()).rejects.toThrow('Invalid persisted coordinator admission state');
    expect(calls).toBe(0); expect(s.alarm()).toBeNull(); expect(s.data.get('status')).toEqual({ pending: true, failures: 4 });
  });
});

describe('fail-closed legacy checkpoint validation', () => {
  const invalid = [null, [], 'PRIVATE', true, {}, { pending: 1, failures: 0 },
    { pending: true }, { pending: true, failures: { PRIVATE: 'credential' } },
    ...['2', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(failures => ({ pending: true, failures })),
    ...[null, {}, 1, 'PRIVATE'.repeat(72)].map(lastError => ({ pending: true, failures: 1, lastError }))];
  it.each(invalid.map((value, index) => ({ value, index })))('rejects malformed persisted checkpoint case $index before use or mutation', async ({ value }) => {
    for (const suspended of [false, true]) {
      const s = storage(); let calls = 0;
      s.data.set('status', value);
      s.data.set(COORDINATOR_ADMISSION_KEY, { format: 1, revision: 1, suspended });
      s.data.set('embedding-attempt-budget-v1', { submitted: 784, cap: 1112 });
      const before = [...s.data];
      const runner = new DurableSingleFlight(s.value, async () => { calls++; return { remaining: false }; });
      const operations = [() => runner.initialize(), () => runner.status(), () => runner.run(),
        () => runner.exclusive(async () => { calls++; }), () => runner.exclusive(async () => { calls++; }, 1),
        () => runner.suspend(1), () => runner.resume(1), () => runner.alarm()];
      for (const operation of operations) {
        await expect(operation()).rejects.toThrow('Invalid persisted coordinator checkpoint.');
      }
      expect([...s.data]).toEqual(before); expect(s.alarm()).toBeNull(); expect(calls).toBe(0);
    }
  });

  it.each(['status', 'run', 'export', 'backup', 'suspend', 'resume', 'alarm'])('validates %s even after initialization has been cached', async operation => {
    const s = storage(); let calls = 0;
    const runner = new DurableSingleFlight(s.value, async () => { calls++; return { remaining: false }; });
    await runner.initialize();
    const suspended = ['backup', 'resume', 'alarm'].includes(operation);
    s.data.set(COORDINATOR_ADMISSION_KEY, { format: 1, revision: 1, suspended });
    s.data.set('status', { pending: true, failures: { PRIVATE: 'credential' } });
    await s.value.setAlarm(1234); const before = [...s.data];
    const work = async () => { calls++; };
    const action = operation === 'status' ? runner.status() : operation === 'run' ? runner.run() :
      operation === 'export' ? runner.exclusive(work) : operation === 'backup' ? runner.exclusive(work, 1) :
      operation === 'suspend' ? runner.suspend(1) : operation === 'resume' ? runner.resume(1) : runner.alarm();
    await expect(action).rejects.toThrow('Invalid persisted coordinator checkpoint.');
    expect([...s.data]).toEqual(before); expect(s.alarm()).toBe(1234); expect(calls).toBe(0);
  });

  it('normalizes safe legacy fields without exposing extra properties, and saturates a safe failure count', async () => {
    const s = storage();
    s.data.set('status', { pending: true, failures: Number.MAX_SAFE_INTEGER, lastError: 'Error: private', extra: { PRIVATE: 'secret' } });
    const runner = new DurableSingleFlight(s.value, async () => { throw Error('next failure'); }, () => 1000);
    expect(await runner.status()).toMatchObject({ failures: Number.MAX_SAFE_INTEGER, lastFailure: { classification: 'unknown' } });
    expect(JSON.stringify(await runner.status())).not.toMatch(/PRIVATE|private|lastError|extra/);
    await expect(runner.run()).rejects.toThrow('next failure');
    expect(s.data.get('status')).toEqual({ pending: true, failures: Number.MAX_SAFE_INTEGER, lastError: 'Error: next failure' });
    expect(s.alarm()).toBe(3_601_000);
  });
});

describe('resume recovery write ordering', () => {
  it.each([
    { operation: 'alarm', committed: false }, { operation: 'alarm', committed: true },
    { operation: 'admission', committed: false }, { operation: 'admission', committed: true },
  ])('recovers $operation failure committed=$committed without losing pending work or overwriting revisions', async ({ operation, committed }) => {
    const s = storage(); let calls = 0;
    const checkpoint = { pending: true, failures: 2, lastError: 'Error: retained failure' };
    s.data.set('status', checkpoint); s.data.set('embedding-attempt-budget-v1', { submitted: 784, cap: 1112 });
    s.data.set('fixture-outbox', { payload: 'pending-vector' });
    const runner = new DurableSingleFlight(s.value, async () => { calls++; return { remaining: false }; }, () => 1000);
    await runner.suspend(0);
    const setAlarm = s.value.setAlarm, put = s.value.put;
    let fail = true;
    s.value.setAlarm = async time => {
      expect(s.data.get(COORDINATOR_ADMISSION_KEY)).toEqual({ format: 1, revision: 1, suspended: true });
      if (operation === 'alarm' && fail) {
        fail = false; if (committed) await setAlarm(time); throw Error('uncertain alarm acknowledgement');
      }
      await setAlarm(time);
    };
    s.value.put = async (key, value) => {
      if (key === COORDINATOR_ADMISSION_KEY && operation === 'admission' && fail) {
        fail = false; if (committed) await put(key, value); throw Error('uncertain admission acknowledgement');
      }
      await put(key, value);
    };
    await expect(runner.resume(1)).rejects.toThrow('uncertain');
    expect(s.data.get('status')).toBe(checkpoint); expect(calls).toBe(0);
    const open = operation === 'admission' && committed;
    const observed = await runner.status();
    expect(observed).toMatchObject({ revision: open ? 2 : 1, suspended: !open, pending: true, failures: 2,
      alarmAt: operation === 'alarm' && !committed ? null : 2000 });
    expect(!(observed.suspended === false && observed.pending && observed.alarmAt === null)).toBe(true);
    if (open) {
      await expect(runner.resume(1)).rejects.toMatchObject({ code: 'stale-revision' });
      await expect(runner.suspend(1)).rejects.toMatchObject({ code: 'stale-revision' });
    } else {
      if (s.alarm() !== null) await expect(runner.resume(1)).rejects.toMatchObject({ code: 'busy' });
      // Explicit recovery: observe, reassert the same suspension to remove any
      // uncertain alarm, then resume that exact current revision. No reset.
      expect(await runner.suspend(observed.revision)).toMatchObject({ revision: 1, quiescent: true, alarmAt: null });
      expect(await runner.resume(1)).toMatchObject({ revision: 2, suspended: false, alarmAt: 2000 });
    }
    s.value.setAlarm = setAlarm; // The normal cycle may now arm its watchdog.
    s.consumeAlarm(); await runner.alarm();
    expect(calls).toBe(1); expect(s.data.get('status')).toEqual({ pending: false, failures: 0 });
    expect(s.data.get('embedding-attempt-budget-v1')).toEqual({ submitted: 784, cap: 1112 });
    expect(s.data.get('fixture-outbox')).toEqual({ payload: 'pending-vector' });
  });

  it.each([false, true])('serializes a delivered alarm against an uncertain admission write committed=%s', async committed => {
    const s = storage(), writing = deferred<void>(), release = deferred<void>(); let calls = 0;
    s.data.set('status', { pending: true, failures: 2 });
    const runner = new DurableSingleFlight(s.value, async () => { calls++; return { remaining: false }; }, () => 1000);
    await runner.suspend(0);
    const put = s.value.put;
    s.value.put = async (key, value) => {
      if (key === COORDINATOR_ADMISSION_KEY) {
        writing.resolve(); await release.promise;
        if (committed) await put(key, value);
        throw Error('uncertain admission write');
      }
      await put(key, value);
    };
    const resuming = runner.resume(1), failed = expect(resuming).rejects.toThrow('uncertain admission write');
    await writing.promise; expect(s.alarm()).toBe(2000); s.consumeAlarm();
    const delivered = runner.alarm(); await tick(); expect(calls).toBe(0);
    release.resolve(); await failed; await delivered;
    expect(await runner.status()).toMatchObject({ revision: committed ? 2 : 1, suspended: !committed, alarmHandlersActive: 0 });
    expect(calls).toBe(committed ? 1 : 0);
    if (!committed) {
      expect(s.data.get('status')).toEqual({ pending: true, failures: 2 });
      expect(s.alarm()).toBeNull();
    }
  });
});

describe('privacy-safe persisted failure observations', () => {
  it('classifies a swallowed alarm failure from persisted state without mutating it on read', async () => {
    const s = storage(); s.data.set('status', { pending: true, failures: 0 });
    const marker = 'PRIVATE-CREDENTIAL-and-provision-text';
    const runner = new DurableSingleFlight(s.value, async () => {
      throw new Error(`the encoder returned 503 at https://user:${marker}@encoder.invalid/embed: authorization=${marker}`);
    }, () => 1000);
    await runner.alarm();
    const saved = JSON.stringify([...s.data]), alarmAt = s.alarm();
    const first = await runner.status(), second = await runner.status();
    expect(first).toMatchObject({ pending: true, failures: 1, lastFailure: { classification: 'encoder-http', encoderHttpStatus: 503 } });
    expect(second).toEqual(first); expect(JSON.stringify([...s.data])).toBe(saved); expect(s.alarm()).toBe(alarmAt);
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE|authorization|https:|encoder\.invalid|lastError/);
    expect(s.data.get('status')).toMatchObject({ lastError: expect.stringContaining(marker) });
  });

  it('keeps the last failure visible during its next retry and clears the diagnostic only after success', async () => {
    const s = storage(), job = deferred<{ remaining: boolean }>(); let calls = 0;
    s.data.set('status', { pending: true, failures: 0 });
    const runner = new DurableSingleFlight(s.value, async () => {
      if (++calls === 1) throw new Error('the encoder returned 503 at https://encoder/embed: PRIVATE retry detail');
      return job.promise;
    });
    await runner.alarm();
    const lastError = (s.data.get('status') as CoordinatorStatus).lastError;
    const retrying = runner.run(); await tick();
    expect(await runner.status()).toMatchObject({ active: 'ingest', failures: 1,
      lastFailure: { classification: 'encoder-http', encoderHttpStatus: 503 } });
    expect((s.data.get('status') as CoordinatorStatus).lastError).toBe(lastError);
    job.resolve({ remaining: false }); await retrying;
    expect(await runner.status()).toMatchObject({ failures: 0, lastFailure: null });
    expect(s.data.get('status')).toEqual({ pending: false, failures: 0 });
  });

  it.each([
    ['Error: the encoder returned 500 at https://encoder/embed: {"error":"the encoder failed: DEADLINE_EXCEEDED: PRIVATE token"}', { classification: 'encoder-deadline', encoderHttpStatus: 500 }],
    ['Error: the encoder returned 504 at https://encoder/embed: upstream timeout DEADLINE_EXCEEDED PRIVATE', { classification: 'encoder-http', encoderHttpStatus: 504 }],
    ['Error: the encoder returned 500 at https://encoder/embed: {"error":"the encoder failed: DEADLINE_EXCEEDED: truncated PRIVATE', { classification: 'encoder-http', encoderHttpStatus: 500 }],
    ['Error: embedding attempt budget exhausted: 1112/1112 submitted, 32 requested', { classification: 'attempt-budget-exhausted' }],
    ['Error: upstream source head differs from the controlled pipeline commit/date pin', { classification: 'source-snapshot-mismatch' }],
    ['Error: controlled pipeline requires the matching immutable snapshot commit/date/parser and index identity', { classification: 'source-snapshot-mismatch' }],
    ['Error: snapshot index SHA-256 mismatch', { classification: 'source-snapshot-mismatch' }],
    ['Error: snapshot row identity or fingerprint mismatch: acts-en-private-row', { classification: 'source-snapshot-mismatch' }],
    ['Error: D1_ERROR: SQLITE_NOMEM while processing PRIVATE SQL and credentials', { classification: 'storage' }],
    ['Error: SQLITE_BUSY: PRIVATE SQL body', { classification: 'storage' }],
    ['Error: the corpus repository returned 503', { classification: 'unknown' }],
    ['Error: timeout while fetching PRIVATE source', { classification: 'unknown' }],
    ['TypeError: fetch failed with PRIVATE token', { classification: 'unknown' }],
    ['Error: PRIVATE text mentions D1_ERROR: the encoder returned 503', { classification: 'unknown' }],
    ['Error: the encoder returned 999 at https://encoder/embed: PRIVATE', { classification: 'unknown' }],
  ])('returns only allowlisted metadata for %s', async (lastError, diagnostic) => {
    const s = storage(); s.data.set('status', { pending: true, failures: 2, lastError });
    const runner = new DurableSingleFlight(s.value, async () => ({ remaining: false }));
    const status = await runner.status();
    expect(status.lastFailure).toEqual(diagnostic);
    expect(JSON.stringify(status)).not.toMatch(/PRIVATE|https:|lastError|private-row|SQL body/);
    expect(s.data.get('status')).toEqual({ pending: true, failures: 2, lastError });
  });

  it('reports no current failure after success even if old error text remains, and keeps missing signatures unknown', async () => {
    const s = storage(); s.data.set('status', { pending: false, failures: 0, lastError: 'Error: D1_ERROR: PRIVATE stale text' });
    const runner = new DurableSingleFlight(s.value, async () => ({ remaining: false }));
    expect((await runner.status()).lastFailure).toBeNull();
    s.data.set('status', { pending: true, failures: 1 });
    expect((await runner.status()).lastFailure).toEqual({ classification: 'unknown' });
    expect(s.data.get('status')).toEqual({ pending: true, failures: 1 });
  });
});
