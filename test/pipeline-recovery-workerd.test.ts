import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Response as LocalResponse, type MiniflareOptions } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STAGE_RECOVERY_PLAN as plan } from '../services/pipeline/staging-recovery-plan';

const close: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const finish of close.splice(0).reverse()) await finish(); });
const old = { format: 1, commit: plan.commit, date: plan.date, parser: plan.parser, cap: 1112, submitted: 1112 };
const checkpoint = { pending: true, failures: 7, lastError: 'Error: embedding attempt budget exhausted: 1112/1112 submitted, 32 requested' };
let seed = '', probe = '', actualEntry = '';
beforeAll(async () => {
  const bundle = async (contents: string) => (await build({ stdin: { resolveDir: process.cwd(), contents }, bundle: true,
    format: 'esm', platform: 'browser', external: ['cloudflare:*', 'node:*'], write: false })).outputFiles[0]!.text;
  [seed, probe, actualEntry] = await Promise.all([
    bundle(`import {DurableObject} from 'cloudflare:workers';
      export class PipelineCoordinator extends DurableObject {
        async seed(value) {
          await this.ctx.storage.put('embedding-attempt-budget-v1', value.budget);
          await this.ctx.storage.put('coordinator-admission-v1', {format:1,revision:1,suspended:true});
          await this.ctx.storage.put('status', value.checkpoint);
          await this.ctx.storage.put('fixture-outbox', {payload:'unchanged'});
          if (value.fault) await this.ctx.storage.put('fault', value.fault);
          return this.raw();
        }
        async raw() { return {budget:await this.ctx.storage.get('embedding-attempt-budget-v1'),
          admission:await this.ctx.storage.get('coordinator-admission-v1'), checkpoint:await this.ctx.storage.get('status'),
          outbox:await this.ctx.storage.get('fixture-outbox'), alarmAt:await this.ctx.storage.getAlarm()}; }
      }
      export default {async fetch(request,env){const s=env.PIPELINE_COORDINATOR.get(env.PIPELINE_COORDINATOR.idFromName('statutes-canada'));
        return Response.json(request.method==='POST'?await s.seed(await request.json()):await s.raw());}};`),
    bundle(`import {DurableObject} from 'cloudflare:workers';
      import {DurableAttemptBudget,ATTEMPT_BUDGET_KEY} from './services/pipeline/attempt-budget';
      import {DurableSingleFlight} from './services/pipeline/single-flight';
      import {STAGE_RECOVERY_PLAN as plan} from './services/pipeline/staging-recovery-plan';
      import {httpEncoder} from './src/ingest/encoder-client';
      export class PipelineCoordinator extends DurableObject {
        instanceId=crypto.randomUUID();
        constructor(ctx,env){super(ctx,env);
          const storage={get:k=>ctx.storage.get(k),delete:k=>ctx.storage.delete(k),getAlarm:()=>ctx.storage.getAlarm(),
            setAlarm:t=>ctx.storage.setAlarm(t),deleteAlarm:()=>ctx.storage.deleteAlarm(),put:async(k,v)=>{
              const fault=await ctx.storage.get('fault');
              const applies=k===ATTEMPT_BUDGET_KEY&&v.cap===1752&&v.submitted===1112;
              if(k==='coordinator-admission-v1'&&v.suspended&&fault==='pause-before'){
                await ctx.storage.delete('fault');await ctx.storage.sync();throw Error('fixture pause did not commit');}
              if(applies&&(fault==='before'||fault==='after')){await ctx.storage.delete('fault');await ctx.storage.sync();if(fault==='before')throw Error('fixture precommit');}
              await ctx.storage.put(k,v);if(applies&&fault==='after'){await ctx.storage.sync();throw Error('fixture lost acknowledgement');}
            }};
          // Fixture identity injection only: the actual entry is separately
          // tested to refuse this local namespace. Budget/storage code is real.
          this.budget=new DurableAttemptBudget(storage,{commit:plan.commit,date:plan.date,parser:plan.parser,cap:1752},
            {coordinatorId:plan.coordinatorId,mode:'extend'});
          this.runner=new DurableSingleFlight(storage,async()=>{
            const encoder=httpEncoder({url:'https://fixture.invalid',send:request=>this.budget.sendEncoder(request,{
              head:async()=>({commit:plan.commit,date:plan.date}),snapshot:async()=>({commit:plan.commit,date:plan.date,parser:plan.parser,index:{digest:plan.indexDigest,sha256:'a'.repeat(64)}}),
              send:request=>fetch(request)})});
            await encoder.embed(Array.from({length:32},()=>({title:'Act',text:'Fixture'})));return {remaining:false};
          },Date.now,{suspendOnFailure:true});
          ctx.blockConcurrencyWhile(async()=>{await this.budget.initialize();await this.runner.initialize();});
          ctx.blockConcurrencyWhile(async()=>{await this.budget.initialize();const before=await this.runner.status();
            if(!before.suspended&&before.pending)await this.runner.suspend(before.revision);});
        }
        async state(){return {instanceId:this.instanceId,budget:await this.budget.status(),coordinator:await this.runner.status(),outbox:await this.ctx.storage.get('fixture-outbox')};}
        async resume(r){await this.runner.resume(r);return this.state();}
        async attempts(size){const results=await Promise.allSettled(Array.from({length:21},()=>this.budget.sendEncoder(
          new Request('https://fixture.invalid/embed',{method:'POST',body:JSON.stringify({texts:Array(size).fill('text'),titles:Array(size).fill('title')})}),
          {head:async()=>({commit:plan.commit,date:plan.date}),snapshot:async()=>({commit:plan.commit,date:plan.date,parser:plan.parser,index:{digest:plan.indexDigest,sha256:'a'.repeat(64)}}),
           send:async()=>new Response('local fixture only')})));
          return {fulfilled:results.filter(r=>r.status==='fulfilled').length,state:await this.state()};}
        async run(){return this.runner.run();}
        async alarm(){return this.runner.alarm();}
      }
      export default {async fetch(request,env){try{
        const s=env.PIPELINE_COORDINATOR.get(env.PIPELINE_COORDINATOR.idFromName('statutes-canada'));
        const p=new URL(request.url).pathname;
        return Response.json(p==='/resume'?await s.resume((await request.json()).revision):p==='/attempts'?await s.attempts((await request.json()).size):p==='/run'?await s.run():await s.state());
      }catch{return Response.json({error:'fixture operation failed'},{status:500});}}};`),
    bundle(`export {default,PipelineCoordinator} from './services/pipeline/staging-recovery';`),
  ]);
});

interface State { instanceId: string; budget: { submitted: number; recovery: { reservedCalls: number } };
  coordinator: { revision: number; suspended: boolean; failures: number; pending: boolean; active: string | null; quiescent: boolean } }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'civicsignal-recovery-'));
  close.push(() => rm(directory, { recursive: true, force: true }));
  const name = 'recovery-fixture'; let failEncoder = true, providerCalls = 0;
  const options = (contents: string): MiniflareOptions => ({ telemetry: { enabled: false },
    unsafeDevRegistryPath: join(directory, 'registry'), resourcePersistencePath: join(directory, 'storage'), workers: [{ config: {
      name, compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
      env: { PIPELINE_COORDINATOR: { type: 'durable-object', worker: name, exportName: 'PipelineCoordinator' },
        ...Object.fromEntries(Object.entries({ PIPELINE_PINNED_COMMIT: plan.commit, PIPELINE_PINNED_DATE: plan.date,
          PIPELINE_EMBEDDING_ATTEMPT_CAP: '1752', CORPUS_RETAIN_D1_TEXT: 'false', PIPELINE_SECRET: 'local-secret' })
          .map(([key, value]) => [key, { type: 'text' as const, value }])) },
      exports: { PipelineCoordinator: { type: 'durable-object', storage: 'sqlite' } },
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents } } },
    }, dev: { outboundService: { type: 'fetcher', handler: async request => {
      if (request.url !== 'https://fixture.invalid/embed') throw Error('External networking forbidden.');
      providerCalls++;
      return new LocalResponse(failEncoder ? 'PRIVATE fixture failure' : JSON.stringify({ vectors: Array.from({ length: 32 }, () => [0.1]) }),
        { status: failEncoder ? 503 : 200 });
    } } } }] });
  let active = new Miniflare(options(seed));
  close.push(() => active.dispose());
  const call = (path = '/state', body?: unknown) => active.dispatchFetch(`https://local.invalid${path}`,
    { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { 'x-pipeline-secret': 'local-secret' } });
  const switchTo = async (script: string) => { await active.dispose(); active = new Miniflare(options(script)); await active.ready; };
  const state = async () => await (await call()).json() as State;
  const seedState = async (fault?: string) => { const response = await call('/seed', { budget: old, checkpoint, fault }); expect(response.status).toBe(200); };
  return { call, state, seedState, switchTo, evict: () => active.unsafeEvictDurableObject(name, 'PipelineCoordinator', { name: 'statutes-canada' }),
    success: () => { failEncoder = false; }, providerCalls: () => providerCalls };
}

describe.skipIf(process.env['CIVICSIGNAL_WORKERD_TESTS'] !== '1')('stage recovery policy in real local workerd storage', () => {
  it('stays paused on grant/reconstruction, explicitly resumes, then pauses the first failed continuation without automatic retries', async () => {
    const f = await fixture(); await f.seedState(); await f.switchTo(probe);
    const initial = await f.state();
    expect(initial).toMatchObject({ budget: { cap: 1752, submitted: 1112, recovery: { reservedCalls: 0 } },
      coordinator: { revision: 1, suspended: true, failures: 7, pending: true, alarmAt: null, quiescent: true } });
    expect(f.providerCalls()).toBe(0);
    await f.evict(); const paused = await f.state(); expect(paused.instanceId).not.toBe(initial.instanceId);
    expect(paused.budget).toEqual(initial.budget); expect(paused.coordinator).toEqual(initial.coordinator);
    const resumed = await f.call('/resume', { revision: 1 }); expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ coordinator: { revision: 2, suspended: false, pending: true, failures: 7 } });
    await vi.waitFor(async () => { expect((await f.state()).coordinator.failures).toBe(8); }, { timeout: 5000, interval: 50 });
    const failed = await f.state();
    expect(failed).toMatchObject({ budget: { submitted: 1144, recovery: { reservedCalls: 1 } },
      coordinator: { revision: 3, suspended: true, alarmAt: null, quiescent: true } });
    expect(JSON.stringify(failed)).not.toContain('PRIVATE'); expect(f.providerCalls()).toBe(1);
    await f.evict(); expect((await f.state()).budget).toEqual(failed.budget); expect(f.providerCalls()).toBe(1);
    f.success(); expect((await f.call('/resume', { revision: 3 })).status).toBe(200);
    await vi.waitFor(async () => { expect((await f.state()).coordinator.pending).toBe(false); }, { timeout: 5000, interval: 50 });
    expect(await f.state()).toMatchObject({ budget: { submitted: 1176, recovery: { reservedCalls: 2 } },
      coordinator: { revision: 4, suspended: false, failures: 0, pending: false } });
    expect(f.providerCalls()).toBe(2);
  }, 20_000);

  it.each(['before', 'after'])('survives a real persisted extension fault %s commit with exactly one retained grant', async fault => {
    const f = await fixture(); await f.seedState(fault); await f.switchTo(probe);
    expect((await f.call()).status).toBe(500);
    await f.switchTo(seed);
    const raw = await (await f.call()).json() as { budget: { cap: number; submitted: number } };
    expect(raw.budget).toMatchObject({ cap: fault === 'after' ? 1752 : 1112, submitted: 1112 });
    await f.switchTo(probe);
    expect(await f.state()).toMatchObject({ budget: { cap: 1752, submitted: 1112, recovery: { reservedCalls: 0 } },
      coordinator: { revision: 1, suspended: true, alarmAt: null } });
    expect(f.providerCalls()).toBe(0);
  }, 20_000);

  it('the actual candidate entry refuses this different local object before extending or sending', async () => {
    const f = await fixture(); await f.seedState(); await f.switchTo(actualEntry);
    expect((await f.call('/control')).status).toBe(500);
    await f.switchTo(seed);
    expect(await (await f.call()).json()).toMatchObject({ budget: old, checkpoint,
      admission: { format: 1, revision: 1, suspended: true }, alarmAt: null });
    expect(f.providerCalls()).toBe(0);
  }, 20_000);

  it.each([1, 32])('enforces the real durable call ceiling with 21 competing %s-document reservations', async size => {
    const f = await fixture(); await f.seedState(); await f.switchTo(probe);
    const response = await f.call('/attempts', { size }); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ fulfilled: 20,
      state: { budget: { submitted: 1112 + size * 20, recovery: { reservedCalls: 20 } } } });
    await f.evict(); expect((await f.state()).budget).toMatchObject({ submitted: 1112 + size * 20, recovery: { reservedCalls: 20 } });
    expect(f.providerCalls()).toBe(0);
  }, 20_000);

  it('the verify-only stop policy refuses a legacy grant and accepts only an already-persisted exact extension', async () => {
    const verifyOnly = probe.replace('mode: "extend"', 'mode: "verify"'); expect(verifyOnly).not.toBe(probe);
    const f = await fixture(); await f.seedState(); await f.switchTo(verifyOnly);
    expect((await f.call()).status).toBe(500);
    await f.switchTo(seed); expect(await (await f.call()).json()).toMatchObject({ budget: old });
    await f.switchTo(probe); const granted = await f.state();
    await f.switchTo(verifyOnly); expect((await f.state()).budget).toEqual(granted.budget);
    expect(f.providerCalls()).toBe(0);
  }, 20_000);

  it('pauses open pending work on reconstruction after a pause write never committed, with no second provider call', async () => {
    const f = await fixture(); await f.seedState('pause-before'); await f.switchTo(probe);
    expect((await f.call('/resume', { revision: 1 })).status).toBe(200);
    await vi.waitFor(async () => { const state = await f.state();
      expect(state.coordinator.active).toBeNull(); expect(state.budget.recovery.reservedCalls).toBe(1);
    }, { timeout: 5000, interval: 50 });
    expect(await f.state()).toMatchObject({ coordinator: { revision: 2, suspended: false, failures: 7, pending: true },
      budget: { submitted: 1144, recovery: { reservedCalls: 1 } } });
    expect(f.providerCalls()).toBe(1);
    await f.evict();
    expect(await f.state()).toMatchObject({ coordinator: { revision: 3, suspended: true, failures: 7, pending: true,
      alarmAt: null, quiescent: true }, budget: { submitted: 1144, recovery: { reservedCalls: 1 } } });
    expect(f.providerCalls()).toBe(1);
  }, 20_000);
});
