import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Response as LocalResponse, type MiniflareOptions } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTEMPT_BUDGET_KEY } from '../services/pipeline/attempt-budget';
import { COORDINATOR_ADMISSION_KEY } from '../services/pipeline/single-flight';

const commit = '0507465393c224c0491fc8c17c88340217acc656', date = '2026-10-15', name = 'maintenance-local-proof';
const checkpoint = { pending: true, failures: 2,
  lastError: 'Error: the encoder returned 500 at https://encoder/embed: {"error":"the encoder failed: DEADLINE_EXCEEDED PRIVATE"}' };
const budget = { format: 1, commit, date, parser: 'statutes-v2', cap: 1112, submitted: 784 };
const close: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const finish of close.splice(0).reverse()) await finish(); });
let seedScript = '', maintenanceScript = '';
beforeAll(async () => {
  const bundle = async (contents: string) => (await build({ stdin: { resolveDir: process.cwd(), contents }, bundle: true,
    format: 'esm', platform: 'browser', external: ['cloudflare:*', 'node:*'], write: false })).outputFiles[0]!.text;
  [seedScript, maintenanceScript] = await Promise.all([
    bundle(`import { DurableObject } from 'cloudflare:workers';
      export class PipelineCoordinator extends DurableObject {
        async seed(body) {
          await this.ctx.storage.put('status', body.checkpoint);
          await this.ctx.storage.put('${ATTEMPT_BUDGET_KEY}', body.budget);
          await this.ctx.storage.setAlarm(body.alarmAt);
          return { id: this.ctx.id.toString(), alarmAt: await this.ctx.storage.getAlarm() };
        }
        async alarm() { await this.ctx.storage.put('oldAlarmDelivered', true); }
      }
      export default { async fetch(request, env) {
        const stub = env.PIPELINE_COORDINATOR.get(env.PIPELINE_COORDINATOR.idFromName('statutes-canada'));
        return Response.json(await stub.seed(await request.json()));
      }};`),
    bundle(`import worker from './services/pipeline/staging-maintenance';
      import { PipelineCoordinator as Maintenance } from './services/pipeline/staging-maintenance';
      export class PipelineCoordinator extends Maintenance {
        async fixtureSnapshot() { return { id: this.ctx.id.toString(),
          checkpoint: await this.ctx.storage.get('status'), budget: await this.ctx.storage.get('${ATTEMPT_BUDGET_KEY}'),
          admission: await this.ctx.storage.get('${COORDINATOR_ADMISSION_KEY}'),
          oldAlarmDelivered: await this.ctx.storage.get('oldAlarmDelivered'), alarmAt: await this.ctx.storage.getAlarm() }; }
      }
      export default { ...worker, async fetch(request, env) {
        if (new URL(request.url).pathname === '/fixture-inspection') {
          const stub = env.PIPELINE_COORDINATOR.get(env.PIPELINE_COORDINATOR.idFromName('statutes-canada'));
          return Response.json(await stub.fixtureSnapshot());
        }
        return worker.fetch(request, env);
      }};`),
  ]);
});

describe.skipIf(process.env['CIVICSIGNAL_WORKERD_TESTS'] !== '1')('stop-only maintenance constructor in actual persisted workerd storage', () => {
  it('joins base initialization and closes admission before a due alarm or first RPC can run work, retaining spent budget and checkpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'civicsignal-maintenance-'));
    close.push(() => rm(directory, { recursive: true, force: true }));
    const providerCalls: string[] = [];
    const options = (script: string): MiniflareOptions => ({ telemetry: { enabled: false },
      unsafeDevRegistryPath: join(directory, 'registry'), resourcePersistencePath: join(directory, 'storage'), workers: [{ config: {
        name, compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
        env: {
          PIPELINE_COORDINATOR: { type: 'durable-object', worker: name, exportName: 'PipelineCoordinator' },
          CIVIC_DB: { type: 'd1', id: 'local-maintenance-d1', dev: { remote: false } },
          CORPUS: { type: 'r2', name: 'local-maintenance-r2', dev: { remote: false } },
          ENCODER_SERVICE: { type: 'worker', worker: 'forbidden-provider' },
          VECTORIZE: { type: 'worker', worker: 'forbidden-provider' },
          ...Object.fromEntries(Object.entries({ PIPELINE_PINNED_COMMIT: commit, PIPELINE_PINNED_DATE: date,
            PIPELINE_EMBEDDING_ATTEMPT_CAP: '1112', CORPUS_RETAIN_D1_TEXT: 'false', PIPELINE_SECRET: 'local-only-secret' })
            .map(([key, value]) => [key, { type: 'text' as const, value }])),
        },
        exports: { PipelineCoordinator: { type: 'durable-object', storage: 'sqlite' } },
        manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: script } } },
      }, dev: { outboundService: { type: 'fetcher', handler: async request => {
        providerCalls.push(request.url); return new LocalResponse('Forbidden source request', { status: 503 });
      } } } }, { config: {
        name: 'forbidden-provider', compatibilityDate: '2026-10-22',
        manifest: { mainModule: 'provider.js', modules: { 'provider.js': { type: 'esm', contents:
          `import { WorkerEntrypoint } from 'cloudflare:workers';
          export default class extends WorkerEntrypoint {
            async fetch() { return fetch('https://forbidden.invalid/encoder'); }
            async getByIds() { await fetch('https://forbidden.invalid/vector-read'); throw Error('forbidden'); }
            async upsert() { await fetch('https://forbidden.invalid/vector-write'); throw Error('forbidden'); }
            async deleteByIds() { await fetch('https://forbidden.invalid/vector-delete'); throw Error('forbidden'); }
          }` } } },
      }, dev: { outboundService: { type: 'fetcher', handler: async request => {
        providerCalls.push(request.url); return new LocalResponse('Forbidden provider request', { status: 503 });
      } } } }] });
    let active: Miniflare | undefined = new Miniflare(options(seedScript));
    close.push(async () => { await active?.dispose(); });
    const originalDb = await active.getD1Database('CIVIC_DB', name);
    await originalDb.exec(`CREATE TABLE corpus_mutations(id TEXT,payload TEXT); INSERT INTO corpus_mutations VALUES('pending-vector','preserve');
      CREATE TABLE corpus_state(commit_sha TEXT,parser_version TEXT); INSERT INTO corpus_state VALUES('${commit}',NULL);`);
    const alarmAt = Date.now() + 500;
    const seed = await active.dispatchFetch('https://local.invalid/seed', { method: 'POST', body: JSON.stringify({ checkpoint, budget, alarmAt }) });
    const seeded = await seed.json() as { id: string; alarmAt: number };
    expect(seeded.alarmAt).toBe(alarmAt);
    await active.dispose(); active = undefined;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, alarmAt - Date.now() + 25)));
    expect(Date.now()).toBeGreaterThan(alarmAt);
    active = new Miniflare(options(maintenanceScript));
    const headers = { 'x-pipeline-secret': 'local-only-secret' };
    // The first RPC and a persisted, already-due alarm both encounter the
    // maintenance constructor. Neither is allowed between its two barriers.
    const [statusResponse, deniedRun] = await Promise.all([
      active.dispatchFetch('https://local.invalid/control', { headers }),
      active.dispatchFetch('https://local.invalid/run', { method: 'POST', headers }),
    ]);
    expect(statusResponse.status).toBe(200); expect(deniedRun.status).toBe(409);
    const observed = await statusResponse.json() as any;
    expect(observed).toMatchObject({ coordinatorId: seeded.id, cap: 1112, submitted: 784, remaining: 328,
      coordinator: { revision: 1, suspended: true, pending: true, failures: 2, active: null, queued: 0,
        alarmAt: null, alarmHandlersActive: 0, quiescent: true, lastFailure: { classification: 'encoder-deadline', encoderHttpStatus: 500 } } });
    expect(JSON.stringify(observed)).not.toMatch(/PRIVATE|https:|lastError/);
    const snapshot = async () => await (await active!.dispatchFetch('https://local.invalid/fixture-inspection')).json() as any;
    const state = await snapshot();
    expect(state).toMatchObject({ id: seeded.id, checkpoint, budget,
      admission: { format: 1, revision: 1, suspended: true }, alarmAt: null });
    expect(state.oldAlarmDelivered).toBeUndefined();
    const db = await active.getD1Database('CIVIC_DB', name);
    expect(await db.prepare('SELECT * FROM corpus_mutations').all()).toMatchObject({ results: [{ id: 'pending-vector', payload: 'preserve' }] });
    expect(await db.prepare('SELECT * FROM corpus_state').first()).toEqual({ commit_sha: commit, parser_version: null });
    expect((await (await active.getR2Bucket('CORPUS', name)).list()).objects).toEqual([]);
    const refusedResume = await active.dispatchFetch('https://local.invalid/control/resume', {
      method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1 }),
    });
    expect(refusedResume.status).toBe(409);
    await active.unsafeEvictDurableObject(name, 'PipelineCoordinator', { name: 'statutes-canada' });
    const reconstructed = await (await active.dispatchFetch('https://local.invalid/control', { headers })).json() as any;
    expect(reconstructed.coordinator).toEqual(observed.coordinator);
    expect(await snapshot()).toEqual(state); expect(providerCalls).toEqual([]);
  }, 20_000);
});
