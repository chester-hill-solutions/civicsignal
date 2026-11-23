import { describe, expect, it } from 'vitest';
import { exportPausedVectors, planVectorBackup, vectorBackupOrigin, type VectorBackupEvent, type VectorBackupRequest, type VectorBackupSend } from '../scripts/lib/vector-export-client';
import { indexDigest, indexKey, manifestKey, SNAPSHOT_PARSER_VERSION as parser } from '../src/ingest/snapshot-format';
import { commit, coordinatorId, origin, revision, secret, vectorBackupFixture, expectedCalls } from './helpers/vector-backup';

async function fixture(count = 3) {
  const f = await vectorBackupFixture(count), events: VectorBackupEvent[] = [], requests: { url: string; init: VectorBackupRequest }[] = [];
  const normal: VectorBackupSend = async (url, init) => {
    requests.push({ url, init });
    const intent = events.at(-1); expect(intent).toMatchObject({ kind: 'intent', request: requests.length });
    if (url.endsWith('/control')) return f.json(f.control, false);
    const body = JSON.parse(init.body!); return f.json(body.action === 'manifest' ? f.manifest : f.receipts[body.part]);
  };
  const run = (send = normal, extra: Partial<Parameters<typeof exportPausedVectors>[1]> = {}) => exportPausedVectors(f.plan,
    { url: origin, coordinatorId, suspensionRevision: revision, secret, send, record: e => { events.push(e); }, ...extra });
  return { ...f, events, requests, normal, run };
}
describe('suspended vector export client', () => {
  it('derives exact fixed partitions from the complete verified local index and binds every response', async () => {
    const f = await fixture(10_003), result = await f.run();
    expect(f.plan.parts.map(p => ({ from: p.from, count: p.count, digest: p.partDigest }))).toEqual([
      { from: 0, count: 10_000, digest: indexDigest(f.entries.slice(0, 10_000)) },
      { from: 10_000, count: 3, digest: indexDigest(f.entries.slice(10_000)) },
    ]);
    expect(result.requests).toBe(5); expect(result.maxRequests).toBe(5); expect(result.manifest).toEqual(f.manifest);
    expect(f.requests.map(r => new URL(r.url).pathname)).toEqual(expectedCalls(f.plan));
    for (const { url, init } of f.requests) {
      expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.headers['x-pipeline-secret']).toBe(secret);
      if (url.endsWith('/vectors')) expect(init.headers['X-Pipeline-Suspension-Revision']).toBe(String(revision));
      expect(url).not.toMatch(/\/run|resume|suspend/);
    }
    expect(result.modelProvenance).toBe('not-attested'); expect(JSON.stringify(f.events)).not.toContain(secret);
  });
  it.each(['digest', 'sha256', 'order'])('refuses corrupt local index %s before any live call', async kind => {
    const f = await fixture(), m = structuredClone(f.sourceManifest);
    if (kind === 'digest') m.index.digest = 'f'.repeat(32);
    if (kind === 'sha256') m.index.sha256 = 'f'.repeat(64);
    if (kind === 'order') f.files.set(indexKey(commit, parser), f.files.get(indexKey(commit, parser))!.split('\n').filter(Boolean).reverse().join('\n') + '\n');
    f.files.set(manifestKey(commit, parser), JSON.stringify(m));
    await expect(planVectorBackup(f.reader())).rejects.toMatchObject({ code: 'INVALID_LOCAL_SNAPSHOT' }); expect(f.requests).toEqual([]);
  });
  it.each(['https://user:PRIVATE@pipeline.invalid', 'https://@pipeline.invalid', 'https://pipeline.invalid/path', 'https://pipeline.invalid/a/..',
    'https://pipeline.invalid?PRIVATE', 'https://pipeline.invalid#PRIVATE', 'http://pipeline.invalid', 'file:///PRIVATE'])('refuses non-origin URL %s before a request', async url => {
    const f = await fixture(); await expect(f.run(f.normal, { url })).rejects.toMatchObject({ code: 'INVALID_PIPELINE_ORIGIN' }); expect(f.requests).toEqual([]);
  });
  it('permits explicit HTTPS origins and HTTP loopback fixtures only', () => {
    expect(vectorBackupOrigin('https://pipeline.invalid/')).toBe(origin);
    expect(vectorBackupOrigin('http://127.0.0.1:8788')).toBe('http://127.0.0.1:8788');
    expect(vectorBackupOrigin('http://[::1]:8788/')).toBe('http://[::1]:8788');
  });
  it.each(['id', 'corpus', 'revision', 'open', 'active', 'queued', 'alarm-handler', 'alarm', 'pending', 'failures', 'quiescence'])('stops at the initial control %s mismatch', async kind => {
    const f = await fixture(), value = structuredClone(f.control);
    if (kind === 'id') value.coordinatorId = 'd'.repeat(64);
    if (kind === 'corpus') Reflect.set(value, 'corpusId', 'other');
    const fields: Record<string, unknown> = { revision: revision + 1, open: false, active: 'ingest', queued: 1, 'alarm-handler': 1,
      alarm: 123, pending: true, failures: 1, quiescence: false };
    const names: Record<string, string> = { open: 'suspended', 'alarm-handler': 'alarmHandlersActive', alarm: 'alarmAt', quiescence: 'quiescent' };
    if (kind in fields) Reflect.set(value.coordinator, names[kind] ?? kind, fields[kind]);
    let calls = 0; await expect(f.run(async () => { calls++; return f.json(value, false); })).rejects.toMatchObject({ code: 'SUSPENSION_NOT_COMPLETE_OR_CHANGED' });
    expect(calls).toBe(1); expect(f.events.filter(e => e.kind === 'intent')).toHaveLength(1);
  });
  it.each(['partDigest', 'sha256', 'embedded', 'part', 'format'])('rejects a mismatching part %s without publishing a manifest', async field => {
    const f = await fixture(); let calls = 0;
    const r = { ...f.receipts[0], [field]: field === 'partDigest' ? 'f'.repeat(32) : field === 'sha256' ? 'PRIVATE' : 9 };
    await expect(f.run(async () => ++calls === 1 ? f.json(f.control, false) : f.json(r))).rejects.toMatchObject({ code: 'PART_RECEIPT_MISMATCH' });
    expect(calls).toBe(2);
  });
  it.each(['missing', 'wrong'])('requires the exact suspension echo (%s)', async kind => {
    const f = await fixture(); let calls = 0;
    await expect(f.run(async () => ++calls === 1 ? f.json(f.control, false) : Response.json(f.receipts[0],
      { headers: kind === 'missing' ? {} : { 'x-pipeline-suspension-revision': '999' } }))).rejects.toMatchObject({ code: 'SUSPENSION_ECHO_MISMATCH' });
    expect(calls).toBe(2);
  });
  it.each(['sha256', 'counts', 'part-count'])('compares final manifest %s with every acknowledged part', async kind => {
    const f = await fixture(); let calls = 0; const m = structuredClone(f.manifest);
    if (kind === 'sha256') m.parts[0]!.sha256 = 'f'.repeat(64);
    if (kind === 'counts') { m.embedded--; m.notEmbedded++; }
    if (kind === 'part-count') m.parts.push({ ...m.parts[0]! });
    await expect(f.run(async () => { calls++; return f.json(calls === 1 ? f.control : calls === 2 ? f.receipts[0] : m); })).rejects.toMatchObject({ code: 'VECTOR_MANIFEST_MISMATCH' });
    expect(calls).toBe(3);
  });
  it('rejects a changed final suspension after all export receipts, without another request', async () => {
    const f = await fixture(); let calls = 0;
    await expect(f.run(async (url, init) => { calls++; if (calls === 4) return f.json({ ...f.control, coordinator: { ...f.control.coordinator, revision: revision + 2 } }, false);
      return f.normal(url, init); })).rejects.toMatchObject({ code: 'SUSPENSION_NOT_COMPLETE_OR_CHANGED' });
    expect(calls).toBe(4);
  });
  it('does not retry an uncertain accepted part or expose its exception', async () => {
    const f = await fixture(); let calls = 0;
    await expect(f.run(async () => { if (++calls === 1) return f.json(f.control, false); throw Error('PRIVATE credential and upstream body'); }))
      .rejects.toMatchObject({ code: 'EXPORT_TRANSPORT_FAILED', message: 'EXPORT_TRANSPORT_FAILED' });
    expect(calls).toBe(2); expect(JSON.stringify(f.events)).not.toContain('PRIVATE');
  });
  it.each(['redirect', 'redirected', 'declared-size', 'stream-size', 'invalid-json', 'invalid-utf8'])('bounds or rejects %s and sends nothing afterward', async kind => {
    const f = await fixture(); let calls = 0;
    const response = kind === 'redirect' ? new Response('PRIVATE', { status: 302, headers: { location: 'https://PRIVATE.invalid' } }) :
      kind === 'declared-size' ? new Response('{}', { headers: { 'content-length': '999999' } }) :
      kind === 'stream-size' ? new Response('PRIVATE'.repeat(3000)) : kind === 'invalid-utf8' ? new Response(new Uint8Array([255])) : new Response('PRIVATE invalid JSON');
    if (kind === 'redirected') Object.defineProperty(response, 'redirected', { value: true });
    await expect(f.run(async () => { calls++; return response; })).rejects.toMatchObject({ code: expect.stringMatching(/EXPORT_HTTP_REFUSED|RESPONSE_TOO_LARGE|INVALID_RESPONSE/) });
    expect(calls).toBe(1); expect(JSON.stringify(f.events)).not.toContain('PRIVATE');
  });
  it.each(['fetch', 'body'])('bounds a hanging %s with the same whole-request deadline', async kind => {
    const f = await fixture(); let calls = 0;
    await expect(f.run(async () => { calls++; return kind === 'fetch' ? new Promise<Response>(() => {}) :
      new Response(new ReadableStream({ pull: () => new Promise(() => {}) })); }, { controlMs: 5 })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    expect(calls).toBe(1);
  });
  it('normalizes private response fields and refuses a failed intent before transport', async () => {
    const f = await fixture(); let calls = 0;
    const result = await f.run(async () => { calls++; return f.json({ ...(calls === 1 || calls === 4 ? f.control : calls === 2 ? f.receipts[0] : f.manifest), PRIVATE: secret }); });
    expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(JSON.stringify(f.events)).not.toContain('PRIVATE');
    await expect(f.run(f.normal, { record: () => { throw Error(secret); } })).rejects.toMatchObject({ code: 'JOURNAL_WRITE_FAILED' });
    expect(f.requests).toEqual([]);
  });
});
