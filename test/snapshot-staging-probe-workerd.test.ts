import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Response as LocalResponse } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { SNAPSHOT_STAGE_ID, SNAPSHOT_STAGE_COMMIT, SNAPSHOT_STAGE_DATE, SNAPSHOT_PROBE_PREFIX,
  SNAPSHOT_PROBE_MARKER, SNAPSHOT_PROBE_MAX_BYTES, probeEventPrefix } from '../services/snapshot/staging-probe-receipts';
import { manifestKey, parseManifest, SNAPSHOT_PARSER_VERSION } from '../src/ingest/snapshot-format';

const event = { cron: '25 4 23 10 *', scheduledTime: Date.parse('2026-10-23T04:25:00Z') };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
let script = '',productionScript='';
beforeAll(async () => {
  const output = await build({ entryPoints: ['services/snapshot/staging-probe.ts'], bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:*', 'node:*'], write: false });
  script = output.outputFiles[0]!.text;
  productionScript=(await build({entryPoints:['services/snapshot/worker.ts'],bundle:true,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:*','node:*'],write:false})).outputFiles[0]!.text;
});

function archive(): Uint8Array<ArrayBuffer> {
  const entries: Buffer[] = [];
  for (const [path, id, text] of [['eng/acts/T-1.xml', '100', 'A test rule.'], ['fra/lois/T-1.xml', '200', 'Une règle de test.']]) {
    const content = Buffer.from(`<Statute xmlns:lims="http://justice.gc.ca/lims"><Identification><ShortTitle>Test Act</ShortTitle><Chapter><ConsolidatedNumber>T-1</ConsolidatedNumber></Chapter></Identification><Body><Section lims:id="${id}"><Label>1</Label><Text>${text}</Text></Section></Body></Statute>`);
    const header = Buffer.alloc(512);
    header.write(`laws-lois-xml-fixture/${path}`); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    entries.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return new Uint8Array(gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])));
}

async function fixture(options: { invalidStage?: boolean; sourceFailure?: boolean; changedHead?: boolean; missingManifest?: boolean; production?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'civicsignal-snapshot-probe-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const name = 'snapshot-probe-local';
  const outbound: string[] = [];
  const tarball = archive();
  const mf = new Miniflare({ telemetry: { enabled: false }, unsafeTriggerHandlers: true,
    unsafeDevRegistryPath: join(directory, 'registry'), workers: [{
    config: {
      name, compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
      env: {
        CORPUS: { type: 'r2', name: 'snapshot-probe-fixture', dev: { remote: false } },
        SNAPSHOT: { type: 'workflow', name, worker: name, exportName: 'CorpusSnapshot' },
        ...Object.fromEntries(Object.entries({ SNAPSHOT_STAGE_ID: options.invalidStage ? 'production-is-forbidden' : SNAPSHOT_STAGE_ID,
          SNAPSHOT_PINNED_COMMIT: SNAPSHOT_STAGE_COMMIT, SNAPSHOT_PINNED_DATE: SNAPSHOT_STAGE_DATE, SNAPSHOT_PROBE_CRON:event.cron, SNAPSHOT_PROBE_TIME:String(event.scheduledTime) }).map(([key, value]) => [key, { type: 'text' as const, value }])),
      },
      exports: { CorpusSnapshot: { type: 'workflow', name } },
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: options.production ? productionScript : script } } },
    },
    dev: { outboundService: { type: 'fetcher', handler: async (request) => {
      const url = new URL(request.url); outbound.push(url.href);
      if (url.host === 'api.github.com' && url.pathname.endsWith('/commits') && url.searchParams.get('per_page') === '1' &&
        ['main', SNAPSHOT_STAGE_COMMIT].includes(url.searchParams.get('sha') ?? '')) {
        return new LocalResponse(options.sourceFailure ? 'private upstream response must never be exposed' : JSON.stringify([{ sha: options.changedHead ? 'f'.repeat(40) : SNAPSHOT_STAGE_COMMIT,
          commit: { committer: { date: SNAPSHOT_STAGE_DATE + 'T00:00:00Z' } } }]), { status: options.sourceFailure ? 503 : 200 });
      }
      if (options.production && url.host === 'codeload.github.com' && url.pathname === '/justicecanada/laws-lois-xml/tar.gz/' + SNAPSHOT_STAGE_COMMIT) return new LocalResponse(tarball);
      throw new Error('Unexpected outbound call; all external networking is forbidden in this local fixture.');
    } } },
  }] });
  cleanup.push(() => mf.dispose());
  const bucket = await mf.getR2Bucket('CORPUS', name);
  const bindings = await mf.getBindings<{ SNAPSHOT: Workflow }>(name);
  if(!options.missingManifest&&!options.production)await bucket.put(manifestKey(SNAPSHOT_STAGE_COMMIT,SNAPSHOT_PARSER_VERSION),JSON.stringify({syntheticExistingPublication:true}));
  const address = await mf.ready;
  const scheduled = async (nominal=event) => {
    const url = new URL(`/cdn-cgi/local/scheduled?cron=${encodeURIComponent(nominal.cron)}&time=${nominal.scheduledTime}&format=json`, address);
    const response = await fetch(url.toString());
    return { status: response.status, body: await response.json() as { outcome: string } };
  };
  return { mf, bucket, workflow: bindings.SNAPSHOT, outbound, scheduled };
}

describe.skipIf(process.env['CIVICSIGNAL_WORKERD_TESTS'] !== '1')('claimed snapshot stage probe in actual local workerd', () => {
  it('keeps health free of I/O and claims one source call across native concurrent R2 events', async () => {
    const f=await fixture(),key=manifestKey(SNAPSHOT_STAGE_COMMIT,SNAPSHOT_PARSER_VERSION),before=(await f.bucket.get(key))!;
    const response=await f.mf.dispatchFetch('https://local-snapshot.invalid/health');expect(response.status).toBe(200);expect(await response.json()).toMatchObject({marker:SNAPSHOT_PROBE_MARKER,approvedCron:event.cron,approvedTime:event.scheduledTime});expect(f.outbound).toEqual([]);
    for(const result of await Promise.all([f.scheduled(),f.scheduled()]))expect(result).toMatchObject({status:200,body:{outcome:'ok'}});
    await f.scheduled();const prefix=await probeEventPrefix(event),entered=(await f.bucket.get(prefix+'entered.json'))!;
    expect(entered).not.toBeNull();expect((await f.bucket.get(prefix+'completed.json'))).not.toBeNull();expect(f.outbound).toHaveLength(1);expect(f.outbound[0]).toContain('/commits?sha=main&per_page=1');expect((await f.bucket.get(key))!.etag).toBe(before.etag);
    await expect(f.workflow.get(`${SNAPSHOT_PARSER_VERSION}-${SNAPSHOT_STAGE_COMMIT}`)).rejects.toThrow('instance.not_found');
    for(const o of (await f.bucket.list({prefix:SNAPSHOT_PROBE_PREFIX})).objects)expect(o.size).toBeLessThanOrEqual(SNAPSHOT_PROBE_MAX_BYTES);
  },30000);
  it.each([{sourceFailure:true},{changedHead:true},{missingManifest:true}])('never creates a Workflow/files after guarded failure: %j',async options=>{
    const f=await fixture(options);expect((await f.scheduled()).body.outcome).toBe('exception');await f.scheduled();expect(f.outbound).toHaveLength(1);const prefix=await probeEventPrefix(event);expect(await f.bucket.get(prefix+'entered.json')).not.toBeNull();const failed=await f.bucket.get(prefix+'failed.json');expect(failed).not.toBeNull();expect(await failed!.text()).not.toContain('private upstream');expect(await f.bucket.get(prefix+'completed.json')).toBeNull();await expect(f.workflow.get(`${SNAPSHOT_PARSER_VERSION}-${SNAPSHOT_STAGE_COMMIT}`)).rejects.toThrow('instance.not_found');
  },30000);
  it('rejects wrong stage and unapproved events before all source/receipt work',async()=>{
    const invalid=await fixture({invalidStage:true});expect((await invalid.mf.dispatchFetch('https://local-snapshot.invalid/health')).status).toBe(503);expect((await invalid.scheduled()).body.outcome).toBe('exception');expect(invalid.outbound).toEqual([]);expect((await invalid.bucket.list({prefix:SNAPSHOT_PROBE_PREFIX})).objects).toEqual([]);
    const f=await fixture();expect((await f.scheduled({...event,scheduledTime:event.scheduledTime+60000})).body.outcome).toBe('exception');expect(f.outbound).toEqual([]);expect((await f.bucket.list({prefix:SNAPSHOT_PROBE_PREFIX})).objects).toEqual([]);
  },30000);
  it('preserves production default Workflow creation/publication through the shared path',async()=>{
    const f=await fixture({production:true});expect((await f.scheduled()).body.outcome).toBe('ok');const instance=await f.workflow.get(`${SNAPSHOT_PARSER_VERSION}-${SNAPSHOT_STAGE_COMMIT}`);await vi.waitFor(async()=>expect((await instance.status()).status).toBe('complete'),{interval:50,timeout:15000});const manifest=parseManifest(await(await f.bucket.get(manifestKey(SNAPSHOT_STAGE_COMMIT,SNAPSHOT_PARSER_VERSION)))!.text());expect(manifest.rows.count).toBe(2);expect(f.outbound.filter(url=>url.startsWith('https://codeload.github.com/'))).toHaveLength(1);
  },30000);
});
