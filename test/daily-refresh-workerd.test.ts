import { build } from 'esbuild';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';

const fixture = `
import { WorkflowEntrypoint, WorkerEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { sourceInstance, receiptKey } from './services/daily/report';
import { retainHouseFailure } from './services/house/failure';
export { default, DailyRefresh } from './services/daily/worker';

class Catalogue extends WorkflowEntrypoint {
  async run(event, step) {
    const source = this.source;
    const { scheduledTime } = event.payload;
    const instanceId = sourceInstance(source, scheduledTime);
    const key = receiptKey(source, instanceId);
    const bucket = source === 'consultations' ? this.env.CONSULTATION_ARCHIVE : this.env.ARCHIVE;
    await step.do('fixture publication', () => bucket.put(key, JSON.stringify({
      instanceId, observedAt: new Date(scheduledTime).toISOString(), published: { revision: 'a'.repeat(64) },
    })).then(() => key));
    return { receiptKey: key };
  }
}
export class Consultations extends Catalogue { source = 'consultations'; }
export class Nserc extends Catalogue { source = 'nserc'; }
export class Esdc extends Catalogue { source = 'esdc'; }
export class House extends WorkflowEntrypoint {
  async run(event, step) {
    if (new Date(event.payload.scheduledTime).getUTCDate() === 27) {
      const key = receiptKey('house', event.instanceId);
      await step.do('fixture House publication', async () => {
        const sha256 = '2'.repeat(64);
        await this.env.ARCHIVE.put(key, JSON.stringify({
          instanceId: event.instanceId, scheduledTime: event.payload.scheduledTime,
          packetRef: { key: 'committee/house-calls/inventories/' + sha256 + '.json', sha256, bytes: 120 },
          published: { observedAt: new Date(event.payload.scheduledTime).toISOString(),
            cutoff: '2026-11-25T08:33:25+00:00', packetSha256: sha256 },
        }));
        return key;
      });
      return { receiptKey: key };
    }
    await step.do('retain exact refusal', () => retainHouseFailure(
      this.env.ARCHIVE, event.instanceId, event.payload.scheduledTime,
      { phase:'acquisition',code:'publisher-http',status:403,url:'https://www.ourcommons.ca/Committees/en/Participate' }));
    throw new NonRetryableError('Required House publisher refused access.');
  }
}
export class Verifier extends WorkerEntrypoint {
  async verify(input) {
    await this.env.ARCHIVE.put('verifier-input.json',JSON.stringify(input));
    return { passed:9,failed:0,skipped:0,cases:[] };
  }
}`;

const name = 'daily-local';
const bindings = { DAILY: 'DailyRefresh', CONSULTATIONS: 'Consultations', NSERC: 'Nserc', ESDC: 'Esdc', HOUSE: 'House' };
const cutoff = '2026-11-25T08:33:25+00:00';
const baseTime = Date.parse('2026-11-26T00:15:00Z');
const baseId = 'house-calls-' + baseTime;
const observedAt = '2026-11-26T00:16:34.215000Z';
const hash = '1'.repeat(64);
const packetRef = { key: `committee/house-calls/inventories/${hash}.json`,sha256:hash,bytes:100 };

it.skipIf(process.env.CIVICSIGNAL_WORKERD_TESTS !== '1')(
  'qualifies both fresh and preserved House publications through the scheduled Workflows and report', async () => {
    const bundle = await build({ stdin: { contents: fixture, resolveDir: process.cwd(), loader: 'ts' }, bundle: true,
      format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*','cloudflare:*'], write: false });
    const directory = await mkdtemp(join(tmpdir(),'daily-refresh-workerd-'));
    const mf = new Miniflare({ unsafeTriggerHandlers: true, telemetry: { enabled: false },
      unsafeDevRegistryPath: join(directory,'registry'), resourcePersistencePath: join(directory,'state'),
      workers: [{ config: { name, compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
        env: {
          ...Object.fromEntries(Object.entries(bindings).map(([binding, exportName]) =>
            [binding, { type:'workflow' as const, name:binding, worker:name, exportName }])),
          COMMITTEE_DB: { type:'d1',id:'committee',dev:{remote:false} },
          ARCHIVE: { type:'r2',name:'archive',dev:{remote:false} },
          CONSULTATION_ARCHIVE: { type:'r2',name:'consultation-archive',dev:{remote:false} },
          VERIFY: { type:'worker',worker:name,exportName:'Verifier' },
        },
        exports: Object.fromEntries(Object.entries(bindings).map(([binding, exportName]) => [exportName,{type:'workflow' as const,name:binding}])),
        manifest: { mainModule:'worker.js',modules:{ 'worker.js':{type:'esm',contents:bundle.outputFiles[0].text} } },
      } }],
    });
    try {
      const db = await mf.getD1Database('COMMITTEE_DB',name);
      for (const path of ['preview/committees/migrations/0001_committee_preview.sql','services/house/migrations/0001_call_observations.sql']) {
        const ddl = await readFile(path,'utf8');
        await db.batch(ddl.replace(/^--.*$/gm,'').split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
      }
      await db.batch([
        db.prepare("INSERT INTO cc_snapshot VALUES ('45-1',?)").bind(cutoff),
        db.prepare("INSERT INTO cc_house_runs VALUES (?,'45-1',?,?,?,?,?)").bind(baseId,baseTime,observedAt,hash,hash,'{}'),
        db.prepare("INSERT INTO cc_records SELECT '45-1','call','en','call','house',null,'A study',null,'indexed','{}',null"),
      ]);
      const bucket = await mf.getR2Bucket('ARCHIVE',name);
      await bucket.put(`committee/house-calls/runs/${baseId}.json`, JSON.stringify({
        instanceId:baseId,scheduledTime:baseTime,packetRef,published:{observedAt,cutoff,packetSha256:hash},
      }));
      const { DAILY } = await mf.getBindings<{DAILY:Workflow}>(name);
      const address = await mf.ready;
      async function occurrence(time: number) {
        const refresh = await fetch(new URL(`/cdn-cgi/local/scheduled?cron=30+15+*+*+*&time=${time}&format=json`,address));
        expect(await refresh.json()).toMatchObject({ outcome:'ok' });
        const id = 'daily-refresh-' + time;
        const instance = await DAILY.get(id);
        await vi.waitFor(async () => {
          const status = await instance.status();
          expect(status.status,JSON.stringify(status.error)).toBe('complete');
        },{ timeout:85000,interval:300 });
        return bucket.get(`daily/runs/${id}.json`);
      }
      const time = Date.parse('2026-11-26T15:30:00Z');
      const report = await occurrence(time);
      expect(await report?.json()).toMatchObject({
        status:'degraded',houseVerificationBasis:'last-good',
        sources:[
          {source:'consultations',status:'published'},
          {source:'nserc',status:'published'},
          {source:'esdc',status:'published'},
          {source:'house',status:'failed',failure:{status:403,phase:'acquisition',code:'publisher-http'}},
        ],
        housePreservation:{unchanged:true,receiptRetained:true,lastGood:{instanceId:baseId,packetRef}},
      });
      expect(await (await bucket.get('verifier-input.json'))?.json()).toEqual({
        consultations:'consultations-'+time,nserc:'nserc-'+time,esdc:'esdc-'+time,house:{observedAt,cutoff,packetRef},
      });
      expect(await db.prepare('SELECT count(*) AS n FROM cc_house_runs').first('n')).toBe(1);
      const next = time + 86400000;
      const nextReport = await occurrence(next);
      expect(await nextReport?.json()).toMatchObject({
        status:'complete',houseVerificationBasis:'current',housePreservation:null,
        sources:['consultations','nserc','esdc','house'].map(source=>({source,status:'published'})),
      });
      expect(await (await bucket.get('verifier-input.json'))?.json()).toMatchObject({
        house:{observedAt:new Date(next).toISOString(),packetRef:{sha256:'2'.repeat(64)}},
      });
    } finally {
      await mf.dispose();
      await rm(directory,{recursive:true,force:true});
    }
  },100000);
