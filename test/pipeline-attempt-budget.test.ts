import { describe, expect, it } from 'vitest';
import { ATTEMPT_BUDGET_KEY, DurableAttemptBudget, pipelineControl, type PipelineControlEnv } from '../services/pipeline/attempt-budget';
import { DurableSingleFlight, type CoordinatorStorage } from '../services/pipeline/single-flight';
import { httpEncoder } from '../src/ingest/encoder-client';
import { SNAPSHOT_PARSER_VERSION, type SnapshotManifest } from '../src/ingest/snapshot-format';

const commit = 'a'.repeat(40);
const date = '2026-10-15';
const config = (cap = 1112): PipelineControlEnv => ({ PIPELINE_PINNED_COMMIT: commit, PIPELINE_PINNED_DATE: date, PIPELINE_EMBEDDING_ATTEMPT_CAP: String(cap) });
function storage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  let failReservation = false;
  const value: CoordinatorStorage = {
    async get<T>(key: string) { return data.get(key) as T | undefined; },
    async put(key, record) {
      data.set(key, structuredClone(record));
      if (failReservation && key === ATTEMPT_BUDGET_KEY && (record as { submitted: number }).submitted > 0) throw new Error('uncertain durable acknowledgement');
    },
    async delete(key) { return data.delete(key); },
    async getAlarm() { return alarm; }, async setAlarm(time) { alarm = time; }, async deleteAlarm() { alarm = null; },
  };
  return { value, data, failReservation: () => { failReservation = true; } };
}
function fixture(s = storage(), cap = 1112) {
  const budget = new DurableAttemptBudget(s.value, pipelineControl(config(cap)));
  const manifest: SnapshotManifest = { format: 1, commit, parser: SNAPSHOT_PARSER_VERSION, date,
    rows: { count: 1, bytes: 1, partBytes: 1, parts: [{ key: `snapshots/${SNAPSHOT_PARSER_VERSION}/${commit}.rows.000.jsonl`, bytes: 1, sha256: 'd'.repeat(64) }] },
    index: { key: `snapshots/${SNAPSHOT_PARSER_VERSION}/${commit}.index.jsonl`, bytes: 1, entries: 1, digest: 'b'.repeat(32), sha256: 'c'.repeat(64) } };
  let head = { commit, date };
  let published = manifest;
  let failEncoder = false;
  const submitted: number[] = [];
  const encoder = httpEncoder({ url: 'https://local-encoder', send: (request) => budget.sendEncoder(request, {
    head: async () => head, snapshot: async () => published,
    async send(message) {
      const body = await message.json() as { texts: string[] };
      // A durable reservation must already exist when the HTTP call begins.
      const persisted = s.data.get(ATTEMPT_BUDGET_KEY) as { submitted: number };
      expect(persisted.submitted).toBeGreaterThanOrEqual(body.texts.length + submitted.reduce((sum, count) => sum + count, 0));
      submitted.push(body.texts.length);
      if (failEncoder) return new Response('encoder unavailable', { status: 503 });
      return Response.json({ vectors: body.texts.map(() => [0.1]) });
    },
  }) });
  return { budget, encoder, submitted, manifest, storage: s,
    changeHead: (value: typeof head) => { head = value; },
    changeSnapshot: (value: SnapshotManifest) => { published = value; },
    failEncoder: () => { failEncoder = true; } };
}
const documents = (count: number) => Array.from({ length: count }, () => ({ text: 'Provision text.', title: 'Act section' }));

describe('durable controlled pipeline attempts', () => {
  it('keeps the exact pin/parser/cap and attempted document count across restart, without resetting or increasing it', async () => {
    const h = fixture();
    await h.encoder.embed(documents(32));
    const restarted = fixture(h.storage);
    expect(await restarted.budget.status()).toMatchObject({ controlled: true, commit, date, parser: SNAPSHOT_PARSER_VERSION, cap: 1112, submitted: 32, remaining: 1080 });
    await restarted.encoder.embed(documents(8));
    expect(await restarted.budget.status()).toMatchObject({ submitted: 40, remaining: 1072 });
    for (const changed of [undefined, pipelineControl(config(1113)), pipelineControl(config(1111)), { ...pipelineControl(config())!, commit: 'f'.repeat(40) }, { ...pipelineControl(config())!, parser: 'statutes-v3' }]) {
      await expect(new DurableAttemptBudget(h.storage.value, changed).initialize()).rejects.toThrow('cannot be removed, changed, reset or increased');
    }
    expect((h.storage.data.get(ATTEMPT_BUDGET_KEY) as { submitted: number }).submitted).toBe(40);
  });
  it('charges failed HTTP attempts and retries, then blocks the next complete request before it reaches the encoder', async () => {
    const h = fixture(storage(), 5); h.failEncoder();
    await expect(h.encoder.embed(documents(2))).rejects.toThrow('503');
    await expect(h.encoder.embed(documents(2))).rejects.toThrow('503');
    await expect(h.encoder.embed(documents(2))).rejects.toThrow('budget exhausted');
    expect(h.submitted).toEqual([2, 2]);
    expect(await h.budget.status()).toMatchObject({ submitted: 4, remaining: 1 });
    const restarted = fixture(h.storage, 5);
    await restarted.encoder.embed(documents(1));
    await expect(restarted.encoder.embed(documents(1))).rejects.toThrow('budget exhausted');
    expect(await restarted.budget.status()).toMatchObject({ submitted: 5, remaining: 0 });
  });
  it('serializes concurrent reservations so their sum never exceeds the cumulative cap', async () => {
    const h = fixture(storage(), 3);
    const results = await Promise.allSettled([h.encoder.embed(documents(2)), h.encoder.embed(documents(2))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(h.submitted).toEqual([2]);
    expect(await h.budget.status()).toMatchObject({ submitted: 2, remaining: 1 });
  });
  it('shares the cap across overlapping requests, bounded slices, alarm continuation and object restart', async () => {
    const h = fixture(storage(), 3);
    let slices = 0;
    const runner = new DurableSingleFlight(h.storage.value, async () => { await h.encoder.embed(documents(1)); return { remaining: ++slices < 3 }; });
    await Promise.all([runner.run(), runner.run(), runner.run()]);
    expect(h.submitted).toEqual([1]);
    await runner.alarm();
    const restarted = fixture(h.storage, 3);
    const resumed = new DurableSingleFlight(h.storage.value, async () => { await restarted.encoder.embed(documents(1)); return { remaining: false }; });
    await resumed.alarm();
    expect(await restarted.budget.status()).toMatchObject({ submitted: 3, remaining: 0 });
    await expect(resumed.run()).rejects.toThrow('budget exhausted');
    expect(h.submitted.length + restarted.submitted.length).toBe(3);
  });
  it('preserves spent attempts across suspension, pending recovery and resume without admission-control refunds', async () => {
    const h = fixture(storage(), 3);
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const accepted = new Promise<void>(resolve => { entered = resolve; });
    const runner = new DurableSingleFlight(h.storage.value, async () => {
      await h.encoder.embed(documents(2)); entered(); await blocked; return { remaining: true };
    });
    const active = runner.run(); await accepted;
    const before = structuredClone(h.storage.data.get(ATTEMPT_BUDGET_KEY));
    expect(await runner.suspend(0)).toMatchObject({ suspended: true, quiescent: false });
    await expect(runner.run()).rejects.toMatchObject({ code: 'suspended' });
    expect(h.storage.data.get(ATTEMPT_BUDGET_KEY)).toEqual(before);
    release(); await active;
    const restarted = fixture(h.storage, 3);
    const recovery = new DurableSingleFlight(h.storage.value, async () => {
      await restarted.encoder.embed(documents(1)); return { remaining: false };
    });
    await recovery.initialize(); await recovery.alarm();
    expect(restarted.submitted).toEqual([]);
    expect(await restarted.budget.status()).toMatchObject({ cap: 3, submitted: 2, remaining: 1 });
    await recovery.resume(1); await recovery.alarm();
    expect(await restarted.budget.status()).toMatchObject({ cap: 3, submitted: 3, remaining: 0 });
    expect(restarted.submitted).toEqual([1]);
    await expect(restarted.encoder.embed(documents(1))).rejects.toThrow('budget exhausted');
  });
  it('rechecks source head immediately before every HTTP call and never submits after a changed pin', async () => {
    const h = fixture();
    await h.encoder.embed(documents(1));
    h.changeHead({ commit: 'f'.repeat(40), date });
    await expect(h.encoder.embed(documents(2))).rejects.toThrow('source head');
    expect(h.submitted).toEqual([1]);
    expect(await h.budget.status()).toMatchObject({ submitted: 1 });
    h.changeHead({ commit, date: '2026-10-16' });
    await expect(h.encoder.embed(documents(1))).rejects.toThrow('source head');
  });
  it.each(['commit', 'date', 'parser', 'digest', 'sha256'])('refuses a mismatched snapshot %s before reserving or sending', async (field) => {
    const h = fixture();
    const changed = structuredClone(h.manifest);
    if (field === 'commit') changed.commit = 'e'.repeat(40);
    else if (field === 'date') changed.date = '2026-10-16';
    else if (field === 'parser') changed.parser = undefined;
    else if (field === 'digest') changed.index.digest = undefined;
    else changed.index.sha256 = undefined;
    h.changeSnapshot(changed);
    await expect(h.encoder.embed(documents(1))).rejects.toThrow('matching immutable snapshot');
    expect(h.submitted).toEqual([]);
    expect(await h.budget.status()).toMatchObject({ submitted: 0 });
  });
  it('does not call the encoder after an uncertain durable reservation acknowledgement, and never refunds it on restart', async () => {
    const h = fixture(storage(), 2); h.storage.failReservation();
    await expect(h.encoder.embed(documents(2))).rejects.toThrow('uncertain durable acknowledgement');
    expect(h.submitted).toEqual([]);
    const restarted = fixture(h.storage, 2);
    expect(await restarted.budget.status()).toMatchObject({ submitted: 2, remaining: 0 });
    await expect(restarted.encoder.embed(documents(1))).rejects.toThrow('budget exhausted');
  });
  it('preserves the unbounded production send policy only with all controls absent and no persisted controlled budget', async () => {
    const s = storage(); const budget = new DurableAttemptBudget(s.value, pipelineControl({}));
    let calls = 0;
    await budget.sendEncoder(new Request('https://local-encoder/embed'), {
      async head() { throw new Error('should not recheck unbounded head'); }, async snapshot() { throw new Error('should not require unbounded snapshot'); },
      async send() { calls++; return new Response('ok'); },
    });
    expect(calls).toBe(1);
    expect(await budget.status()).toEqual({ controlled: false });
    expect(s.data.has(ATTEMPT_BUDGET_KEY)).toBe(false);
  });
});

describe('controlled pipeline configuration', () => {
  it.each([
    { PIPELINE_PINNED_COMMIT: commit }, { PIPELINE_PINNED_DATE: date }, { PIPELINE_EMBEDDING_ATTEMPT_CAP: '1112' },
    { ...config(), PIPELINE_PINNED_COMMIT: 'short-sha' }, { ...config(), PIPELINE_PINNED_DATE: '2026-02-29' },
    { ...config(), PIPELINE_PINNED_DATE: '' }, { ...config(), PIPELINE_EMBEDDING_ATTEMPT_CAP: '0' },
    { ...config(), PIPELINE_EMBEDDING_ATTEMPT_CAP: '-1' }, { ...config(), PIPELINE_EMBEDDING_ATTEMPT_CAP: '1.5' },
    { ...config(), PIPELINE_EMBEDDING_ATTEMPT_CAP: 'Infinity' }, { ...config(), PIPELINE_EMBEDDING_ATTEMPT_CAP: '9007199254740992' },
  ])('rejects incomplete or invalid pin/cap configuration %j', (value) => { expect(() => pipelineControl(value)).toThrow('requires'); });
});
