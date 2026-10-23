import { describe, expect, it } from 'vitest';
import { DurableSingleFlight, type CoordinatorStorage, type CoordinatorStatus } from '../services/pipeline/single-flight';

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
