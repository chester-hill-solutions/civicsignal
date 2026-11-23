import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { WorkflowStep } from 'cloudflare:workers';
import { build } from 'esbuild';
import { generateQualificationReference, REFERENCE_INPUTS, REFERENCE_OUTPUT } from '../scripts/generate-snapshot-qualification-reference';
import { qualificationRuntime, qualificationRuntimePolicyDescriptor, QUALIFICATION_ADMISSION_STEP } from '../services/snapshot/qualification-reference-policy';
import { QUALIFICATION_PAYLOADS, QUALIFICATION_REFERENCE } from '../services/snapshot/qualification-reference-data';
import { qualificationIdentity, qualificationRecord, reserveSourceAttempt, runQualificationScheduled } from '../services/snapshot/qualification';
import { qualificationReceipt, assertQualificationReceipt } from '../services/snapshot/qualification-store';
import { cleanupStaging, stagingPrefix, type BuildBucket } from '../services/snapshot/builder';
import { runSnapshotWorkflow } from '../services/snapshot/snapshot-workflow';
import { controls, event, files, memoryBucket, revision } from './helpers/snapshot-qualification';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifestEntry = QUALIFICATION_PAYLOADS.find(([key]) => key.endsWith('.manifest.json'))!;
async function fixture(changed: Partial<BuildBucket> = {}, clock?: { wall?: () => number; monotonic?: () => number }) {
  const q = await qualificationIdentity(controls), h = memoryBucket(), calls: string[] = [];
  const raw = { ...h.bucket, ...changed };
  const bucket = Object.fromEntries(Object.entries(raw).map(([name, fn]) => [name, (...args: unknown[]) => {
    calls.push(name); return Reflect.apply(fn, raw, args);
  }])) as BuildBucket;
  const runtime = qualificationRuntime(bucket, q, clock);
  return { q, h, calls, runtime, physical: (key: string) => q.prefix + key };
}
const manifestBytes = () => readFile(REFERENCE_INPUTS[0].path);
const immutableOptions = () => ({ onlyIf: { etagDoesNotMatch: '*' }, customMetadata: { sha256: manifestEntry[2] } });

describe('fixed qualification runtime policy', () => {
  it('reproduces all483 payload entries from the exact retained immutable inputs', async () => {
    const [manifest, staging, actual] = await Promise.all([readFile(REFERENCE_INPUTS[0].path), readFile(REFERENCE_INPUTS[1].path), readFile(REFERENCE_OUTPUT, 'utf8')]);
    expect(generateQualificationReference(manifest, staging)).toBe(actual);
    expect(QUALIFICATION_PAYLOADS).toHaveLength(483);
    expect(QUALIFICATION_PAYLOADS.reduce((sum, [, bytes]) => sum + bytes, 0)).toBe(1152718942);
    const bad = Buffer.from(staging); bad[0] ^= 1;
    expect(() => generateQualificationReference(manifest, bad)).toThrow('differs');
  });
  it('never loads the qualification map into the canonical snapshot graph', async () => {
    const result = await build({ entryPoints: ['services/snapshot/worker.ts'], bundle: true, write: false, metafile: true,
      format: 'esm', platform: 'browser', external: ['node:*', 'cloudflare:*'], logLevel: 'silent' });
    expect(Object.keys(result.metafile!.inputs).some(name => name.includes('qualification-reference'))).toBe(false);
  });
  it('binds a new deadline into identity while legacy history remains derivable but cannot execute', async () => {
    const legacy = { ...controls, SNAPSHOT_QUALIFICATION_DEADLINE: undefined }, a = await qualificationIdentity(legacy), b = await qualificationIdentity(controls);
    expect(a.identity.runtimeDeadline).toBeUndefined(); expect(a.digest).not.toBe(b.digest);
    const h = memoryBucket(), put = vi.spyOn(h.bucket, 'put'), get = vi.spyOn(h.bucket, 'get');
    expect(() => qualificationRuntime(h.bucket, a)).toThrow('missing-runtime-deadline');
    await expect(runQualificationScheduled({ ...legacy, CORPUS: h.bucket, SNAPSHOT: { create: vi.fn(), get: vi.fn() } }, event, vi.fn())).rejects.toThrow('configuration');
    await expect(reserveSourceAttempt(h.bucket, a, 'archive')).rejects.toThrow('deadline');
    expect(put).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });
  it.each(['0', 'NaN', String(event.scheduledTime), String(event.scheduledTime + 10800001)])('rejects an invalid deadline before choosing R2: %s', async deadline => {
    await expect(qualificationIdentity({ ...controls, SNAPSHOT_QUALIFICATION_DEADLINE: deadline })).rejects.toThrow('deadline');
  });
  it('declares fixed persistent state and residual platform uncertainty separately', async () => {
    const f = await fixture(); expect(f.runtime.evidence).toMatchObject({ payloadObjects: 483, payloadBytes: 1152718942,
      receiptObjects: 10, receiptBytes: 20480, maximumCleanupLists: 244, maximumCleanupDeletes: 243,
      globalRawR2AggregateEnforced: false, residualPlatformDeliveryReconstructionAndInflightUncertainty: true });
  });
  it('pins callback policy and reference data separately from a reviewed event deadline', async () => {
    const q = await qualificationIdentity(controls), first = qualificationRuntimePolicyDescriptor(q), same = qualificationRuntimePolicyDescriptor(q);
    const next = qualificationRuntimePolicyDescriptor(await qualificationIdentity({ ...controls, SNAPSHOT_QUALIFICATION_DEADLINE: String(Number(controls.SNAPSHOT_QUALIFICATION_DEADLINE) - 1) }));
    expect(first).toEqual(same); expect(first.policyDigest).not.toBe(next.policyDigest); expect(first.payloadPolicySha256).toBe(next.payloadPolicySha256);
    expect(first.callbacks).toHaveLength(130); // scheduled callback plus129 qualified Workflow checkpoints
  });
  it.each(['unknown-key', 'wrong-callback', 'bytes', 'metadata', 'condition', 'stream'] as const)('refuses %s PUT before underlying R2', async mode => {
    const f = await fixture(), good = await manifestBytes(), bytes = Buffer.from(good), options = immutableOptions(); let key = manifestEntry[0], step = 'publish immutable snapshot manifest last';
    if (mode === 'unknown-key') key += '.extra';
    if (mode === 'wrong-callback') step = 'check published revision';
    if (mode === 'bytes') bytes[0] ^= 1;
    if (mode === 'metadata') options.customMetadata.sha256 = '0'.repeat(64);
    if (mode === 'condition') options.onlyIf.etagDoesNotMatch = 'other';
    await expect(f.runtime.run(step, async () => { await f.runtime.bucket.put(f.physical(key), mode === 'stream' ? new ReadableStream() : bytes, options); })).rejects.toThrow('policy refused');
    expect(f.calls).toEqual([]);
  });
  it('accepts actual fixed bytes and retains an identical immutable collision without replacement', async () => {
    const f = await fixture(), bytes = await manifestBytes(), key = f.physical(manifestEntry[0]);
    await f.runtime.run('publish immutable snapshot manifest last', () => f.runtime.bucket.put(key, bytes, immutableOptions()));
    await f.runtime.run('publish immutable snapshot manifest last', () => f.runtime.bucket.put(key, bytes, immutableOptions()));
    expect(f.h.writes).toEqual([key]); expect(digest(f.h.objects.get(key)!.bytes)).toBe(manifestEntry[2]);
  });
  it.each(['body-hash', 'overflow', 'truncated', 'metadata-size'] as const)('refuses a corrupted %s read with bounded consumption', async mode => {
    const bytes = Buffer.from(await manifestBytes()), f = await fixture({ async get(key: string) {
      const body = Buffer.from(bytes); if (mode === 'body-hash') body[0] ^= 1;
      const streamed = mode === 'overflow' ? Buffer.concat([body, Buffer.of(1)]) : mode === 'truncated' ? body.subarray(0, -1) : body;
      return { key, size: mode === 'metadata-size' ? bytes.length + 1 : bytes.length, customMetadata: { sha256: manifestEntry[2] }, body: new Response(streamed).body } as unknown as R2ObjectBody;
    } });
    await expect(f.runtime.run('check published revision', async () => { const got = await f.runtime.bucket.get(f.physical(manifestEntry[0])); await got!.arrayBuffer(); })).rejects.toThrow('policy refused');
    expect(f.calls).toEqual(['get']);
  });
  it('cannot checkpoint success after leaving an R2 body unconsumed', async () => {
    const f = await fixture(), bytes = await manifestBytes(), key = f.physical(manifestEntry[0]);
    await f.h.bucket.put(key, bytes, immutableOptions());
    await expect(f.runtime.run('check published revision', async () => { await f.runtime.bucket.get(key); return true; })).rejects.toThrow('incomplete-body');
    expect(f.calls).toEqual(['get']);
  });
  it('checks the absolute deadline after a pending streamed read resumes', async () => {
    let at = event.scheduledTime, source!: ReadableStreamDefaultController<Uint8Array>;
    const bytes = await manifestBytes(), f = await fixture({ async get(key: string) { return { key, size: bytes.length, customMetadata: { sha256: manifestEntry[2] },
      body: new ReadableStream<Uint8Array>({ start(controller) { source = controller; } }) } as unknown as R2ObjectBody; } }, { wall: () => at });
    await expect(f.runtime.run('check published revision', async () => { const value = await f.runtime.bucket.get(f.physical(manifestEntry[0]));
      at = Number(controls.SNAPSHOT_QUALIFICATION_DEADLINE); source.enqueue(bytes); await value!.arrayBuffer(); })).rejects.toThrow('deadline');
    expect(f.calls).toEqual(['get']);
  });
  it.each(['published-count', 'unsafe-failure', 'foreign-base'] as const)('refuses a %s receipt before its write', async mode => {
    const f = await fixture(), published = mode === 'published-count', name = published ? 'diagnostics/published.json' : 'diagnostics/failed.json';
    const value = { ...qualificationRecord(f.q, published ? 'published' : 'failed-or-uncertain'),
      ...(published ? { count: 1, existing: false } : mode === 'unsafe-failure' ? { sourceFailure: { code: 'transport', rawBody: 'synthetic private content' } } : { digest: '0'.repeat(64) }) };
    await expect(f.runtime.run(published ? 'record qualification publication outcome' : 'scheduled entry', () => qualificationReceipt(f.runtime.bucket, f.physical(name), value))).rejects.toThrow('policy refused');
    expect(f.calls).toEqual([]);
  });
  it('requires a callback scope and consumes its call allowance before the next R2 request', async () => {
    const f = await fixture(), key = f.physical(manifestEntry[0]);
    await expect(f.runtime.bucket.get(key)).rejects.toThrow('callback');
    await expect(f.runtime.run('check published revision', async () => { await f.runtime.bucket.get(key); await f.runtime.bucket.get(key); })).rejects.toThrow('key-spent');
    expect(f.calls).toEqual(['get']);
  });
  it('validates fixed receipt contracts while preserving failed/lost ACK claims', async () => {
    const f = await fixture(); f.h.failWrites(() => 'after');
    const write = () => qualificationReceipt(f.runtime.bucket, f.physical('diagnostics/admitted.json'), qualificationRecord(f.q, 'admitted'));
    await expect(f.runtime.run('scheduled entry', write)).rejects.toThrow('uncertain');
    f.h.failWrites(undefined);
    await expect(f.runtime.run('scheduled entry', write)).resolves.toBe(false);
    expect(f.h.writes).toHaveLength(1);
    await expect(f.runtime.run('scheduled entry', () => qualificationReceipt(f.runtime.bucket, f.physical('diagnostics/admitted.json'), { ...qualificationRecord(f.q, 'admitted'), unexpected: true }))).rejects.toThrow('receipt-contract');
    expect(f.h.writes).toHaveLength(1);
  });
  it.each(['expired-before', 'expired-after', 'callback-timeout', 'clock-backwards'] as const)('fences %s without admitting subsequent work', async mode => {
    let at = event.scheduledTime, mono = 100;
    const f = await fixture({ async get() {
      if (mode === 'expired-after') at = Number(controls.SNAPSHOT_QUALIFICATION_DEADLINE);
      if (mode === 'callback-timeout') mono += 600000;
      if (mode === 'clock-backwards') at--;
      return null;
    } }, { wall: () => at, monotonic: () => mono });
    if (mode === 'expired-before') at = Number(controls.SNAPSHOT_QUALIFICATION_DEADLINE);
    await expect(f.runtime.run('check published revision', async () => { await f.runtime.bucket.get(f.physical(manifestEntry[0])); await f.runtime.bucket.get(f.physical(manifestEntry[0])); })).rejects.toThrow('deadline');
    expect(f.calls).toHaveLength(mode === 'expired-before' ? 0 : 1);
  });
  it('reuses a completed admission checkpoint after reconstruction without refetching its two receipts', async () => {
    const f = await fixture(), checkpoints = new Map<string, unknown>();
    for (const name of ['admitted', 'discovered']) await f.h.bucket.put(f.physical(`diagnostics/${name}.json`), JSON.stringify(qualificationRecord(f.q, name)) + '\n');
    const step = { async do(name: string, _config: unknown, callback: () => Promise<unknown>) {
      if (!checkpoints.has(name)) checkpoints.set(name, await callback()); return checkpoints.get(name);
    } } as unknown as WorkflowStep;
    const read = (runtime: typeof f.runtime) => runtime.step(step, QUALIFICATION_ADMISSION_STEP, async () => {
      for (const name of ['admitted', 'discovered']) await assertQualificationReceipt(runtime.bucket, f.physical(`diagnostics/${name}.json`), qualificationRecord(f.q, name)); return true;
    });
    await read(f.runtime);
    const next = qualificationRuntime(f.runtime.bucket, f.q); // New callback state; cached admission never touches either wrapper.
    await read(next); expect(f.calls).toEqual(['get', 'get']);
  });
  it('applies explicit zero-retry finite configs throughout the real shared Workflow', async () => {
    const h = memoryBucket(), q = await qualificationIdentity(controls), runtime = qualificationRuntime(h.bucket, q), configs: { name: string; retries: { limit: number }; timeout: number }[] = [];
    const step = { async do(name: string, config: { retries: { limit: number }; timeout: number }, callback: () => Promise<unknown>) {
      expect(config.retries.limit).toBe(0); expect(config.timeout).toBeGreaterThan(0); expect(config.timeout).toBeLessThanOrEqual(3600000);
      configs.push({ name, ...config }); return callback();
    } } as unknown as WorkflowStep;
    await runtime.step(step, QUALIFICATION_ADMISSION_STEP, async () => true);
    // Tiny builder fixture tests dispatch/configs; native tests replace only the
    // generated map and enforce the complete store path on these same bytes.
    await runSnapshotWorkflow(revision, step, h.bucket, { head: async () => revision, source: { async *instruments() { yield* files; } },
      qualificationStep: (name, callback) => runtime.step(step, name, callback) });
    await runtime.step(step, 'record qualification publication outcome', async () => true);
    expect(configs.map(value => value.name)).toEqual([QUALIFICATION_ADMISSION_STEP, 'check authoritative source commit date', 'check published revision', 'stage pinned corpus once',
      'parse file group 0', ...['acts-en-', 'acts-fr-', 'regulations-en-', 'regulations-fr-'].map(name => `sort ${name} index`),
      'publish immutable snapshot manifest last', 'remove this revision staging objects', 'record qualification publication outcome']);
  });
});

describe('finite qualification staging cleanup', () => {
  const prefix = stagingPrefix(revision.commit), keys = [prefix + 'one', prefix + 'two', prefix + 'three'];
  it('handles legitimate one-key short pages with bounded acknowledged progress', async () => {
    const remaining = new Set(keys), list = vi.fn(async () => ({ objects: [...remaining].slice(0, 1).map(key => ({ key })), truncated: remaining.size > 1 })), remove = vi.fn(async (values: string[]) => { for (const key of values) remaining.delete(key); });
    await cleanupStaging({ list, delete: remove } as unknown as BuildBucket, revision.commit, { maximumLists: 4, maximumDeletes: 3, allowedKeys: new Set(keys), check() {} });
    expect(list).toHaveBeenCalledTimes(4); expect(remove).toHaveBeenCalledTimes(3); expect(remaining.size).toBe(0);
  });
  it.each(['nonprogress', 'foreign', 'lost-ack', 'list-cap', 'delete-cap', 'deadline', 'empty-unknown'] as const)('retains refusal on %s without a cleanup retry', async mode => {
    let expired = false;
    const list = vi.fn(async () => ({ objects: mode === 'empty-unknown' ? [] : [{ key: mode === 'foreign' ? prefix + 'foreign' : keys[0] }], truncated: true }));
    const remove = vi.fn(async () => { if (mode === 'lost-ack') throw new Error('synthetic unknown commit'); if (mode === 'deadline') expired = true; });
    const check = () => { if (expired) throw new Error('deadline'); };
    await expect(cleanupStaging({ list, delete: remove } as unknown as BuildBucket, revision.commit,
      { maximumLists: mode === 'list-cap' ? 1 : 4, maximumDeletes: mode === 'delete-cap' ? 0 : 3, allowedKeys: new Set(keys), check })).rejects.toThrow();
    expect(remove.mock.calls.length).toBeLessThanOrEqual(1);
    if (mode === 'lost-ack' || mode === 'deadline') expect(list).toHaveBeenCalledTimes(1);
    if (mode === 'foreign' || mode === 'delete-cap' || mode === 'empty-unknown') expect(remove).not.toHaveBeenCalled();
  });
});
