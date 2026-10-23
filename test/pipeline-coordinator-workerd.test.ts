import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Response as LocalResponse } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fingerprint } from '../src/ingest/reconcile';
import { indexDigest, indexKey, manifestKey, SNAPSHOT_PARSER_VERSION as parser, vectorsPartKey } from '../src/ingest/snapshot-format';

const commit = 'a'.repeat(40), date = '2026-10-15', name = 'coordinator-local-proof';
const close: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const finish of close.splice(0).reverse()) await finish(); });
let probeScript = '', pipelineScript = '';
beforeAll(async () => {
  const [probe, pipeline] = await Promise.all([
    build({ stdin: { resolveDir: process.cwd(), contents: `
import { DurableObject } from 'cloudflare:workers';
import { DurableSingleFlight, COORDINATOR_ADMISSION_KEY, CoordinatorAdmissionError } from './services/pipeline/single-flight';
import { DurableAttemptBudget, ATTEMPT_BUDGET_KEY, pipelineControl } from './services/pipeline/attempt-budget';
import { httpEncoder } from './src/ingest/encoder-client';
const commit = '${commit}', date = '${date}';
export class CoordinatorProbe extends DurableObject {
  instanceId = crypto.randomUUID();
  constructor(ctx, env) {
    super(ctx, env);
    this.budget = new DurableAttemptBudget(ctx.storage, pipelineControl({ PIPELINE_PINNED_COMMIT: commit, PIPELINE_PINNED_DATE: date, PIPELINE_EMBEDDING_ATTEMPT_CAP: '3' }));
    const storage = {
      get: key => ctx.storage.get(key), delete: key => ctx.storage.delete(key),
      put: async (key, value) => {
        const fault = key === COORDINATOR_ADMISSION_KEY && !value.suspended ? await ctx.storage.get('resumeFault') : undefined;
        if (fault?.operation === 'admission') {
          await ctx.storage.delete('resumeFault');
          if (fault.committed) await ctx.storage.put(key, value);
          throw Error('fixture uncertain admission write');
        }
        await ctx.storage.put(key, value);
        if (key === COORDINATOR_ADMISSION_KEY && value.suspended && await ctx.storage.get('uncertainPause')) {
          await ctx.storage.delete('uncertainPause'); throw Error('fixture lost pause acknowledgement');
        }
      },
      getAlarm: () => ctx.storage.getAlarm(), setAlarm: async time => {
        const fault = await ctx.storage.get('resumeFault');
        if (fault?.operation === 'alarm') {
          await ctx.storage.delete('resumeFault');
          if (fault.committed) await ctx.storage.setAlarm(time);
          throw Error('fixture uncertain alarm write');
        }
        await ctx.storage.setAlarm(time);
      },
      deleteAlarm: async () => {
        if (await ctx.storage.get('failDelete')) { await ctx.storage.delete('failDelete'); throw Error('fixture alarm deletion failed'); }
        await ctx.storage.deleteAlarm();
      },
    };
    this.runner = new DurableSingleFlight(storage, async () => {
      await ctx.storage.put('workCalls', (await ctx.storage.get('workCalls') ?? 0) + 1);
      const encoder = httpEncoder({ url: 'https://fixture.invalid', send: request => this.budget.sendEncoder(request, {
        head: async () => ({ commit, date }),
        snapshot: async () => ({ commit, date, parser: '${parser}', index: { digest: 'b'.repeat(32), sha256: 'c'.repeat(64) } }),
        send: request => fetch(request),
      }) });
      await encoder.embed([{ text: 'One provision.', title: 'Test Act' }]);
      return { remaining: await ctx.storage.get('remaining') ?? false };
    });
    ctx.blockConcurrencyWhile(async () => { await this.budget.initialize(); await this.runner.initialize(); });
  }
  async state() { return { instanceId: this.instanceId, coordinator: await this.runner.status(), budget: await this.budget.status(),
    workCalls: await this.ctx.storage.get('workCalls') ?? 0, outbox: await this.ctx.storage.get('outbox'),
    admission: await this.ctx.storage.get(COORDINATOR_ADMISSION_KEY) }; }
  async seed(values) { for (const [key, value] of Object.entries(values)) await this.ctx.storage.put(key, value); return this.state(); }
  async raw() { return { checkpoint: await this.ctx.storage.get('status'), admission: await this.ctx.storage.get(COORDINATOR_ADMISSION_KEY),
    budget: await this.ctx.storage.get(ATTEMPT_BUDGET_KEY), alarmAt: await this.ctx.storage.getAlarm() }; }
  async suspend(revision) { await this.runner.suspend(revision); return this.state(); }
  async resume(revision) { await this.runner.resume(revision); return this.state(); }
  async run() { return this.runner.run(); }
  async alarm() { return this.runner.alarm(); }
  async oldAlarm() { await this.ctx.storage.setAlarm(Date.now() + 25); return {}; }
}
export default { async fetch(request, env) {
  const path = new URL(request.url).pathname, stub = env.PROBE.get(env.PROBE.idFromName('statutes-canada'));
  try {
    const body = request.method === 'GET' ? {} : await request.json();
    const value = path === '/state' ? await stub.state() : path === '/seed' ? await stub.seed(body) : path === '/raw' ? await stub.raw() :
      path === '/suspend' ? await stub.suspend(body.expectedRevision) : path === '/resume' ? await stub.resume(body.expectedRevision) :
      path === '/old-alarm' ? await stub.oldAlarm() : await stub.run();
    return Response.json(value);
  } catch (error) { return Response.json({ error: error.message, code: error.code }, { status: error.status ?? 500 }); }
}};` }, bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:*', 'node:*'], write: false }),
    build({ stdin: { resolveDir: process.cwd(), contents: `
      import worker, { PipelineCoordinator as Base } from './services/pipeline/worker';
      export class PipelineCoordinator extends Base {
        async fixtureSeed(body) { await this.ctx.storage.put('status', body); return {}; }
        async fixtureRaw() { return { checkpoint: await this.ctx.storage.get('status'),
          admission: await this.ctx.storage.get('coordinator-admission-v1'), alarmAt: await this.ctx.storage.getAlarm() }; }
      }
      export default { ...worker, async fetch(request, env) {
        const path = new URL(request.url).pathname;
        if (path.startsWith('/fixture-')) {
          const stub = env.PIPELINE_COORDINATOR.get(env.PIPELINE_COORDINATOR.idFromName('statutes-canada'));
          return Response.json(path === '/fixture-seed' ? await stub.fixtureSeed(await request.json()) : await stub.fixtureRaw());
        }
        return worker.fetch(request, env);
      }};` }, bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:*', 'node:*'], write: false }),
  ]);
  probeScript = probe.outputFiles[0]!.text; pipelineScript = pipeline.outputFiles[0]!.text;
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'civicsignal-coordinator-'));
  close.push(() => rm(path, { recursive: true, force: true })); return path;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
async function probeFixture(blocked = false, failure = false) {
  const path = await directory(), entered = deferred<void>(), release = deferred<void>();
  if (!blocked) release.resolve();
  let encoderCalls = 0;
  const mf = new Miniflare({ telemetry: { enabled: false }, unsafeDevRegistryPath: join(path, 'registry'),
    resourcePersistencePath: join(path, 'storage'), workers: [{ config: {
      name, compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
      env: { PROBE: { type: 'durable-object', worker: name, exportName: 'CoordinatorProbe' } },
      exports: { CoordinatorProbe: { type: 'durable-object', storage: 'sqlite' } },
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: probeScript } } },
    }, dev: { outboundService: { type: 'fetcher', handler: async request => {
      if (request.url !== 'https://fixture.invalid/embed') throw Error('External networking is forbidden.');
      encoderCalls++; entered.resolve(); await release.promise;
      return new LocalResponse(failure ? 'private fixture response' : JSON.stringify({ vectors: [[0.1]] }), { status: failure ? 503 : 200 });
    } } } }] });
  close.push(async () => { release.resolve(); await mf.dispose(); });
  await mf.ready;
  const call = async (route: string, body: unknown = {}, method = 'POST') => {
    const response = await mf.dispatchFetch(`https://fixture.invalid${route}`, { method,
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() as any };
  };
  return { mf, call, entered: entered.promise, release: () => release.resolve(), encoderCalls: () => encoderCalls };
}

async function httpFixture(holdSource = false) {
  const path = await directory(), worker = 'pipeline-http-local', secret = 'local-fixture-secret';
  const sourceEntered = deferred<void>(), sourceRelease = deferred<void>();
  const outbound: string[] = [];
  const mf = new Miniflare({ telemetry: { enabled: false }, unsafeTriggerHandlers: true, unsafeDevRegistryPath: join(path, 'registry'),
    resourcePersistencePath: join(path, 'storage'), workers: [{ config: {
      name: worker, compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
      env: {
        PIPELINE_COORDINATOR: { type: 'durable-object', worker, exportName: 'PipelineCoordinator' },
        CIVIC_DB: { type: 'd1', id: 'fixture-only-d1', dev: { remote: false } },
        CORPUS: { type: 'r2', name: 'fixture-only-r2', dev: { remote: false } },
        VECTORIZE: { type: 'worker', worker: 'fixture-vectors' },
        ...Object.fromEntries(Object.entries({ PIPELINE_SECRET: secret, PIPELINE_PINNED_COMMIT: commit,
          PIPELINE_PINNED_DATE: date, PIPELINE_EMBEDDING_ATTEMPT_CAP: '3' }).map(([key, value]) => [key, { type: 'text' as const, value }])),
      },
      exports: { PipelineCoordinator: { type: 'durable-object', storage: 'sqlite' } },
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: pipelineScript } } },
    }, dev: { outboundService: { type: 'fetcher', handler: async request => {
      outbound.push(request.url);
      if (holdSource && request.url === 'https://api.github.com/repos/justicecanada/laws-lois-xml/commits/main') {
        sourceEntered.resolve(); await sourceRelease.promise;
        return new LocalResponse('private fixture source failure', { status: 503 });
      }
      throw Error('All external networking is forbidden.');
    } } } }, { config: {
      name: 'fixture-vectors', compatibilityDate: '2026-10-22',
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents:
        `import { WorkerEntrypoint } from 'cloudflare:workers'; export default class extends WorkerEntrypoint { async getByIds() { return []; } }` } } },
    } }] });
  close.push(async () => { sourceRelease.resolve(); await mf.dispose(); });
  const call = (route: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST') =>
    mf.dispatchFetch(`https://pipeline.invalid${route}`, { method, headers: { 'x-pipeline-secret': secret, ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  const db = await mf.getD1Database('CIVIC_DB', worker), bucket = await mf.getR2Bucket('CORPUS', worker);
  await db.exec(`CREATE TABLE corpus_state(corpus_id TEXT,commit_sha TEXT,parser_version TEXT,row_count INTEGER);
    CREATE TABLE statute_sections(id TEXT,corpus_id TEXT,text_hash TEXT);
    CREATE TABLE corpus_mutations(id TEXT,corpus_id TEXT,payload TEXT);`);
  const row = { id: 'acts-en-1', corpusId: 'statutes-canada', instrument: 'Test Act', citation: 'T-1', section: '1',
    schedule: null, part: null, status: 'placeholder' as const, heading: null, text: '[Reserved]',
    source_url: 'https://example.invalid/1', in_force: 1 as const, language: 'en' as const, embedText: '', lastChanged: date };
  const bytes = (s: string) => new Uint8Array(new TextEncoder().encode(s));
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const rowBytes = bytes(JSON.stringify(row) + '\n'), entries = [{ id: row.id, fp: fingerprint(row), off: 0, len: rowBytes.length }];
  const indexBytes = bytes(JSON.stringify(entries[0]) + '\n'), digest = indexDigest(entries), rowKey = `snapshots/${parser}/${commit}.rows.000.jsonl`;
  const manifest = { format: 1, commit, parser, date, rows: { count: 1, bytes: rowBytes.length, partBytes: rowBytes.length,
    parts: [{ key: rowKey, bytes: rowBytes.length, sha256: sha(rowBytes) }] }, index: { key: indexKey(commit, parser), bytes: indexBytes.length, entries: 1, digest, sha256: sha(indexBytes) } };
  for (const [key, value] of [[rowKey, rowBytes], [indexKey(commit, parser), indexBytes], [manifestKey(commit, parser), bytes(JSON.stringify(manifest))]] as const) await bucket.put(key, value);
  await db.prepare('INSERT INTO corpus_state VALUES(?,?,?,1)').bind('statutes-canada', commit, parser).run();
  await db.prepare('INSERT INTO statute_sections VALUES(?,?,?)').bind(row.id, 'statutes-canada', entries[0]!.fp).run();
  return { mf, call, db, bucket, outbound, worker, sourceEntered: sourceEntered.promise, releaseSource: () => sourceRelease.resolve(),
    request: { commit, parser, indexDigest: digest, part: 0 } };
}

describe.skipIf(process.env['CIVICSIGNAL_WORKERD_TESTS'] !== '1')('pipeline admission in actual local workerd storage', () => {
  it('closes admission during accepted encoder work and reconstructs the same suspended object without refunding attempts', async () => {
    const f = await probeFixture(true), run = f.call('/run'); await f.entered;
    const before = (await f.call('/state', {}, 'GET')).value;
    expect(before.budget).toMatchObject({ submitted: 1, cap: 3, remaining: 2 });
    const pause = await f.call('/suspend', { expectedRevision: 0 });
    expect(pause.value.coordinator).toMatchObject({ suspended: true, active: 'ingest', alarmAt: null, quiescent: false });
    expect((await f.call('/run')).status).toBe(409); expect(f.encoderCalls()).toBe(1);
    await f.call('/seed', { remaining: true, outbox: { payload: 'retain-this-recovery-intent' } });
    f.release(); expect((await run).status).toBe(200);
    await f.mf.unsafeEvictDurableObject(name, 'CoordinatorProbe', { name: 'statutes-canada' });
    const after = (await f.call('/state', {}, 'GET')).value;
    expect(after.instanceId).not.toBe(before.instanceId);
    expect(after.coordinator).toMatchObject({ revision: 1, suspended: true, pending: true, alarmAt: null, quiescent: true });
    expect(after.budget).toEqual(before.budget); expect(after.outbox).toEqual({ payload: 'retain-this-recovery-intent' });
    expect(f.encoderCalls()).toBe(1);
    expect((await f.call('/resume', { expectedRevision: 1 })).value.coordinator).toMatchObject({ revision: 2, suspended: false, pending: true });
    await f.call('/seed', { remaining: false });
    await vi.waitFor(async () => { expect((await f.call('/state', {}, 'GET')).value.coordinator.pending).toBe(false); }, { timeout: 5000, interval: 40 });
    const resumed = (await f.call('/state', {}, 'GET')).value;
    expect(resumed.workCalls).toBe(2); expect(resumed.budget).toMatchObject({ submitted: 2, remaining: 1 });
  }, 20_000);

  it('absorbs a genuinely delivered old alarm and preserves a failed cycle without leaking its error into status', async () => {
    const f = await probeFixture(true, true), run = f.call('/run'); await f.entered;
    await f.call('/suspend', { expectedRevision: 0 }); f.release(); expect((await run).status).toBe(500);
    await f.call('/old-alarm');
    await vi.waitFor(async () => { expect((await f.call('/state', {}, 'GET')).value.coordinator).toMatchObject({ alarmAt: null, alarmHandlersActive: 0, quiescent: true }); }, { timeout: 3000, interval: 25 });
    const state = (await f.call('/state', {}, 'GET')).value;
    expect(state.coordinator).toMatchObject({ pending: true, failures: 1, suspended: true });
    expect(JSON.stringify(state)).not.toContain('private'); expect(f.encoderCalls()).toBe(1);
    expect(state.budget).toMatchObject({ submitted: 1, remaining: 2 });
  }, 15_000);

  it('survives a committed-but-unacknowledged pause and a failed alarm deletion without clearing recovery state', async () => {
    const f = await probeFixture();
    await f.call('/seed', { status: { pending: true, failures: 2 }, uncertainPause: true, outbox: { payload: 'keep' } });
    expect((await f.call('/suspend', { expectedRevision: 0 })).status).toBe(500);
    await f.mf.unsafeEvictDurableObject(name, 'CoordinatorProbe', { name: 'statutes-canada' });
    const persisted = (await f.call('/state', {}, 'GET')).value;
    expect(persisted.coordinator).toMatchObject({ revision: 1, suspended: true, pending: true, failures: 2 });
    expect((await f.call('/suspend', { expectedRevision: 0 })).status).toBe(409);
    await f.call('/seed', { failDelete: true });
    expect((await f.call('/suspend', { expectedRevision: 1 })).status).toBe(500);
    expect((await f.call('/suspend', { expectedRevision: 1 })).value.coordinator).toMatchObject({ revision: 1, quiescent: true });
    expect((await f.call('/state', {}, 'GET')).value.outbox).toEqual({ payload: 'keep' }); expect(f.encoderCalls()).toBe(0);
  }, 15_000);

  it.each([
    { operation: 'alarm', committed: false }, { operation: 'alarm', committed: true },
    { operation: 'admission', committed: false }, { operation: 'admission', committed: true },
  ])('recovers a real-storage resume $operation fault committed=$committed through observed revisions', async fault => {
    const f = await probeFixture();
    const checkpoint = { pending: true, failures: 2, lastError: 'Error: retained private failure' };
    await f.call('/seed', { status: checkpoint, outbox: { payload: 'retain' } });
    await f.call('/suspend', { expectedRevision: 0 });
    await f.call('/seed', { resumeFault: fault });
    const before = (await f.call('/raw')).value;
    expect((await f.call('/resume', { expectedRevision: 1 })).status).toBe(500);
    const open = fault.operation === 'admission' && fault.committed;
    const after = (await f.call('/state', {}, 'GET')).value;
    expect(after.coordinator).toMatchObject({ revision: open ? 2 : 1, suspended: !open, pending: true, failures: 2 });
    const saved = (await f.call('/raw')).value;
    expect(saved.checkpoint).toEqual(checkpoint); expect(saved.budget).toEqual(before.budget);
    expect(saved.alarmAt === null).toBe(fault.operation === 'alarm' && !fault.committed);
    expect(f.encoderCalls()).toBe(0);
    if (open) {
      expect((await f.call('/resume', { expectedRevision: 1 })).status).toBe(409);
      expect((await f.call('/suspend', { expectedRevision: 1 })).status).toBe(409);
      // Retire the armed continuation under the actual current revision before
      // eviction. A stale acknowledgement cannot reopen or overwrite it.
      expect((await f.call('/suspend', { expectedRevision: 2 })).value.coordinator.revision).toBe(3);
    } else {
      expect((await f.call('/suspend', { expectedRevision: 1 })).value.coordinator).toMatchObject({ revision: 1, alarmAt: null, quiescent: true });
    }
    await f.mf.unsafeEvictDurableObject(name, 'CoordinatorProbe', { name: 'statutes-canada' });
    const paused = (await f.call('/state', {}, 'GET')).value;
    expect(paused.coordinator).toMatchObject({ revision: open ? 3 : 1, suspended: true, alarmAt: null, quiescent: true, failures: 2 });
    expect(paused.budget).toEqual(after.budget); expect(paused.outbox).toEqual({ payload: 'retain' });
    expect((await f.call('/resume', { expectedRevision: paused.coordinator.revision })).status).toBe(200);
    await vi.waitFor(async () => { expect((await f.call('/state', {}, 'GET')).value.coordinator.pending).toBe(false); }, { timeout: 5000, interval: 40 });
    const completed = (await f.call('/state', {}, 'GET')).value;
    expect(completed.workCalls).toBe(1); expect(completed.budget).toMatchObject({ submitted: 1, remaining: 2 });
    expect(completed.outbox).toEqual({ payload: 'retain' }); expect(f.encoderCalls()).toBe(1);
  }, 15_000);

  it('rejects malformed legacy state through the real HTTP control path without leaking or overwriting it', async () => {
    const f = await httpFixture();
    const original = await (await f.call('/control')).json() as any;
    for (const checkpoint of [
      { pending: true, failures: { PRIVATE: 'credential' } },
      { pending: true, failures: 1, lastError: { PRIVATE: 'response-body' } },
      { pending: true, failures: 1, lastError: 'PRIVATE'.repeat(72) },
    ]) {
      await f.call('/fixture-seed', checkpoint);
      const before = await (await f.call('/fixture-raw')).json();
      for (const [route, body] of [['/control', undefined], ['/run', {}], ['/control/suspend', { expectedRevision: 0 }],
        ['/control/resume', { expectedRevision: 0 }], ['/vectors', f.request]] as const) {
        const response = await f.call(route, body);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: 'The pipeline operation is unavailable.' });
      }
      expect(await (await f.call('/fixture-raw')).json()).toEqual(before);
    }
    // Fixture-only repair restores the original checkpoint to verify that no
    // admission revision or attempt budget was changed by any rejected read.
    await f.call('/fixture-seed', { pending: false, failures: 0 });
    expect(await (await f.call('/control')).json()).toEqual(original);
    expect(f.outbound).toEqual([]);
  }, 15_000);

  it('observes a persisted alarm-started encoder failure after reconstruction without exposing response text or changing recovery', async () => {
    const f = await probeFixture(false, true);
    await f.call('/seed', { status: { pending: true, failures: 0 } }); await f.call('/old-alarm');
    await vi.waitFor(async () => { expect((await f.call('/state', {}, 'GET')).value.coordinator.failures).toBe(1); }, { timeout: 3000, interval: 25 });
    const before = (await f.call('/state', {}, 'GET')).value;
    expect(before.coordinator.lastFailure).toEqual({ classification: 'encoder-http', encoderHttpStatus: 503 });
    expect(before.budget.submitted).toBe(1); expect(f.encoderCalls()).toBe(1);
    await f.mf.unsafeEvictDurableObject(name, 'CoordinatorProbe', { name: 'statutes-canada' });
    const after = (await f.call('/state', {}, 'GET')).value;
    expect(after.instanceId).not.toBe(before.instanceId);
    expect(after.coordinator).toEqual(before.coordinator); expect(after.budget).toEqual(before.budget);
    expect(JSON.stringify(after)).not.toMatch(/private fixture|https:|lastError/);
    expect((await f.call('/state', {}, 'GET')).value.coordinator).toEqual(after.coordinator);
    await f.call('/suspend', { expectedRevision: 0 }); expect(f.encoderCalls()).toBe(1);
  }, 15_000);

  it('serializes competing suspension commands against actual storage and rejects old revisions after resume', async () => {
    const f = await probeFixture();
    const attempts = await Promise.all(Array.from({ length: 8 }, () => f.call('/suspend', { expectedRevision: 0 })));
    expect(attempts.filter(value => value.status === 200)).toHaveLength(1);
    expect(attempts.filter(value => value.status === 409)).toHaveLength(7);
    expect((await f.call('/state', {}, 'GET')).value.coordinator).toMatchObject({ revision: 1, suspended: true, quiescent: true });
    expect((await f.call('/resume', { expectedRevision: 1 })).status).toBe(200);
    expect((await f.call('/suspend', { expectedRevision: 2 })).value.coordinator.revision).toBe(3);
    expect((await f.call('/resume', { expectedRevision: 1 })).status).toBe(409);
    expect((await f.call('/suspend', { expectedRevision: 0 })).status).toBe(409);
    expect(f.encoderCalls()).toBe(0);
  }, 15_000);

  it('authenticates before control parsing or DO creation and bounds mutation inputs in the real Worker', async () => {
    const f = await httpFixture();
    expect((await f.call('/control/suspend', '{', { 'x-pipeline-secret': '' })).status).toBe(403);
    for (const body of ['{', { expectedRevision: -1 }, { expectedRevision: 0.5 }, { expectedRevision: 0, resetBudget: true }]) {
      expect((await f.call('/control/suspend', body)).status).toBe(400);
    }
    expect((await f.call('/control/suspend', 'X'.repeat(1025))).status).toBe(413);
    expect(await f.mf.listDurableObjectIds('PipelineCoordinator', f.worker)).toEqual([]);
    expect((await f.call('/control/suspend')).status).toBe(405);
    const first = await f.call('/control'); expect(first.status).toBe(200);
    const value = await first.json() as any;
    expect(value).toMatchObject({ controlled: true, commit, parser, cap: 3, submitted: 0, remaining: 3, corpusId: 'statutes-canada' });
    expect(value.coordinator).toMatchObject({ revision: 0, suspended: false, pending: false, active: null });
    expect((await f.call('/control/suspend', { expectedRevision: 0 })).status).toBe(200);
    expect((await f.call('/run', {})).status).toBe(409);
    expect((await f.call('/control/resume', { expectedRevision: 0 })).status).toBe(409);
    expect((await f.call('/control/resume', { expectedRevision: 1 })).status).toBe(200);
    expect(f.outbound).toEqual([]);
  }, 15_000);

  it('preserves ordinary export receipts, requires the paused revision for backup admission, and retains the D1 outbox gate', async () => {
    const f = await httpFixture();
    const ordinary = await f.call('/vectors', f.request); expect(ordinary.status).toBe(200);
    expect(ordinary.headers.get('x-pipeline-suspension-revision')).toBeNull();
    const receipt = await ordinary.json(); const key = vectorsPartKey(commit, 0, parser), before = await f.bucket.get(key);
    expect((await f.call('/vectors', f.request, { 'x-pipeline-suspension-revision': '0' })).status).toBe(409);
    await f.call('/control/suspend', { expectedRevision: 0 });
    expect((await f.call('/vectors', f.request)).status).toBe(409);
    expect((await f.call('/vectors', f.request, { 'x-pipeline-suspension-revision': '0' })).status).toBe(409);
    expect((await f.call('/vectors', f.request, { 'x-pipeline-suspension-revision': '1.5' })).status).toBe(400);
    const backup = await f.call('/vectors', f.request, { 'x-pipeline-suspension-revision': '1' });
    expect(backup.status).toBe(200); expect(backup.headers.get('x-pipeline-suspension-revision')).toBe('1');
    expect(await backup.json()).toEqual(receipt); expect((await f.bucket.get(key))!.etag).toBe(before!.etag);
    await f.db.prepare('INSERT INTO corpus_mutations VALUES(?,?,?)').bind('pending-vector', 'statutes-canada', '{"remove":"acts-en-1"}').run();
    const refused = await f.call('/vectors', f.request, { 'x-pipeline-suspension-revision': '1' });
    expect(refused.status).toBe(500); expect(await refused.text()).not.toMatch(/pending-vector|empty vector outbox/);
    expect(await f.db.prepare('SELECT count(*) AS count FROM corpus_mutations WHERE payload IS NOT NULL').first()).toEqual({ count: 1 });
    expect((await f.bucket.get(key))!.etag).toBe(before!.etag);
    const status = await (await f.call('/control')).json() as any;
    expect(status.coordinator).toMatchObject({ revision: 1, suspended: true, quiescent: true });
    expect(status).not.toHaveProperty('backupReady'); expect(status).toMatchObject({ cap: 3, submitted: 0, remaining: 3 });
    expect(f.outbound).toEqual([]);
  }, 15_000);

  it('returns 202 while the real Worker drains, suppresses a scheduled invocation, and does not arm failed-work recovery while suspended', async () => {
    const f = await httpFixture(true), running = f.call('/run', {}); await f.sourceEntered;
    const pause = await f.call('/control/suspend', { expectedRevision: 0 }); expect(pause.status).toBe(202);
    expect(await pause.json()).toMatchObject({ submitted: 0, coordinator: { suspended: true, active: 'ingest', alarmAt: null, quiescent: false } });
    expect((await f.call('/control/resume', { expectedRevision: 1 })).status).toBe(409);
    expect((await f.call('/run', {})).status).toBe(409);
    const address = await f.mf.ready, scheduled = await fetch(new URL('/cdn-cgi/local/scheduled?cron=0+12+*+*+*&format=json', address));
    expect(await scheduled.json()).toMatchObject({ outcome: 'ok' });
    expect(f.outbound).toHaveLength(1); f.releaseSource();
    const failed = await running; expect(failed.status).toBe(500); expect(await failed.text()).not.toMatch(/private|503/);
    const state = await (await f.call('/control')).json() as any;
    expect(state).toMatchObject({ submitted: 0, remaining: 3,
      coordinator: { revision: 1, suspended: true, pending: true, failures: 1, alarmAt: null, active: null, quiescent: true } });
    expect(f.outbound).toHaveLength(1);
  }, 15_000);
});
