import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ATTEMPT_BUDGET_KEY, DurableAttemptBudget } from '../services/pipeline/attempt-budget';
import { COORDINATOR_ADMISSION_KEY, DurableSingleFlight, type CoordinatorStorage } from '../services/pipeline/single-flight';
import { STAGE_RECOVERY_PLAN as plan, STAGE_RECOVERY_PLAN_SHA256 as planSha256 } from '../services/pipeline/staging-recovery-plan';
import type { SnapshotManifest } from '../src/ingest/snapshot-format';

const original = () => ({ format: 1, commit: plan.commit, date: plan.date, parser: plan.parser, cap: 1112, submitted: 1112 });
const control = () => ({ commit: plan.commit, date: plan.date, parser: plan.parser, cap: 1752 });
const snapshot = async (): Promise<SnapshotManifest> => ({ format: 1, commit: plan.commit, date: plan.date, parser: plan.parser,
  rows: { count: 1, bytes: 1, partBytes: 1, parts: [{ key: 'fixture', bytes: 1 }] },
  index: { key: 'fixture', bytes: 1, entries: 1, digest: plan.indexDigest, sha256: 'a'.repeat(64) } });
function fixture() {
  const data = new Map<string, unknown>([[ATTEMPT_BUDGET_KEY, original()],
    [COORDINATOR_ADMISSION_KEY, { format: 1, revision: 1, suspended: true }], ['status', { pending: true, failures: 7 }]]);
  let alarm: number | null = null;
  const writes: string[] = [];
  const storage: CoordinatorStorage = {
    async get<T>(key: string) { return data.get(key) as T | undefined; },
    async put(key, value) { writes.push(key); data.set(key, structuredClone(value)); },
    async delete(key) { return data.delete(key); },
    async getAlarm() { return alarm; }, async setAlarm(value) { alarm = value; }, async deleteAlarm() { alarm = null; },
  };
  const budget = (mode: 'extend' | 'verify' = 'extend', coordinatorId: string = plan.coordinatorId) =>
    new DurableAttemptBudget(storage, control(), { mode, coordinatorId });
  return { data, storage, writes, budget };
}

describe('one fixed stage recovery extension', () => {
  it('pins a non-circular immutable authorization digest and transitions the original key once without opening admission', async () => {
    expect(createHash('sha256').update(JSON.stringify(plan)).digest('hex')).toBe(planSha256);
    const f = fixture(), before = structuredClone([...f.data]);
    await f.budget().initialize();
    expect(await f.budget().status()).toMatchObject({ cap: 1752, submitted: 1112, remaining: 640,
      recovery: { plan, planSha256, reservedCalls: 0 } });
    expect(f.writes).toEqual([ATTEMPT_BUDGET_KEY]);
    expect([...f.data].filter(([key]) => key !== ATTEMPT_BUDGET_KEY)).toEqual(before.filter(([key]) => key !== ATTEMPT_BUDGET_KEY));
    expect(await f.storage.getAlarm()).toBeNull();
  });

  it.each(['absent', 'null-record', 'missing-admission', 'wrong-object', 'source', 'parser', 'cap', 'spent', 'open', 'revision', 'alarm', 'receipt', 'verify-only'])
    ('refuses %s without writes or initializing a fresh budget', async kind => {
      const f = fixture(); let id: string = plan.coordinatorId, mode: 'extend' | 'verify' = 'extend';
      if (kind === 'absent') f.data.delete(ATTEMPT_BUDGET_KEY);
      if (kind === 'null-record') f.data.set(ATTEMPT_BUDGET_KEY, null);
      if (kind === 'missing-admission') f.data.delete(COORDINATOR_ADMISSION_KEY);
      if (kind === 'wrong-object') id = '0'.repeat(64);
      if (kind === 'verify-only') mode = 'verify';
      if (['source', 'parser', 'cap', 'spent', 'receipt'].includes(kind)) {
        f.data.set(ATTEMPT_BUDGET_KEY, { ...original(),
          ...(kind === 'source' ? { commit: 'f'.repeat(40) } : kind === 'parser' ? { parser: 'legacy' } :
            kind === 'cap' ? { cap: 1113 } : kind === 'spent' ? { submitted: 1111 } : { recovery: {} }) });
      }
      if (kind === 'open' || kind === 'revision') f.data.set(COORDINATOR_ADMISSION_KEY,
        { format: 1, revision: kind === 'revision' ? 3 : 1, suspended: kind !== 'open' });
      if (kind === 'alarm') await f.storage.setAlarm(100);
      const before = structuredClone([...f.data]);
      await expect(f.budget(mode, id).initialize()).rejects.toThrow();
      expect([...f.data]).toEqual(before); expect(f.writes).toEqual([]);
    });

  it.each(['cap', 'commit', 'date', 'parser', 'absent'])('refuses a changed recovery control %s without writes', async field => {
    const f = fixture(), candidate = { ...control(),
      ...(field === 'cap' ? { cap: 1784 } : field === 'commit' ? { commit: 'f'.repeat(40) } :
        field === 'date' ? { date: '2026-10-16' } : field === 'parser' ? { parser: 'legacy' } : {}) };
    await expect(new DurableAttemptBudget(f.storage, field === 'absent' ? undefined : candidate,
      { coordinatorId: plan.coordinatorId, mode: 'extend' }).initialize()).rejects.toThrow('exact compiled');
    expect(f.writes).toEqual([]);
  });

  it.each([false, true])('recovers an extension write failure committed=%s without a second grant', async committed => {
    const f = fixture(), put = f.storage.put;
    f.storage.put = async (key, value) => { if (committed) await put(key, value); throw Error('uncertain extension'); };
    await expect(f.budget().initialize()).rejects.toThrow('uncertain extension');
    f.storage.put = put;
    expect(await f.budget().status()).toMatchObject({ cap: 1752, submitted: 1112, recovery: { reservedCalls: 0 } });
    expect(f.writes).toEqual([ATTEMPT_BUDGET_KEY]);
    expect(await f.budget('verify').status()).toMatchObject({ submitted: 1112 });
    expect(f.writes).toHaveLength(1);
  });

  it('normalizes unknown budget properties and refuses malformed or altered receipts', async () => {
    const f = fixture(); f.data.set(ATTEMPT_BUDGET_KEY, { ...original(), PRIVATE: 'must never escape' });
    await f.budget().initialize();
    expect(JSON.stringify(await f.budget().status())).not.toContain('PRIVATE');
    const granted = structuredClone(f.data.get(ATTEMPT_BUDGET_KEY));
    for (const recovery of [null, {}, { plan, planSha256, reservedCalls: 1 },
      { plan, planSha256: '0'.repeat(64), reservedCalls: 0 },
      { plan: { ...plan, totalCap: 1784 }, planSha256, reservedCalls: 0 },
      { plan, planSha256, reservedCalls: 0, PRIVATE: 'secret' }]) {
      f.data.set(ATTEMPT_BUDGET_KEY, { ...original(), cap: 1752, recovery });
      await expect(f.budget().status()).rejects.toThrow('recovery receipt');
    }
    f.data.set(ATTEMPT_BUDGET_KEY, granted);
    await expect(new DurableAttemptBudget(f.storage, control()).status()).rejects.toThrow('compiled staging');
  });

  it.each([1, 32])('atomically reserves both counters for concurrent %s-document sends and blocks the twenty-first', async size => {
    const f = fixture(), budget = f.budget(); let sends = 0;
    await budget.initialize();
    const send = () => budget.sendEncoder(new Request('https://fixture.invalid/embed', { method: 'POST',
      body: JSON.stringify({ texts: Array(size).fill('text'), titles: Array(size).fill('title') }) }), {
      async head() { return { commit: plan.commit, date: plan.date }; },
      snapshot,
      async send() { sends++; return new Response('fixture'); },
    });
    const result = await Promise.allSettled(Array.from({ length: 21 }, send));
    expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(20); expect(sends).toBe(20);
    expect(await f.budget().status()).toMatchObject({ submitted: 1112 + size * 20,
      recovery: { reservedCalls: 20 } });
    await expect(send()).rejects.toThrow(); expect(sends).toBe(20);
  });

  it('rejects 33 documents before send and retains reservation charges after a lost acknowledgement', async () => {
    const f = fixture(), budget = f.budget(); let sends = 0;
    await budget.initialize(); const put = f.storage.put;
    const send = (count: number) => budget.sendEncoder(new Request('https://fixture.invalid/embed', { method: 'POST',
      body: JSON.stringify({ texts: Array(count).fill('text'), titles: Array(count).fill('title') }) }), {
      async head() { return { commit: plan.commit, date: plan.date }; },
      snapshot,
      async send() { sends++; throw Error('uncertain provider result'); },
    });
    await expect(send(33)).rejects.toThrow('ceiling');
    f.storage.put = async (key, value) => { await put(key, value); throw Error('uncertain reservation'); };
    await expect(send(32)).rejects.toThrow('uncertain reservation'); expect(sends).toBe(0);
    f.storage.put = put;
    expect(await f.budget('verify').status()).toMatchObject({ submitted: 1144, recovery: { reservedCalls: 1 } });
    await expect(send(32)).rejects.toThrow('uncertain provider result');
    expect(await f.budget().status()).toMatchObject({ submitted: 1176, recovery: { reservedCalls: 2 } });
  });
});

describe('recovery failure suspension', () => {
  it.each(['status', 'alarm'])('also pauses an execution setup %s failure before any provider work', async kind => {
    const f = fixture(), put = f.storage.put;
    f.data.set(COORDINATOR_ADMISSION_KEY, { format: 1, revision: 2, suspended: false });
    let calls = 0, failed = false;
    const runner = new DurableSingleFlight(f.storage, async () => { calls++; return {}; }, () => 1000, { suspendOnFailure: true });
    await runner.initialize();
    if (kind === 'status') f.storage.put = async (key, value) => {
      if (key === 'status' && !failed) { failed = true; throw Error('initial checkpoint unavailable'); }
      await put(key, value);
    };
    else f.storage.setAlarm = async () => { throw Error('initial watchdog unavailable'); };
    await expect(runner.run()).rejects.toThrow('unavailable');
    expect(await runner.status()).toMatchObject({ suspended: true, revision: 3, failures: 8, pending: true, alarmAt: null, quiescent: true });
    expect(calls).toBe(0);
    await runner.alarm(); expect(calls).toBe(0);
  });

  it('closes admission if reconstruction cannot rearm pending recovery, without rewriting the checkpoint', async () => {
    const f = fixture(); f.data.set(COORDINATOR_ADMISSION_KEY, { format: 1, revision: 2, suspended: false });
    const before = structuredClone(f.data.get('status'));
    f.storage.setAlarm = async () => { throw Error('recovery rearm unavailable'); };
    const runner = new DurableSingleFlight(f.storage, async () => ({}), () => 1000, { suspendOnFailure: true });
    await expect(runner.initialize()).rejects.toThrow('rearm unavailable');
    expect(f.data.get(COORDINATOR_ADMISSION_KEY)).toEqual({ format: 1, revision: 3, suspended: true });
    expect(f.data.get('status')).toEqual(before);
  });

  it.each(['none', 'status', 'delete-alarm', 'pause-before', 'pause-after'])('closes admission before risky failure storage (%s)', async failure => {
    const f = fixture(), put = f.storage.put;
    f.data.set(COORDINATOR_ADMISSION_KEY, { format: 1, revision: 2, suspended: false });
    let workCalls = 0, running = false;
    const runner = new DurableSingleFlight(f.storage, async () => { workCalls++; running = true; throw Error('PRIVATE encoder failure'); },
      () => 1000, { suspendOnFailure: true });
    f.storage.put = async (key, value) => {
      if (running && key === COORDINATOR_ADMISSION_KEY && failure.startsWith('pause-')) {
        if (failure === 'pause-after') await put(key, value); throw Error('uncertain pause');
      }
      if (running && key === 'status') {
        expect(f.data.get(COORDINATOR_ADMISSION_KEY)).toMatchObject({ suspended: true });
        if (failure === 'status') throw Error('status unavailable');
      }
      await put(key, value);
    };
    if (failure === 'delete-alarm') f.storage.deleteAlarm = async () => { throw Error('alarm unavailable'); };
    await expect(runner.run()).rejects.toThrow();
    expect(f.data.get(COORDINATOR_ADMISSION_KEY)).toMatchObject({ suspended: failure !== 'pause-before' });
    await expect(runner.run()).rejects.toMatchObject({ code: 'suspended' }); expect(workCalls).toBe(1);
    if (failure === 'none') {
      expect(await runner.status()).toMatchObject({ revision: 3, suspended: true, failures: 8, alarmAt: null, quiescent: true });
      await runner.alarm(); expect(workCalls).toBe(1);
    }
    expect(f.data.get(ATTEMPT_BUDGET_KEY)).toEqual(original());
  });
});
