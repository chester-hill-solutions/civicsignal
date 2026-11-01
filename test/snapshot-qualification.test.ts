import { describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from 'cloudflare:workers';
import { manifestKey, SNAPSHOT_PARSER_VERSION } from '../src/ingest/snapshot-format';
import { rowsForFile } from '../src/ingest/corpus-rows';
import { fingerprint } from '../src/ingest/reconcile';
import { SnapshotReader } from '../src/ingest/snapshot-source';
import { PARTITIONS, stageCorpus, buildGroup, sortIndexPartition, publishSnapshot, cleanupStaging } from '../services/snapshot/builder';
import { qualificationIdentity, runQualificationScheduled, reserveSourceAttempt, qualificationRecord, SOURCE_PHASES, QUALIFICATION_SOURCE_START_WINDOW_MS } from '../services/snapshot/qualification';
import { qualificationBucket, qualificationReceipt, QUALIFICATION_RECEIPT_BYTES } from '../services/snapshot/qualification-store';
import { qualificationSource } from '../services/snapshot/qualification-source';
import { runSnapshotWorkflow } from '../services/snapshot/snapshot-workflow';
import type { BuildBucket } from '../services/snapshot/builder';
import { archive, calendarAt, controls, event, files, memoryBucket, revision } from './helpers/snapshot-qualification';

function binding() {
  const instances = new Set<string>();
  return { instances, create: vi.fn(async ({ id }: { id: string }) => { instances.add(id); }),
    get: vi.fn(async (id: string) => { if (!instances.has(id)) throw new Error('not found'); return { status: async () => ({ status: 'running' }) }; }) };
}
function headResponse() { return new Response(JSON.stringify([{ sha: revision.commit, commit: { committer: { date: revision.date + 'T00:00:00Z' } } }])); }
async function buildReference(bucket: ReturnType<typeof memoryBucket>['bucket']) {
  const plan = await stageCorpus(bucket, { async *instruments() { yield* files; } }, revision);
  const groups = []; let offset = 0;
  for (let i = 0; i < plan.groups.length; i++) { const group = await buildGroup(bucket, plan, i, offset); groups.push(group); offset += group.bytes; }
  const partitions = [];
  for (const partition of PARTITIONS) partitions.push(await sortIndexPartition(bucket, revision.commit, partition, groups));
  const result = await publishSnapshot(bucket, plan, groups, partitions);
  await cleanupStaging(bucket, revision.commit);
  return result;
}

describe('stage-only scheduled first-publication qualification', () => {
  it('jointly derives a separate namespace/instance from the real revision, parser and exact event', async () => {
    const a = await qualificationIdentity(controls), b = await qualificationIdentity({ ...controls });
    expect(a).toEqual(b); expect(a.identity).toMatchObject({ revision, parser: SNAPSHOT_PARSER_VERSION, sourceAttempts: 3, event });
    expect(a.instanceId).not.toBe(`${SNAPSHOT_PARSER_VERSION}-${revision.commit}`);
    expect(a.prefix).toMatch(/^qualifications\/local-first-publication\/[a-f0-9]{64}\/$/);
    expect((await qualificationIdentity({ ...controls, SNAPSHOT_QUALIFICATION_ID: 'next-reviewed-event' })).instanceId).not.toBe(a.instanceId);
    const next = { ...controls, SNAPSHOT_QUALIFICATION_TIME: String(event.scheduledTime + 60000), SNAPSHOT_QUALIFICATION_CRON: calendarAt(event.scheduledTime + 60000).cron };
    expect((await qualificationIdentity(next)).prefix).not.toBe(a.prefix);
  });
  it.each([
    { SNAPSHOT_STAGE_ID: 'production' }, { SNAPSHOT_QUALIFICATION_ID: '../escape' }, { SNAPSHOT_QUALIFICATION_ID: '' },
    { SNAPSHOT_PINNED_COMMIT: undefined }, { SNAPSHOT_PINNED_DATE: '2026-02-30' },
    { SNAPSHOT_QUALIFICATION_TIME: '01' }, { SNAPSHOT_QUALIFICATION_TIME: String(event.scheduledTime + 1) },
    { SNAPSHOT_QUALIFICATION_CRON: '40 1 * * *' },
  ])('rejects invalid configuration before choosing a bucket path: %j', async changed => {
    const h = memoryBucket(), head = vi.fn(), workflow = binding();
    await expect(runQualificationScheduled({ ...controls, ...changed, CORPUS: h.bucket, SNAPSHOT: workflow }, event, head)).rejects.toThrow('configuration');
    expect(h.writes).toEqual([]); expect(head).not.toHaveBeenCalled(); expect(workflow.create).not.toHaveBeenCalled();
  });
  it('records safe rejected ingress before admission without unbounded tuple-dependent keys or source work', async () => {
    const h = memoryBucket(), workflow = binding(), head = vi.fn(), q = await qualificationIdentity(controls);
    const env = { ...controls, CORPUS: h.bucket, SNAPSHOT: workflow };
    await expect(runQualificationScheduled(env, { ...event, scheduledTime: event.scheduledTime + 1 }, head)).rejects.toThrow('rejected');
    expect(h.objects.has(q.prefix + 'diagnostics/rejected.json')).toBe(true);
    await expect(runQualificationScheduled(env, { cron: 'Bearer private-secret://example', scheduledTime: NaN }, head)).rejects.toThrow();
    expect(h.objects.size).toBe(1); expect(head).not.toHaveBeenCalled(); expect(workflow.create).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(h.objects.values().next().value!.bytes)).not.toContain('private-secret');
    // A rejected slot does not consume the separately reviewed exact event.
    await runQualificationScheduled(env, event, async () => revision); expect(workflow.create).toHaveBeenCalledOnce();
  });
  it('allows one discovery/create across concurrent events and later replays', async () => {
    const h = memoryBucket(), workflow = binding(), head = vi.fn(async () => revision), q = await qualificationIdentity(controls);
    const env = { ...controls, CORPUS: h.bucket, SNAPSHOT: workflow };
    await Promise.all(Array.from({ length: 8 }, () => runQualificationScheduled(env, event, head)));
    await runQualificationScheduled(env, event, head);
    expect(head).toHaveBeenCalledOnce(); expect(workflow.create).toHaveBeenCalledOnce(); expect(workflow.create).toHaveBeenCalledWith({ id: q.instanceId, params: { revision, qualification: q.digest } });
    expect(h.objects.has(q.prefix + 'diagnostics/delegated.json')).toBe(true);
  });
  it.each(['before', 'after'] as const)('never spends source after an admitted receipt %s-write failure or lost ACK', async failure => {
    const h = memoryBucket(), workflow = binding(), head = vi.fn(async () => revision);
    h.failWrites(key => key.endsWith('diagnostics/admitted.json') ? failure : undefined);
    const env = { ...controls, CORPUS: h.bucket, SNAPSHOT: workflow };
    await expect(runQualificationScheduled(env, event, head)).rejects.toThrow('uncertain');
    h.failWrites(undefined); await runQualificationScheduled(env, event, head);
    expect(head).not.toHaveBeenCalled(); expect(workflow.create).not.toHaveBeenCalled();
  });
  it.each([undefined, false, 'ack', {}, { key: 'wrong', size: 1 }])('does not treat a malformed acknowledgement as ownership: %j', async ack => {
    const h = memoryBucket(), workflow = binding(), head = vi.fn(async () => revision);
    const bad = { ...h.bucket, async put(key: string, bytes: Uint8Array<ArrayBuffer>, options: R2PutOptions) { await h.bucket.put(key, bytes, options); return ack; } } as unknown as BuildBucket;
    await runQualificationScheduled({ ...controls, CORPUS: bad, SNAPSHOT: workflow }, event, head);
    expect(head).not.toHaveBeenCalled(); expect(workflow.create).not.toHaveBeenCalled();
    const q = await qualificationIdentity(controls), send = vi.fn(async () => headResponse());
    await expect(qualificationSource(bad, q, send).head('discovery')).rejects.toThrow(); expect(send).not.toHaveBeenCalled();
  });
  it('joins only the same ID after a create ACK is lost, with no replayed create', async () => {
    const h = memoryBucket(), workflow = binding(), create = workflow.create;
    workflow.create = vi.fn(async options => { await create(options); throw new Error('private transport failure'); });
    const env = { ...controls, CORPUS: h.bucket, SNAPSHOT: workflow };
    await runQualificationScheduled(env, event, async () => revision); await runQualificationScheduled(env, event, async () => { throw new Error('replayed'); });
    expect(workflow.create).toHaveBeenCalledOnce(); expect(workflow.get).toHaveBeenCalledOnce();
    expect([...workflow.instances]).toEqual([(await qualificationIdentity(controls)).instanceId]);
  });
  it('fails closed on source drift or uncertain create and never restarts source on replay', async () => {
    for (const drift of [true, false]) {
      const h = memoryBucket(), workflow = binding(), q = await qualificationIdentity(controls), head = vi.fn(async () => ({ ...revision, commit: drift ? 'f'.repeat(40) : revision.commit }));
      if (!drift) workflow.create = vi.fn(async () => { throw new Error('private transport failure'); });
      const env = { ...controls, CORPUS: h.bucket, SNAPSHOT: workflow };
      await expect(runQualificationScheduled(env, event, head)).rejects.toThrow('uncertain'); await runQualificationScheduled(env, event, head);
      expect(head).toHaveBeenCalledOnce(); expect(workflow.create).toHaveBeenCalledTimes(drift ? 0 : 1);
      expect(new TextDecoder().decode(h.objects.get(q.prefix + 'diagnostics/failed.json')!.bytes)).not.toContain('private');
    }
  });
  it('retains only typed source code, observed status and safe quota metadata after failed discovery', async () => {
    const h = memoryBucket(), q = await qualificationIdentity(controls), workflow = binding();
    const send = vi.fn(async () => new Response('private upstream body and credential', { status: 403, headers: {
      'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-used': '60',
      'x-ratelimit-reset': '1792800000', 'retry-after': '12', 'x-private': 'private header',
    } }));
    const source = qualificationSource(h.bucket, q, send), env = { ...controls, CORPUS: h.bucket, SNAPSHOT: workflow };
    await expect(runQualificationScheduled(env, event, () => source.head('discovery'))).rejects.toThrow('primary-rate-limit');
    const bytes = h.objects.get(q.prefix + 'diagnostics/failed.json')!.bytes;
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({ sourceFailure: {
      code: 'primary-rate-limit', status: 403,
      rateLimits: { limit: 60, remaining: 0, used: 60, reset: 1792800000, retryAfterSeconds: 12 },
    } });
    expect(bytes.length).toBeLessThanOrEqual(QUALIFICATION_RECEIPT_BYTES);
    expect(new TextDecoder().decode(bytes)).not.toMatch(/private|credential|upstream body|x-private/);
    await runQualificationScheduled(env, event, () => source.head('discovery'));
    expect(send).toHaveBeenCalledOnce(); expect(workflow.create).not.toHaveBeenCalled();
  });
  it('retains the observed successful HTTP status when discovery rejects the returned metadata', async () => {
    const h = memoryBucket(), q = await qualificationIdentity(controls), workflow = binding();
    const send = vi.fn(async () => new Response('private malformed source body', { headers: { 'x-ratelimit-remaining': '42' } }));
    await expect(runQualificationScheduled({ ...controls, CORPUS: h.bucket, SNAPSHOT: workflow }, event,
      () => qualificationSource(h.bucket, q, send).head('discovery'))).rejects.toThrow('invalid-response');
    const failed = new TextDecoder().decode(h.objects.get(q.prefix + 'diagnostics/failed.json')!.bytes);
    expect(JSON.parse(failed)).toMatchObject({ sourceFailure: { code: 'invalid-response', status: 200, rateLimits: { remaining: 42 } } });
    expect(failed).not.toContain('private'); expect(send).toHaveBeenCalledOnce(); expect(workflow.create).not.toHaveBeenCalled();
  });
  it('retains an existing qualified publication without discovery or Workflow creation', async () => {
    const h = memoryBucket(), q = await qualificationIdentity(controls), workflow = binding(), head = vi.fn();
    await buildReference(qualificationBucket(h.bucket, q.prefix));
    await runQualificationScheduled({ ...controls, CORPUS: h.bucket, SNAPSHOT: workflow }, event, head);
    expect(head).not.toHaveBeenCalled(); expect(workflow.create).not.toHaveBeenCalled(); expect(h.objects.has(q.prefix + 'diagnostics/existing.json')).toBe(true);
  });
  it('refuses a different parser stored at the expected qualified manifest key', async () => {
    const h = memoryBucket(), q = await qualificationIdentity(controls), workflow = binding(), head = vi.fn();
    await buildReference(qualificationBucket(h.bucket, q.prefix));
    const item = h.objects.get(q.prefix + manifestKey(revision.commit, SNAPSHOT_PARSER_VERSION))!;
    item.bytes = new Uint8Array(new TextEncoder().encode(new TextDecoder().decode(item.bytes).replaceAll('statutes-v2', 'statutes-v1')));
    await expect(runQualificationScheduled({ ...controls, CORPUS: h.bucket, SNAPSHOT: workflow }, event, head)).rejects.toThrow('uncertain');
    expect(h.objects.has(q.prefix + 'diagnostics/existing.json')).toBe(false); expect(head).not.toHaveBeenCalled(); expect(workflow.create).not.toHaveBeenCalled();
  });
  it.each([-1, QUALIFICATION_SOURCE_START_WINDOW_MS, QUALIFICATION_SOURCE_START_WINDOW_MS + 1, NaN])('rejects early/late/invalid-clock exact events before source claims: %j', async offset => {
    const h = memoryBucket(), q = await qualificationIdentity(controls), workflow = binding(), head = vi.fn();
    expect(q.identity.sourceStartWindowMs).toBe(QUALIFICATION_SOURCE_START_WINDOW_MS);
    await expect(runQualificationScheduled({ ...controls, CORPUS: h.bucket, SNAPSHOT: workflow }, event, head, () => event.scheduledTime + offset)).rejects.toThrow('rejected');
    expect(h.objects.has(q.prefix + 'diagnostics/admitted.json')).toBe(false);
    // An invalid clock cannot establish the new runtime deadline and therefore
    // cannot authorize even a diagnostic R2 write.
    expect(h.objects.has(q.prefix + 'diagnostics/rejected.json')).toBe(Number.isFinite(offset));
    expect(head).not.toHaveBeenCalled(); expect(workflow.create).not.toHaveBeenCalled();
    await expect(reserveSourceAttempt(h.bucket, q, 'authoritative', () => event.scheduledTime + offset)).rejects.toThrow(Number.isFinite(offset) ? 'window' : 'deadline');
    expect([...h.objects.keys()].some(key => key.includes('/attempts/'))).toBe(false);
  });
  it.each(['discovery', 'archive'] as const)('refuses %s HTTP when claim readback crosses the source-start boundary', async phase => {
    const h = memoryBucket(), q = await qualificationIdentity(controls), send = vi.fn(async () => headResponse());
    let wall = event.scheduledTime + QUALIFICATION_SOURCE_START_WINDOW_MS - 1;
    const delayed = { ...h.bucket, async get(key: string) {
      const value = await h.bucket.get(key); if (key.endsWith(`attempts/${phase}.json`)) wall++;
      return value;
    } } as unknown as BuildBucket;
    const source = qualificationSource(delayed, q, send, { now: () => wall });
    await expect(phase === 'discovery' ? source.head(phase) : (async () => { for await (const _ of source.instruments(revision.commit, ['eng/'])) {} })()).rejects.toThrow();
    expect(send).not.toHaveBeenCalled(); expect(h.objects.has(q.prefix + `attempts/${phase}.json`)).toBe(true);
  });
  it('checks the head monotonic deadline after claim readback even if its timer has not run', async () => {
    const h = memoryBucket(), q = await qualificationIdentity(controls), send = vi.fn(async () => headResponse()); let clock = 0;
    const delayed = { ...h.bucket, async get(key: string) { const value = await h.bucket.get(key); if (key.endsWith('attempts/discovery.json')) clock = 15000; return value; } } as unknown as BuildBucket;
    await expect(qualificationSource(delayed, q, send, { monotonicNow: () => clock }).head('discovery')).rejects.toThrow();
    expect(send).not.toHaveBeenCalled(); expect(h.objects.has(q.prefix + 'attempts/discovery.json')).toBe(true);
  });
  it('rejects a head result completed beyond its absolute deadline', async () => {
    const h = memoryBucket(), q = await qualificationIdentity(controls); let clock = 0;
    const send = vi.fn(async () => { clock = 15000; return headResponse(); });
    await expect(qualificationSource(h.bucket, q, send, { monotonicNow: () => clock }).head('discovery')).rejects.toThrow(); expect(send).toHaveBeenCalledOnce();
  });
  it('allows a started archive to finish after the source-start window without another transport', async () => {
    const h = memoryBucket(), q = await qualificationIdentity(controls); let wall = event.scheduledTime + QUALIFICATION_SOURCE_START_WINDOW_MS - 1;
    const send = vi.fn(async () => { wall += 2; return new Response(archive()); });
    const selected = [];
    for await (const file of qualificationSource(h.bucket, q, send, { now: () => wall }).instruments(revision.commit, ['eng/', 'fra/'])) selected.push(file);
    expect(selected).toEqual(files); expect(send).toHaveBeenCalledOnce();
  });
  it('enforces three fixed attempt slots across races, failed calls and reconstructed clients', async () => {
    const h = memoryBucket(), q = await qualificationIdentity(controls);
    for (const phase of SOURCE_PHASES) {
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => reserveSourceAttempt(h.bucket, q, phase)));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      await expect(reserveSourceAttempt(h.bucket, await qualificationIdentity(controls), phase)).rejects.toThrow('already reserved');
    }
    expect([...h.objects.keys()].filter(key => key.includes('/attempts/'))).toHaveLength(3);
    for (const item of h.objects.values()) expect(item.bytes.length).toBeLessThanOrEqual(QUALIFICATION_RECEIPT_BYTES);
  });
  it.each(['before', 'after'] as const)('makes no HTTP call when source reservation fails %s persistence', async failure => {
    const h = memoryBucket(), q = await qualificationIdentity(controls), send = vi.fn(async () => headResponse());
    h.failWrites(key => key.endsWith('attempts/discovery.json') ? failure : undefined);
    await expect(qualificationSource(h.bucket, q, send).head('discovery')).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    if (failure === 'after') { h.failWrites(undefined); await expect(qualificationSource(h.bucket, q, send).head('discovery')).rejects.toThrow(); expect(send).not.toHaveBeenCalled(); }
  });
  it('counts failed metadata attempts without refund and refuses redirect before follow', async () => {
    const h = memoryBucket(), q = await qualificationIdentity(controls), send = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 302, headers: { location: 'https://forbidden.invalid' } }));
    await expect(qualificationSource(h.bucket, q, send).head('discovery')).rejects.toThrow();
    await expect(qualificationSource(h.bucket, q, send).head('discovery')).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce(); expect(send.mock.calls[0]![1]).toMatchObject({ redirect: 'manual', method: 'GET' });
  });
  it('reuses the real tar reader with one bounded archive request and refuses an archive replay', async () => {
    const h = memoryBucket(), q = await qualificationIdentity(controls), send = vi.fn(async (_url: string, _init: RequestInit) => new Response(archive()));
    const source = qualificationSource(h.bucket, q, send);
    const selected = []; for await (const file of source.instruments(revision.commit, ['eng/acts/', 'fra/lois/'])) selected.push(file);
    expect(selected).toEqual(files); expect(send).toHaveBeenCalledOnce(); expect(send.mock.calls[0]![1]).toMatchObject({ redirect: 'manual', method: 'GET' });
    await expect((async () => { for await (const _ of qualificationSource(h.bucket, q, send).instruments(revision.commit, ['eng/'])) {} })()).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });
  it('retains safe archive HTTP failure facts through the shared Workflow source step', async () => {
    const h = memoryBucket(), q = await qualificationIdentity(controls);
    const send = vi.fn(async (url: string) => url.startsWith('https://codeload')
      ? new Response('private archive body and credential', { status: 503 }) : headResponse());
    const source = qualificationSource(h.bucket, q, send);
    const step = { async do(_name: string, configOrRun: unknown, supplied?: () => Promise<unknown>) {
      const run = typeof configOrRun === 'function' ? configOrRun : supplied;
      if (!run) throw new Error('Missing fixture step callback.');
      return run();
    } } as unknown as WorkflowStep;
    const failure = await runSnapshotWorkflow(revision, step, qualificationBucket(h.bucket, q.prefix), {
      head: () => source.head('authoritative'), source, sourceRetries: 0,
    }).catch(error => error);
    expect(failure).toMatchObject({ name: 'SnapshotArchiveError', code: 'http-refused', status: 503 });
    expect(String(failure)).toContain('"status":503');
    expect(String(failure) + JSON.stringify(failure)).not.toMatch(/private|credential|https:/);
    expect(send).toHaveBeenCalledTimes(2);
    expect(h.objects.has(q.prefix + manifestKey(revision.commit, SNAPSHOT_PARSER_VERSION))).toBe(false);
  });
  it.each(['redirect', 'length', 'compressed', 'expanded', 'deadline'] as const)('fails closed at the archive %s boundary without a retry', async mode => {
    const h = memoryBucket(), q = await qualificationIdentity(controls);
    const send = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe('manual');
      if (mode === 'deadline') return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('private abort'))));
      if (mode === 'redirect') return new Response(null, { status: 302 });
      return new Response(archive(), { headers: mode === 'length' ? { 'content-length': '9999999999' } : {} });
    });
    const options = { archiveTimeoutMs: 100, ...(mode === 'compressed' ? { archiveBytes: 4 } : {}), ...(mode === 'expanded' ? { expandedBytes: 4 } : {}) };
    const consume = async () => { for await (const _ of qualificationSource(h.bucket, q, send, options).instruments(revision.commit, ['eng/'])) {} };
    const code = mode === 'redirect' ? 'redirect-refused' : mode === 'deadline' ? 'timeout' : 'response-too-large';
    await expect(consume()).rejects.toMatchObject({ name: 'SnapshotArchiveError', code,
      status: mode === 'redirect' ? 302 : mode === 'deadline' ? undefined : 200 });
    await expect(consume()).rejects.toThrow(); expect(send).toHaveBeenCalledOnce();
  });
  it('keeps canonical and qualified bytes equal while scoping every staging deletion', async () => {
    const h = memoryBucket(), canonical = await buildReference(h.bucket), q = await qualificationIdentity(controls), before = new Map(h.objects);
    const scoped = qualificationBucket(h.bucket, q.prefix), qualified = await buildReference(scoped);
    expect(qualified).toEqual(canonical);
    for (const [key, item] of before) expect(h.objects.get(key)).toEqual(item);
    for (const key of h.deletes.slice(h.deletes.findIndex(key => key.startsWith(q.prefix)) || h.deletes.length)) expect(key.startsWith(q.prefix)).toBe(true);
    const reader = new SnapshotReader(scoped, revision.commit, { parser: SNAPSHOT_PARSER_VERSION }), index = await reader.index();
    const rows = await reader.rows([...index.values()]);
    expect(rows.map(row => [row.id, fingerprint(row)]).sort()).toEqual(files.flatMap(file => rowsForFile({ ...file, date: revision.date })).map(row => [row.id, fingerprint(row)]).sort());
    expect(h.objects.has(manifestKey(revision.commit, SNAPSHOT_PARSER_VERSION))).toBe(true);
  });
  it('refuses namespace escapes, foreign cursors/list results and published deletion', async () => {
    const h = memoryBucket(), q = await qualificationIdentity(controls), scoped = qualificationBucket(h.bucket, q.prefix);
    for (const key of ['../canonical', 'snapshots/statutes-v2/../../canonical', '/snapshots/statutes-v2/a', 'diagnostics/a']) await expect(scoped.get(key)).rejects.toThrow();
    await expect(scoped.delete(manifestKey(revision.commit, SNAPSHOT_PARSER_VERSION))).rejects.toThrow('restricted');
    await expect(scoped.list({ prefix: '.snapshot-staging/statutes-v2/a/', cursor: JSON.stringify(['foreign', 'cursor']) })).rejects.toThrow('Foreign');
    const bad = qualificationBucket({ ...h.bucket, list: async () => ({ objects: [{ key: 'canonical' }], truncated: false, delimitedPrefixes: [] }) } as unknown as typeof h.bucket, q.prefix);
    await expect(bad.list({ prefix: '.snapshot-staging/statutes-v2/a/' })).rejects.toThrow('outside');
  });
  it('round-trips bounded list cursors without cross-qualification reuse', async () => {
    const h = memoryBucket(), q = await qualificationIdentity(controls), scoped = qualificationBucket(h.bucket, q.prefix), prefix = '.snapshot-staging/statutes-v2/a/';
    await scoped.put(prefix + 'a', 'a'); await scoped.put(prefix + 'b', 'b');
    const first = await scoped.list({ prefix, limit: 1 }); expect(first.objects[0]!.key).toBe(prefix + 'a'); expect(first.truncated).toBe(true);
    const second = await scoped.list({ prefix, limit: 1, cursor: first.truncated ? first.cursor : undefined }); expect(second.objects[0]!.key).toBe(prefix + 'b');
  });
  it('detects conflicting or oversized durable receipts', async () => {
    const h = memoryBucket(), q = await qualificationIdentity(controls), key = q.prefix + 'test.json';
    await qualificationReceipt(h.bucket, key, qualificationRecord(q, 'one'));
    await expect(qualificationReceipt(h.bucket, key, qualificationRecord(q, 'two'))).rejects.toThrow('conflict');
    await expect(qualificationReceipt(h.bucket, key, 'x'.repeat(QUALIFICATION_RECEIPT_BYTES))).rejects.toThrow('exceeds');
  });
  it('does not repeat archive HTTP when a Workflow step is retried after losing its result', async () => {
    const h = memoryBucket(), q = await qualificationIdentity(controls), send = vi.fn(async (url: string) => url.startsWith('https://codeload') ? new Response(archive()) : headResponse());
    const source = qualificationSource(h.bucket, q, send);
    const step = { async do(name: string, configOrRun: unknown, supplied?: () => Promise<unknown>) {
      const run = (typeof configOrRun === 'function' ? configOrRun : supplied) as () => Promise<unknown>;
      const result = await run();
      if (name === 'stage pinned corpus once') { await expect(run()).rejects.toThrow(); }
      return result;
    } } as unknown as WorkflowStep;
    await runSnapshotWorkflow(revision, step, qualificationBucket(h.bucket, q.prefix), { head: () => source.head('authoritative'), source, sourceRetries: 0 });
    expect(send.mock.calls.filter(([url]) => url.startsWith('https://codeload'))).toHaveLength(1);
  });
});
