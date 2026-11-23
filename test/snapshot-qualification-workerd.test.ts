import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Response as LocalResponse } from 'miniflare';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { qualificationIdentity } from '../services/snapshot/qualification';
import { qualificationBucket, QUALIFICATION_RECEIPT_BYTES } from '../services/snapshot/qualification-store';
import { manifestKey, SNAPSHOT_PARSER_VERSION } from '../src/ingest/snapshot-format';
import { SnapshotReader } from '../src/ingest/snapshot-source';
import { rowsForFile } from '../src/ingest/corpus-rows';
import { fingerprint } from '../src/ingest/reconcile';
import type { BuildBucket } from '../services/snapshot/builder';
import type { CorpusSnapshot as QualifiedWorkflow } from '../services/snapshot/qualification-worker';
import { archive, controls, event, files, revision, qualificationFixtureData } from './helpers/snapshot-qualification';

const cleanup: (() => Promise<unknown>)[] = [];
type QualifiedParams = Parameters<QualifiedWorkflow['run']>[0]['payload'];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
let script = '', resumeScript = '', canonicalScript = '', bypassScript = '';
beforeAll(async () => {
  const reference = await qualificationFixtureData();
  script = (await build({ entryPoints: ['services/snapshot/qualification-worker.ts'], bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:*', 'node:*'], write: false,
    plugins: [{ name: 'synthetic-qualified-reference-only', setup(build) { build.onLoad({ filter: /qualification-reference-data\.ts$/ }, () => ({ contents: reference.module, loader: 'ts' })); } }],
  })).outputFiles[0]!.text;
  resumeScript = (await build({ entryPoints: ['services/snapshot/qualification-worker.ts'], bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:*', 'node:*'], write: false,
    plugins: [{ name: 'native-admission-checkpoint-fixture', setup(build) {
      build.onLoad({ filter: /qualification-reference-data\.ts$/ }, () => ({ contents: reference.module, loader: 'ts' }));
      build.onLoad({ filter: /qualification-worker\.ts$/ }, async args => {
        const source = await readFile(args.path, 'utf8'), wait = 'const bucket = qualificationBucket(runtime.bucket, q.prefix);', marker = 'await assertQualificationReceipt(runtime.bucket,';
        if (source.split(wait).length !== 2 || source.split(marker).length !== 3) throw new Error('Admission fixture seam changed.');
        return { contents: source.replace(/(await assertQualificationReceipt\(runtime\.bucket,[^\n]+;)/g, '$1\n      await fetch("https://qualification-fixture.invalid/admission-check");')
          .replace(wait, 'await fetch("https://qualification-fixture.invalid/admission-checkpoint-complete");\n    await step.waitForEvent("fixture admission checkpoint wait", { type: "fixture-resume", timeout: "1 minute" });\n    ' + wait), loader: 'ts' };
      });
    } }],
  })).outputFiles[0]!.text;
  canonicalScript = (await build({ entryPoints: ['services/snapshot/worker.ts'], bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:*', 'node:*'], write: false })).outputFiles[0]!.text;
  bypassScript = (await build({ entryPoints: ['services/snapshot/worker.ts'], bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:*', 'node:*'], write: false,
    plugins: [{ name: 'test-only-tar-guard-bypass', setup(build) { build.onLoad({ filter: /archive-source\.ts$/ }, async args => {
      const source = await readFile(args.path, 'utf8'), needle = 'const checked = checkedTarChunks(chunks());';
      if (source.split(needle).length !== 2) throw new Error('Negative-control guard location changed.');
      return { contents: source.replace(needle, 'const checked = chunks();'), loader: 'ts' };
    }); } }],
  })).outputFiles[0]!.text;
});
async function fixture(options: { headFailure?: boolean; authoritativeFailure?: boolean; archiveFailure?: boolean; changedHead?: boolean; invalidStage?: boolean; canonicalTruncated?: boolean; truncated?: boolean; bypassFraming?: boolean; admissionResume?: boolean; legacyDeadline?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'civicsignal-qualified-snapshot-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const name = 'snapshot-qualified-local', outbound: { url: string; redirect: string; authorization: boolean }[] = [];
  const q = await qualificationIdentity(controls);
  const mf = new Miniflare({ telemetry: { enabled: false }, unsafeTriggerHandlers: true,
    unsafeDevRegistryPath: join(directory, 'registry'), workers: [{ config: {
      name, compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
      env: {
        CORPUS: { type: 'r2', name: 'snapshot-qualified-fixture', dev: { remote: false } },
        SNAPSHOT: { type: 'workflow', name, worker: name, exportName: 'CorpusSnapshot' },
        ...Object.fromEntries(Object.entries({ ...controls, ...(options.invalidStage ? { SNAPSHOT_STAGE_ID: 'production-refused' } : {}),
          ...(options.legacyDeadline ? { SNAPSHOT_QUALIFICATION_DEADLINE: undefined } : {}) }).filter(([, value]) => value !== undefined).map(([key, value]) => [key, { type: 'text' as const, value: value! }])),
      },
      exports: { CorpusSnapshot: { type: 'workflow', name } },
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: options.canonicalTruncated ? (options.bypassFraming ? bypassScript : canonicalScript) : options.admissionResume ? resumeScript : script } } },
    }, dev: { outboundService: { type: 'fetcher', handler: async request => {
      const url = new URL(request.url);
      outbound.push({ url: url.href, redirect: request.redirect, authorization: request.headers.has('authorization') });
      if (url.origin === 'https://qualification-fixture.invalid') return new LocalResponse('synthetic-checkpoint-marker');
      if (url.origin === 'https://api.github.com' && url.pathname === '/repos/justicecanada/laws-lois-xml/commits' && url.searchParams.get('per_page') === '1' && ['main', revision.commit].includes(url.searchParams.get('sha') ?? '')) {
        const failed = options.headFailure || options.authoritativeFailure && url.searchParams.get('sha') === revision.commit;
        return new LocalResponse(failed ? 'private upstream body' : JSON.stringify([{ sha: options.changedHead ? 'f'.repeat(40) : revision.commit, commit: { committer: { date: revision.date + 'T00:00:00Z' } } }]), { status: failed ? 503 : 200 });
      }
      if (url.href === 'https://codeload.github.com/justicecanada/laws-lois-xml/tar.gz/' + revision.commit) return new LocalResponse(options.archiveFailure ? 'private archive body' : options.canonicalTruncated || options.truncated ? new Uint8Array(gzipSync(gunzipSync(archive()).subarray(0, 1543))) : archive(), { status: options.archiveFailure ? 503 : 200 });
      throw new Error('Unexpected local fixture request; real networking is forbidden.');
    } } } }] });
  cleanup.push(() => mf.dispose());
  const bucket = await mf.getR2Bucket('CORPUS', name), bindings = await mf.getBindings<{ SNAPSHOT: Workflow<QualifiedParams> }>(name);
  const canonical = manifestKey(revision.commit, SNAPSHOT_PARSER_VERSION);
  if (!options.canonicalTruncated) await bucket.put(canonical, 'known-good-canonical-backup-bytes');
  await bucket.put('snapshots/statutes-v2/another-retained-revision.index.jsonl', 'retained-other-revision');
  const baseline = (await bucket.get(canonical))!;
  const address = await mf.ready;
  const scheduled = async (actual = event) => {
    const response = await fetch(new URL(`/cdn-cgi/local/scheduled?cron=${encodeURIComponent(actual.cron)}&time=${actual.scheduledTime}&format=json`, address).toString());
    return await response.json() as { outcome: string; noRetry: boolean };
  };
  return { mf, bucket, workflow: bindings.SNAPSHOT, outbound, q, canonical, baseline, scheduled };
}

describe.skipIf(process.env['CIVICSIGNAL_WORKERD_TESTS'] !== '1')('scheduled first publication in actual local workerd', () => {
  it('requires a new runtime deadline before R2/source admission and sets native noRetry before refusal', async () => {
    const f = await fixture({ legacyDeadline: true }), result = await f.scheduled();
    expect(result.outcome).toBe('exception'); expect(result.noRetry).toBe(true);
    expect(f.outbound).toEqual([]); expect((await f.bucket.list({ prefix: 'qualifications/' })).objects).toEqual([]);
    await expect(f.workflow.get(f.q.instanceId)).rejects.toThrow('instance.not_found');
  }, 30000);
  it('reuses the durable admission checkpoint across native pause/resume', async () => {
    const f = await fixture({ admissionResume: true }); expect((await f.scheduled()).outcome).toBe('ok');
    const instance = await f.workflow.get(f.q.instanceId);
    // The local implementation reports running while waitForEvent is pending.
    // This marker occurs only after the admission step's persisted result.
    await vi.waitFor(() => expect(f.outbound.some(call => call.url.endsWith('/admission-checkpoint-complete'))).toBe(true), { timeout: 10000, interval: 20 });
    await instance.pause(); expect((await instance.status()).status).toBe('paused'); await instance.resume();
    await instance.sendEvent({ type: 'fixture-resume', payload: { synthetic: true } });
    await vi.waitFor(async () => expect((await instance.status()).status).toBe('complete'), { timeout: 15000, interval: 25 });
    expect(f.outbound.filter(call => call.url === 'https://qualification-fixture.invalid/admission-check')).toHaveLength(2);
    expect(f.outbound.filter(call => call.url.startsWith('https://api.github.com') || call.url.startsWith('https://codeload.github.com'))).toHaveLength(3);
  }, 30000);
  it('publishes a fresh qualified snapshot from the native scheduled entry and joins duplicate events without touching canonical bytes', async () => {
    const f = await fixture(), key = f.q.prefix + f.canonical;
    expect(await f.bucket.get(key)).toBeNull();
    for (const result of await Promise.all([f.scheduled(), f.scheduled()])) { expect(result.outcome).toBe('ok'); expect(result.noRetry).toBe(true); }
    const instance = await f.workflow.get(f.q.instanceId);
    await vi.waitFor(async () => expect((await instance.status()).status).toBe('complete'), { timeout: 15000, interval: 50 });
    const status = await instance.status();
    expect(status.output).toMatchObject({ commit: revision.commit, count: 2, qualification: f.q.digest, namespace: f.q.prefix, instanceId: f.q.instanceId });
    const scoped = qualificationBucket(f.bucket as unknown as BuildBucket, f.q.prefix);
    const reader = new SnapshotReader(scoped, revision.commit, { parser: SNAPSHOT_PARSER_VERSION }), index = await reader.index();
    const rows = await reader.rows([...index.values()]);
    expect(rows.map(row => [row.id, fingerprint(row)]).sort()).toEqual(files.flatMap(file => rowsForFile({ ...file, date: revision.date })).map(row => [row.id, fingerprint(row)]).sort());
    const manifestBefore = (await f.bucket.get(key))!;
    await f.scheduled();
    expect(f.outbound).toHaveLength(3); expect(f.outbound.every(call => !call.authorization)).toBe(true);
    expect(f.outbound.filter(call => call.url.startsWith('https://codeload.github.com'))).toHaveLength(1);
    expect((await f.bucket.get(key))!.etag).toBe(manifestBefore.etag);
    expect((await f.bucket.get(f.canonical))!.etag).toBe(f.baseline.etag);
    expect(await (await f.bucket.get(f.canonical))!.text()).toBe('known-good-canonical-backup-bytes');
    expect(await (await f.bucket.get('snapshots/statutes-v2/another-retained-revision.index.jsonl'))!.text()).toBe('retained-other-revision');
    const artifacts = (await f.bucket.list({ prefix: f.q.prefix })).objects;
    expect(artifacts.filter(object => object.key.includes('/.snapshot-staging/'))).toEqual([]);
    expect(artifacts.filter(object => object.key.includes('/attempts/'))).toHaveLength(3);
    for (const object of artifacts.filter(object => /\/(attempts|diagnostics)\//.test(object.key))) expect(object.size).toBeLessThanOrEqual(QUALIFICATION_RECEIPT_BYTES);
    expect(JSON.parse(await (await f.bucket.get(f.q.prefix + 'diagnostics/published.json'))!.text())).toMatchObject({ count: 2, existing: false });
    await expect(f.workflow.get(`${SNAPSHOT_PARSER_VERSION}-${revision.commit}`)).rejects.toThrow('instance.not_found');
  }, 30000);
  it('retains bounded preclaim rejection evidence for a nonexact native controller and spends no source attempt', async () => {
    const f = await fixture(); expect((await f.scheduled({ ...event, scheduledTime: event.scheduledTime + 1 })).outcome).toBe('exception');
    const rejection = await f.bucket.get(f.q.prefix + 'diagnostics/rejected.json');
    expect(rejection).not.toBeNull(); expect(JSON.parse(await rejection!.text())).toMatchObject({ observed: { cron: event.cron, scheduledTime: event.scheduledTime + 1 } });
    expect(f.outbound).toEqual([]); expect((await f.bucket.list({ prefix: f.q.prefix + 'attempts/' })).objects).toEqual([]);
    await expect(f.workflow.get(f.q.instanceId)).rejects.toThrow('instance.not_found');
  }, 30000);
  it('rejects invalid stage configuration before any R2 selection or source call', async () => {
    const f = await fixture({ invalidStage: true }); expect((await f.scheduled()).outcome).toBe('exception');
    expect(f.outbound).toEqual([]); expect((await f.bucket.list({ prefix: 'qualifications/' })).objects).toEqual([]);
  }, 30000);
  it.each([{ headFailure: true }, { changedHead: true }])('spends at most one discovery request on failure and never starts a Workflow: %j', async options => {
    const f = await fixture(options); expect((await f.scheduled()).outcome).toBe('exception'); await f.scheduled();
    expect(f.outbound).toHaveLength(1); expect(await f.bucket.get(f.q.prefix + f.canonical)).toBeNull();
    const failed = await f.bucket.get(f.q.prefix + 'diagnostics/failed.json'); expect(failed).not.toBeNull();
    const failureText = await failed!.text(); expect(failureText).not.toContain('private');
    if ('headFailure' in options) expect(JSON.parse(failureText)).toMatchObject({ sourceFailure: { code: 'http-refused', status: 503 } });
    else expect(JSON.parse(failureText)).not.toHaveProperty('sourceFailure');
    await expect(f.workflow.get(f.q.instanceId)).rejects.toThrow('instance.not_found');
  }, 30000);
  it('preserves safe authoritative source failure facts in the native Workflow error without another request', async () => {
    const f = await fixture({ authoritativeFailure: true }); expect((await f.scheduled()).outcome).toBe('ok');
    const instance = await f.workflow.get(f.q.instanceId);
    await vi.waitFor(async () => expect((await instance.status()).status).toBe('errored'), { timeout: 15000, interval: 50 });
    const status = await instance.status();
    expect(status.error?.message).toContain('"code":"http-refused"'); expect(status.error?.message).toContain('"status":503');
    expect(JSON.stringify(status.error)).not.toMatch(/private|https:/);
    await f.scheduled(); expect(f.outbound).toHaveLength(2);
    expect((await f.bucket.list({ prefix: f.q.prefix + 'attempts/' })).objects).toHaveLength(2);
    expect(await f.bucket.get(f.q.prefix + f.canonical)).toBeNull();
  }, 30000);
  it.each([{ archiveFailure: true }, { truncated: true }])('keeps durable attempt limits after an archive failure and actual Workflow restart: %j', async options => {
    const f = await fixture(options); expect((await f.scheduled()).outcome).toBe('ok');
    const instance = await f.workflow.get(f.q.instanceId);
    await vi.waitFor(async () => expect((await instance.status()).status).toBe('errored'), { timeout: 15000, interval: 50 });
    const failure = (await instance.status()).error;
    expect(failure?.message).toContain('"code":"' + ('archiveFailure' in options ? 'http-refused' : 'invalid-response') + '"');
    expect(failure?.message).toContain('"status":' + ('archiveFailure' in options ? 503 : 200));
    expect(JSON.stringify(failure)).not.toMatch(/private|https:/);
    expect(f.outbound).toHaveLength(3); expect(await f.bucket.get(f.q.prefix + f.canonical)).toBeNull();
    await instance.restart();
    await vi.waitFor(async () => expect((await instance.status()).status).toBe('errored'), { timeout: 15000, interval: 50 });
    await f.scheduled(); expect(f.outbound).toHaveLength(3); expect((await f.bucket.get(f.canonical))!.etag).toBe(f.baseline.etag);
    expect((await f.bucket.list({ prefix: f.q.prefix + 'attempts/' })).objects).toHaveLength(3);
  }, 30000);
  it('refuses direct Workflow creation without the scheduled durable admission even with the correct ID/params', async () => {
    const f = await fixture();
    const instance = await f.workflow.create({ id: f.q.instanceId, params: { revision, qualification: f.q.digest } });
    await vi.waitFor(async () => expect((await instance.status()).status).toBe('errored'), { timeout: 15000, interval: 50 });
    expect(f.outbound).toEqual([]); expect(await f.bucket.get(f.q.prefix + f.canonical)).toBeNull();
  }, 30000);
  it('never publishes a partial canonical snapshot from a valid gzip containing truncated tar', async () => {
    const f = await fixture({ canonicalTruncated: true }), id = `${SNAPSHOT_PARSER_VERSION}-${revision.commit}`;
    // Installed Miniflare test API, not a production method: skip wall-clock
    // retry delays only. Every real callback and all 3 retries still execute.
    const local = f.workflow as Workflow & { unsafeGetInstanceModifier(id: string): Promise<{ disableRetryDelays(): Promise<void> }> };
    await (await local.unsafeGetInstanceModifier(id)).disableRetryDelays();
    expect((await f.scheduled()).outcome).toBe('ok');
    const instance = await f.workflow.get(id);
    await vi.waitFor(async () => expect((await instance.status()).status).toBe('errored'), { timeout: 10000, interval: 20 });
    expect(f.outbound.filter(call => call.url.startsWith('https://codeload'))).toHaveLength(4);
    expect(await f.bucket.get(f.canonical)).toBeNull();
  }, 30000);
  it('demonstrates the canonical regression would fail if only the framing guard were bypassed', async () => {
    const f = await fixture({ canonicalTruncated: true, bypassFraming: true }); expect((await f.scheduled()).outcome).toBe('ok');
    const instance = await f.workflow.get(`${SNAPSHOT_PARSER_VERSION}-${revision.commit}`);
    await vi.waitFor(async () => expect((await instance.status()).status).toBe('complete'), { timeout: 10000, interval: 20 });
    expect((await instance.status()).output).toMatchObject({ count: 1 });
    expect(await f.bucket.get(f.canonical)).not.toBeNull();
  }, 30000);
});
