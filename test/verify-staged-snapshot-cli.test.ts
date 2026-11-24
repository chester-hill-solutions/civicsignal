import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import creation from '../docs/evidence/2026-11-22/november-workflow-creation.json';
import { verifyStagedR2Admission, verifyStagedSnapshotMain } from '../scripts/verify-staged-snapshot';
import { QUALIFICATION_STAGE_ID, qualificationIdentity } from '../services/snapshot/qualification';

const dirs: string[] = [];
const account = 'https://api.cloudflare.com/client/v4/accounts/ad5ec479b9a421faa2ed06c3d1c2b23a/r2/buckets/civicsignal-v1-stage-corpus-20261022/objects/';
const commit = '855cdfc65207a6906c414e09a77d7f93267c5356';
const scheduledAt = '2030-11-23T03:47:00.000Z';
const runtimeDeadline = '2030-11-23T05:47:00.000Z';
const credential = { CLOUDFLARE_API_TOKEN: 'fixture-read-token' };
const canonicalFile = 'docs/evidence/2026-10-31/reference-snapshot-manifest.json';
afterEach(async () => {
  vi.useRealTimers();
  for (const directory of dirs.splice(0)) await rm(directory, { force: true, recursive: true });
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'snapshot-verifier-cli-'));
  dirs.push(dir);
  const qualification = await qualificationIdentity({ SNAPSHOT_STAGE_ID: QUALIFICATION_STAGE_ID,
    SNAPSHOT_PINNED_COMMIT: commit, SNAPSHOT_PINNED_DATE: '2026-11-16', SNAPSHOT_QUALIFICATION_ID: 'nov16-20301123-0347',
    SNAPSHOT_QUALIFICATION_CRON: '47 3 23 11 *', SNAPSHOT_QUALIFICATION_TIME: String(Date.parse(scheduledAt)),
    SNAPSHOT_QUALIFICATION_DEADLINE: String(Date.parse(runtimeDeadline)) });
  const packet = { target: creation.worker, bundle: { bytes: creation.bootstrap.bundleBytes, sha256: creation.bootstrap.bundleSha256 },
    publication: { bucket: 'civicsignal-v1-stage-corpus-20261022', window: { scheduledAt }, runtimeDeadline, qualification,
      referenceManifestSha256: '43fdb9961b0980769552df1993e106beba8f3a354ecf9bd3fbd11091ea25ba34' } };
  const path = join(dir, 'prepared-stage.json');
  return { packet, path, args: ['--staging', '--packet', path], admissionArgs: ['--staging-admission', '--packet', path],
    async save() { await writeFile(path, JSON.stringify(packet)); } };
}

const emptyListing = (info: Record<string, unknown> = {}) => ({ success: true, result: [],
  result_info: { is_truncated: false, ...info } });
const absent = () => Response.json({ success: false, result: null, errors: [{ code: 10007 }] }, { status: 404 });

describe('November hosted snapshot verifier CLI', () => {
  it('reads the canonical manifest and the exact qualification key using literal slashes and GET only', async () => {
    const f = await fixture();
    await f.save();
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(await readFile(canonicalFile, 'utf8')))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(verifyStagedSnapshotMain(f.args, credential, send)).rejects.toThrow();
    const expected = [`${account}snapshots/statutes-v2/0507465393c224c0491fc8c17c88340217acc656.manifest.json`,
      `${account}${f.packet.publication.qualification.prefix}snapshots/statutes-v2/${commit}.manifest.json`];
    expect(send.mock.calls.map(([url]) => url)).toEqual(expected);
    for (const [, init] of send.mock.calls) expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit',
      headers: { Authorization: 'Bearer fixture-read-token' } });
  });

  it('rejects a substituted qualification namespace before sending a request', async () => {
    const f = await fixture();
    f.packet.publication.qualification.prefix = 'snapshots/statutes-v2/';
    await f.save();
    const send = vi.fn<typeof fetch>();
    await expect(verifyStagedSnapshotMain(f.args, credential, send)).rejects.toThrow('qualification identity differs');
    expect(send).not.toHaveBeenCalled();
  });

  it('requires an explicit read credential for staging', async () => {
    const f = await fixture();
    await f.save();
    const send = vi.fn<typeof fetch>();
    await expect(verifyStagedSnapshotMain(f.args, {}, send)).rejects.toThrow('staging R2 read token');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('staging R2 admission CLI', () => {
  it('reads one ungrouped page, independently verifies the missing key, and checks the exact canonical manifest', async () => {
    const f = await fixture();
    await f.save();
    const { qualification, bucket } = f.packet.publication;
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...emptyListing({ cursor: '', delimited: [], count: 0, per_page: 1 }), errors: [], messages: [] }))
      .mockResolvedValueOnce(absent()).mockResolvedValueOnce(new Response(await readFile(canonicalFile, 'utf8')));
    await expect(verifyStagedSnapshotMain(f.admissionArgs, credential, send)).resolves.toMatchObject({
      scope: 'staging-r2-admission', bucket, qualification: qualification.digest, namespace: qualification.prefix,
      prefixEmpty: true, manifestAbsent: true, reads: { requests: 3 },
      canonical: { bytes: 44627, sha256: '78c979e9a36ecd2215e4c16c9b0ab6df3ad7dfe6f5efe20addf4f471ac3e3e1e' },
    });
    const [list, manifest, canonical] = send.mock.calls.map(([url]) => String(url));
    const listUrl = new URL(list ?? '');
    expect(listUrl.origin + listUrl.pathname).toBe(account.slice(0, -1));
    expect([...listUrl.searchParams.entries()]).toEqual([['prefix', qualification.prefix], ['per_page', '1']]);
    expect(manifest).toBe(`${account}${qualification.prefix}snapshots/statutes-v2/${commit}.manifest.json`);
    expect(canonical).toBe(`${account}snapshots/statutes-v2/0507465393c224c0491fc8c17c88340217acc656.manifest.json`);
    for (const [, init] of send.mock.calls) expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit',
      headers: { Authorization: 'Bearer fixture-read-token', 'Cache-Control': 'no-cache, no-store' } });
  });

  it.each([
    ['truncated page', emptyListing({ is_truncated: true })],
    ['truncation omitted', { ...emptyListing(), result_info: {} }],
    ['result_info omitted', { success: true, result: [] }],
    ['bare array', []],
    ['nonempty page', { ...emptyListing(), result: [{ key: 'a' }] }],
    ['failed envelope', { ...emptyListing(), success: false }],
    ['cursor', emptyListing({ cursor: 'another-page' })],
    ['delimited groups', emptyListing({ delimited: ['qualifications/'] })],
    ['other prefixes', emptyListing({ prefixes: ['qualifications/'] })],
  ])('rejects a %s before requesting any object', async (_name, envelope) => {
    const f = await fixture();
    await f.save();
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(envelope));
    await expect(verifyStagedSnapshotMain(f.admissionArgs, credential, send)).rejects.toThrow('LIST_ENVELOPE');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([302, 403])('refuses HTTP %i from the object list', async status => {
    const f = await fixture();
    await f.save();
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status }));
    await expect(verifyStagedSnapshotMain(f.admissionArgs, credential, send)).rejects.toThrow(`LIST_HTTP_${status}`);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, { success: false, errors: [{ code: 10006 }] }, 'MANIFEST_ENVELOPE'],
    [404, { success: false, errors: [{ code: 10007 }, { code: 10006 }] }, 'MANIFEST_ENVELOPE'],
    [404, { success: true, errors: [{ code: 10007 }] }, 'MANIFEST_ENVELOPE'],
    [403, { success: false, errors: [{ code: 10007 }] }, 'MANIFEST_HTTP_403'],
    [200, { success: false, errors: [{ code: 10007 }] }, 'MANIFEST_HTTP_200'],
  ] as const)('requires a genuine missing object response (HTTP %i, %j)', async (status, envelope, failure) => {
    const f = await fixture();
    await f.save();
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(emptyListing())).mockResolvedValueOnce(Response.json(envelope, { status }));
    await expect(verifyStagedSnapshotMain(f.admissionArgs, credential, send)).rejects.toThrow(failure);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects canonical drift even when the canonical size still matches', async () => {
    const f = await fixture();
    await f.save();
    const content = await readFile(canonicalFile, 'utf8');
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(emptyListing()))
      .mockResolvedValueOnce(absent()).mockResolvedValueOnce(new Response(' ' + content.slice(1)));
    await expect(verifyStagedSnapshotMain(f.admissionArgs, credential, send)).rejects.toThrow('CANONICAL_DRIFT');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['LIST', 0, 200, 16 * 1024], ['MANIFEST', 1, 404, 16 * 1024], ['CANONICAL', 2, 200, 44627],
  ] as const)('cancels a streaming response beyond the %s byte limit', async (step, prior, status, limit) => {
    const f = await fixture();
    await f.save();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(limit)); controller.enqueue(new Uint8Array(1)); }, cancel,
    });
    const send = vi.fn<typeof fetch>();
    if (prior >= 1) send.mockResolvedValueOnce(Response.json(emptyListing()));
    if (prior === 2) send.mockResolvedValueOnce(absent());
    send.mockResolvedValueOnce(new Response(body, { status }));
    await expect(verifyStagedSnapshotMain(f.admissionArgs, credential, send)).rejects.toThrow(`${step}_SIZE`);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(prior + 1);
  });

  it('rejects packet drift and a missing credential before contacting the provider', async () => {
    const f = await fixture();
    const send = vi.fn<typeof fetch>();
    await f.save();
    await expect(verifyStagedSnapshotMain(f.admissionArgs, {}, send)).rejects.toThrow('staging R2 read token');
    f.packet.publication.qualification.prefix = 'snapshots/statutes-v2/';
    await f.save();
    await expect(verifyStagedSnapshotMain(f.admissionArgs, credential, send)).rejects.toThrow('qualification identity differs');
    f.packet.publication.bucket = 'unreviewed-bucket';
    await f.save();
    await expect(verifyStagedSnapshotMain(f.admissionArgs, credential, send)).rejects.toThrow('does not match the November staging resources');
    expect(send).not.toHaveBeenCalled();
  });

  it('aborts a stalled request after ten seconds', async () => {
    const f = await fixture();
    await f.save();
    vi.useFakeTimers();
    let started!: (signal: AbortSignal | null | undefined) => void;
    const waiting = new Promise<AbortSignal | null | undefined>(resolve => { started = resolve; });
    const send = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      started(init?.signal);
      return new Promise(() => undefined);
    });
    const expectation = expect(verifyStagedSnapshotMain(f.admissionArgs, credential, send)).rejects.toThrow('LIST_DEADLINE');
    const signal = await waiting;
    await vi.advanceTimersByTimeAsync(10_000);
    await expectation;
    expect(signal?.aborted).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('enforces the total deadline even as individual requests succeed', async () => {
    const f = await fixture();
    await f.save();
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    const started: ((signal: AbortSignal | null | undefined) => void)[] = [];
    const waiting = [0, 1, 2].map(index => new Promise<AbortSignal | null | undefined>(resolve => { started[index] = resolve; }));
    const send = vi.fn<typeof fetch>();
    const delay = (index: number, response: Response) => (_url: string | URL | Request, init?: RequestInit) => {
      started[index]?.(init?.signal);
      return new Promise<Response>(resolve => { setTimeout(() => resolve(response), 9000); });
    };
    send.mockImplementationOnce(delay(0, Response.json(emptyListing()))).mockImplementationOnce(delay(1, absent()))
      .mockImplementationOnce(delay(2, new Response(null, { status: 200 })));
    const expectation = expect(verifyStagedSnapshotMain(f.admissionArgs, credential, send)).rejects.toThrow('CANONICAL_DEADLINE');
    await waiting[0];
    await vi.advanceTimersByTimeAsync(9000);
    await waiting[1];
    await vi.advanceTimersByTimeAsync(9000);
    const signal = await waiting[2];
    await vi.advanceTimersByTimeAsync(7000);
    await expectation;
    expect(signal?.aborted).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('aborts a stalled response body when the caller cancels admission', async () => {
    const f = await fixture();
    await f.save();
    const parent = new AbortController();
    const cancel = vi.fn();
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const body = new ReadableStream<Uint8Array>({ pull() { started(); }, cancel }, { highWaterMark: 0 });
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(body));
    const result = verifyStagedR2Admission(f.path, credential.CLOUDFLARE_API_TOKEN, send, parent.signal);
    const expectAbort = expect(result).rejects.toThrow('LIST_DEADLINE');
    await waiting;
    parent.abort();
    await expectAbort;
    expect(send.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
