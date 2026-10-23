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
let script = '';
beforeAll(async () => {
  const output = await build({ entryPoints: ['services/snapshot/staging-probe.ts'], bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:*', 'node:*'], write: false });
  script = output.outputFiles[0]!.text;
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

async function fixture(options: { invalidStage?: boolean; sourceFailure?: boolean } = {}) {
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
          SNAPSHOT_PINNED_COMMIT: SNAPSHOT_STAGE_COMMIT, SNAPSHOT_PINNED_DATE: SNAPSHOT_STAGE_DATE }).map(([key, value]) => [key, { type: 'text' as const, value }])),
      },
      exports: { CorpusSnapshot: { type: 'workflow', name } },
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: script } } },
    },
    dev: { outboundService: { type: 'fetcher', handler: async (request) => {
      const url = new URL(request.url); outbound.push(url.href);
      if (url.host === 'api.github.com' && url.pathname.endsWith('/commits') && url.searchParams.get('per_page') === '1' &&
        ['main', SNAPSHOT_STAGE_COMMIT].includes(url.searchParams.get('sha') ?? '')) {
        return new LocalResponse(options.sourceFailure ? 'private upstream response must never be exposed' : JSON.stringify([{ sha: SNAPSHOT_STAGE_COMMIT,
          commit: { committer: { date: SNAPSHOT_STAGE_DATE + 'T00:00:00Z' } } }]), { status: options.sourceFailure ? 503 : 200 });
      }
      if (url.host === 'codeload.github.com' && url.pathname === '/justicecanada/laws-lois-xml/tar.gz/' + SNAPSHOT_STAGE_COMMIT) return new LocalResponse(tarball);
      throw new Error('Unexpected outbound call; all external networking is forbidden in this local fixture.');
    } } },
  }] });
  cleanup.push(() => mf.dispose());
  const bucket = await mf.getR2Bucket('CORPUS', name);
  const bindings = await mf.getBindings<{ SNAPSHOT: Workflow }>(name);
  const address = await mf.ready;
  const scheduled = async () => {
    const url = new URL(`/cdn-cgi/local/scheduled?cron=${encodeURIComponent(event.cron)}&time=${event.scheduledTime}&format=json`, address);
    const response = await fetch(url.toString());
    return { status: response.status, body: await response.json() as { outcome: string } };
  };
  return { mf, bucket, workflow: bindings.SNAPSHOT, outbound, scheduled };
}

describe.skipIf(process.env['CIVICSIGNAL_WORKERD_TESTS'] !== '1')('snapshot stage probe in actual local workerd', () => {
  it('runs /health without writes/outbound work, then dispatches the real scheduled handler and Workflow exactly once across replay', async () => {
    const f = await fixture();
    const response = await f.mf.dispatchFetch('https://local-snapshot.invalid/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ marker: SNAPSHOT_PROBE_MARKER, stageId: SNAPSHOT_STAGE_ID, commit: SNAPSHOT_STAGE_COMMIT, parser: SNAPSHOT_PARSER_VERSION });
    expect(f.outbound).toEqual([]); expect((await f.bucket.list()).objects).toEqual([]);
    for (const result of await Promise.all([f.scheduled(), f.scheduled()])) {
      expect(result).toMatchObject({ status: 200, body: { outcome: 'ok' } });
    }
    const prefix = await probeEventPrefix(event);
    const before = await f.bucket.get(prefix + 'entered.json');
    expect(before).not.toBeNull();
    const entered = await before!.text();
    const uploaded = before!.uploaded.toISOString();
    expect(await (await f.bucket.get(prefix + 'completed.json'))!.text()).toContain('scheduled handler returned');
    const instance = await f.workflow.get(`${SNAPSHOT_PARSER_VERSION}-${SNAPSHOT_STAGE_COMMIT}`);
    await vi.waitFor(async () => { expect((await instance.status()).status).toBe('complete'); }, { interval: 50, timeout: 15_000 });
    const key = manifestKey(SNAPSHOT_STAGE_COMMIT, SNAPSHOT_PARSER_VERSION);
    const manifestObject = await f.bucket.get(key);
    const manifest = parseManifest(await manifestObject!.text());
    expect(manifest.rows.count).toBe(2);
    expect(manifest.parser).toBe(SNAPSHOT_PARSER_VERSION);
    expect((await f.bucket.get(manifest.index.key))!.size).toBe(manifest.index.bytes);
    expect(f.outbound.filter((url) => url.startsWith('https://codeload.github.com/'))).toHaveLength(1);
    expect(await f.scheduled()).toMatchObject({ status: 200, body: { outcome: 'ok' } });
    const replay = await f.bucket.get(prefix + 'entered.json');
    expect(await replay!.text()).toBe(entered); expect(replay!.uploaded.toISOString()).toBe(uploaded);
    expect((await f.bucket.list({ prefix: SNAPSHOT_PROBE_PREFIX })).objects).toHaveLength(2);
    expect((await f.bucket.get(key))!.etag).toBe(manifestObject!.etag);
    expect(f.outbound.filter((url) => url.startsWith('https://codeload.github.com/'))).toHaveLength(1);
    for (const object of (await f.bucket.list({ prefix: SNAPSHOT_PROBE_PREFIX })).objects) expect(object.size).toBeLessThanOrEqual(SNAPSHOT_PROBE_MAX_BYTES);
  }, 30_000);

  it('records an actual source failure without creating a Workflow or exposing exception/source text', async () => {
    const f = await fixture({ sourceFailure: true });
    expect((await f.scheduled()).body.outcome).toBe('exception');
    const prefix = await probeEventPrefix(event);
    const objects = (await f.bucket.list({ prefix })).objects;
    expect(objects.map((object) => object.key.split('/').at(-1))).toEqual(['entered.json', 'failed.json']);
    for (const object of objects) expect(await (await f.bucket.get(object.key))!.text()).not.toMatch(/private|503|repository returned/);
    await expect(f.workflow.get(`${SNAPSHOT_PARSER_VERSION}-${SNAPSHOT_STAGE_COMMIT}`)).rejects.toThrow('instance.not_found');
  }, 30_000);

  it('rejects a wrong stage identity before diagnostic writes, source reads or Workflow creation', async () => {
    const f = await fixture({ invalidStage: true });
    expect((await f.mf.dispatchFetch('https://local-snapshot.invalid/health')).status).toBe(503);
    expect((await f.scheduled()).body.outcome).toBe('exception');
    expect(f.outbound).toEqual([]); expect((await f.bucket.list()).objects).toEqual([]);
  }, 30_000);
});
