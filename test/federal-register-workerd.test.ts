import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare } from 'miniflare';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';

const receipt = z.looseObject({ instanceId: z.string(), status: z.string() });

const entry = `
import { WorkerEntrypoint } from 'cloudflare:workers';
import register from './docs/evidence/2026-11-23/federal-public-service-sources.csv';
import { encode, prefix, registerEndpoints } from './services/federal-register/inventory';
import { textSha256 } from './src/corpora/text-store';
export { default, FederalDiscoveryRefresh } from './services/federal-register/worker';
export class Collector extends WorkerEntrypoint {
  async fetch(request) {
    const { scheduledTime, registerKey, registerSha256 } = await request.json();
    const archivedRegister = await this.env.ARCHIVE.get(registerKey);
    if (await archivedRegister.text() !== register) throw new Error('Register mismatch');
    const expected = registerEndpoints(register);
    const sources = new Map();
    const partial = new Date(scheduledTime).getUTCDate() === 26;
    for (const row of expected) {
      if (sources.has(row.url)) continue;
      const item = { url:row.url,finalUrl:row.url,observedAt:new Date(scheduledTime).toISOString() };
      if (partial && row.url === 'https://open.canada.ca/en/proactive-disclosure') {
        sources.set(row.url,{...item,status:403,failure:'HTTP 403'});
        continue;
      }
      const original = row.format === 'json' ? JSON.stringify({ url:row.url }) : '<html><h1>Federal register</h1></html>';
      const bytes = encode(original);
      const sha256 = await textSha256(bytes);
      const key = prefix + '/sources/' + sha256 + '.' + row.format;
      await this.env.ARCHIVE.put(key,bytes);
      sources.set(row.url,{...item,status:200,key,sha256,bytes:bytes.length});
    }
    const endpoints = expected.map(({series,endpoint,url,format}) => {
      const page = sources.get(url);
      const identity = {series,endpoint,url};
      if (page.failure) return {...identity,ok:false,reason:page.failure};
      const inventory = format === 'json'
        ? {kind:'dataset-resources',title:'Fixture',resources:[{id:'r1',url,format:null,titles:null,languages:null,lastModified:null}]}
        : {kind:'index-links',title:'Fixture',links:[url]};
      return {...identity,ok:true,inventory};
    });
    const json = JSON.stringify({schemaVersion:1,scheduledTime,registerSha256,endpoints,sources:[...sources.values()]});
    const bytes = encode(json);
    const sha256 = await textSha256(bytes);
    const key = prefix + '/inventories/' + sha256 + '.json';
    await this.env.ARCHIVE.put(key,bytes);
    return Response.json({key,sha256,bytes:bytes.length});
  }
}`;

it.skipIf(process.env.CIVICSIGNAL_WORKERD_TESTS !== '1')(
  'publishes scheduled register attempts and preserves the latest complete catalogue across partial and stale runs', async () => {
    const name = 'federal-register-local';
    const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd() }, bundle:true,
      loader:{'.csv':'text'}, format:'esm', platform:'browser', external:['node:*','cloudflare:*'], write:false });
    const directory = await mkdtemp(join(tmpdir(),'federal-register-workerd-'));
    const mf = new Miniflare({ unsafeTriggerHandlers:true, telemetry:{enabled:false},
      unsafeDevRegistryPath:join(directory,'registry'), resourcePersistencePath:join(directory,'state'),
      workers:[{ config:{ name, compatibilityDate:'2026-10-22', compatibilityFlags:['nodejs_compat'],
        env:{
          ARCHIVE:{type:'r2',name,dev:{remote:false}},
          REFRESH:{type:'workflow',name,worker:name,exportName:'FederalDiscoveryRefresh'},
          COLLECTOR:{type:'worker',worker:name,exportName:'Collector'},
        },
        exports:{FederalDiscoveryRefresh:{type:'workflow',name}},
        manifest:{mainModule:'worker.js',modules:{'worker.js':{type:'esm',contents:bundle.outputFiles[0].text}}},
      }}],
    });
    const base = 'weekly/federal-discovery';
    try {
      const archive = await mf.getR2Bucket('ARCHIVE',name);
      const { REFRESH } = await mf.getBindings<{ REFRESH: Workflow }>(name);
      const address = await mf.ready;
      async function run(day: number) {
        const time = Date.UTC(2026,10,day,16,15);
        const id = 'federal-discovery-' + time;
        const response = await fetch(new URL(`/cdn-cgi/local/scheduled?cron=15+16+*+*+4&time=${time}&format=json`,address));
        expect(await response.json()).toMatchObject({outcome:'ok'});
        const instance = await REFRESH.get(id);
        await vi.waitFor(async () => {
          const status = await instance.status();
          expect(status.status, JSON.stringify(status.error)).toBe('complete');
        },{timeout:30000,interval:200});
        return receipt.parse(await (await archive.get(`${base}/runs/${id}.json`))?.json());
      }
      const first = await run(25);
      expect(first).toMatchObject({status:'complete',counts:{series:18,endpoints:28,uniqueUrls:27,verified:28}});
      const partial = await run(26);
      expect(partial).toMatchObject({status:'partial',counts:{failed:2,verified:26}});
      expect(await (await archive.get(base + '/latest-complete.json'))?.json()).toMatchObject({instanceId:first.instanceId});
      expect(await (await archive.get(base + '/latest-attempt.json'))?.json()).toMatchObject({instanceId:partial.instanceId,status:'partial'});
      expect(await run(24)).toMatchObject({status:'complete'});
      expect(await (await archive.get(base + '/latest-complete.json'))?.json()).toMatchObject({instanceId:first.instanceId});
      expect(await (await archive.get(base + '/latest-attempt.json'))?.json()).toMatchObject({instanceId:partial.instanceId});
    } finally {
      await mf.dispose();
      await rm(directory,{recursive:true,force:true});
    }
  },45000);
