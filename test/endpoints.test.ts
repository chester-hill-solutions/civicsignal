import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyUsageDO, DurableObjectUsageLedger } from '@chester-hill-solutions/api-billing/durable-object';
import worker from '../src/index';
import type { Env } from '../src/types';
import { testD1 } from './helpers/d1';
import { prepareWorkspaceKey } from '../src/key-operations';
import { COMPACT_CORPUS_SCHEMA, COMPACT_STATUTE_COLUMNS, INSERT_COMPACT_STATUTE_SQL, applyCompactRestorePage, compactPageDigest } from '../src/corpora/compact-restore';
import { prepareProvisionText, rowFingerprintWithText, textReferenceBindings, UPSERT_TEXT_REFERENCE_SQL, writeImmutableProvisionText } from '../src/corpora/text-store';
import { memoryTextBucket } from './helpers/text-bucket';

const closed: (() => void)[] = [];
type RequestOptions = { method?: string; body?: string; headers?: Record<string, string> };
interface UsageStorage {
  get(name: string): Promise<unknown>;
  put(name: string | Record<string, unknown>, value?: unknown): Promise<void>;
  transaction<T>(work: (transaction: UsageStorage) => Promise<T>): Promise<T>;
}
beforeEach(() => vi.restoreAllMocks());
afterEach(() => { for (const close of closed.splice(0)) close(); vi.restoreAllMocks(); });

async function setup(limit = 5) {
  const fixture = testD1();
  closed.push(fixture.close);
  fixture.sqlite.exec("INSERT INTO workspace(id) VALUES('customer_kept')");
  fixture.sqlite.prepare(`INSERT INTO civic_workspace_billing(workspace_id,plan,fuse_limit,fuse_soft_warn,enabled)
    VALUES('customer_kept','free',?,0,1)`).run(limit);
  const key = prepareWorkspaceKey('customer_kept', 'Endpoint test');
  fixture.sqlite.exec(key.sql);
  const counts = new Map<string, unknown>();
  const storage: UsageStorage = { async get(name: string) { return counts.get(name); },
    async put(name: string | Record<string, unknown>, value?: unknown) {
      if (typeof name === 'string') counts.set(name, value);
      else for (const [key, item] of Object.entries(name)) counts.set(key, item);
    },
    async transaction<T>(work: (transaction: UsageStorage) => Promise<T>): Promise<T> {
      const previous = new Map(counts);
      try { return await work(storage); }
      catch (error) { counts.clear(); for (const entry of previous) counts.set(...entry); throw error; }
    } };
  // Exercise the actual shared Durable Object and its HTTP client. Cloudflare
  // supplies lifecycle and input gates; the fixture supplies persistent storage.
  const object = new ApiKeyUsageDO({ storage } as unknown as ConstructorParameters<typeof ApiKeyUsageDO>[0]);
  const names: string[] = [];
  const transport = { unavailable: false, loseNextPost: false, partitionAfterCommit: false };
  const namespace = {
    idFromName(name: string) { names.push(name); return name; },
    get() { return { async fetch(input: string, init?: RequestOptions) {
      if (transport.unavailable) throw new Error('fixture ledger unavailable');
      const response = await object.fetch(new Request(input, init));
      if (init?.method === 'POST' && transport.loseNextPost) {
        transport.loseNextPost = false;
        if (transport.partitionAfterCommit) transport.unavailable = true;
        throw new Error('fixture acknowledgement lost after commit');
      }
      return response;
    } }; },
  };
  const env: Env = { CIVIC_DB: fixture.db, API_KEY_USAGE: namespace as unknown as DurableObjectNamespace };
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil(task: Promise<unknown>) { tasks.push(task); }, passThroughOnException() {}, props: {} } as ExecutionContext;
  const send = async (path: string, init: RequestOptions = {}, authenticated = true) => {
    const headers = new Headers(init.headers);
    if (authenticated) headers.set('Authorization', `Bearer ${key.rawKey}`);
    const response = await worker.fetch(new Request('https://example.test' + path, { ...init, headers }), env, ctx);
    await Promise.all(tasks.splice(0));
    return response;
  };
  const count = async () => (await new DurableObjectUsageLedger(env.API_KEY_USAGE!).peekMonthly('customer_kept', limit)).count;
  const rpc = (method: string, params?: unknown) => send('/mcp', { method: 'POST', headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  fixture.sqlite.exec(`INSERT INTO corpus_state(corpus_id,commit_sha,commit_date,as_of,row_count,last_run_at)
    VALUES('statutes-canada','test-revision','2026-10-22','2026-10-22',1,'2026-10-22T00:00:00Z')`);
  fixture.sqlite.exec(`INSERT INTO statute_sections(id,corpus_id,act,citation,section,status,text,source_url,jurisdiction,in_force,language)
    VALUES('acts-en-one','statutes-canada','Test Act','T-1','1','in-force','A verified test provision.',
      'https://example.test/act/1','CA',1,'en')`);
  return { ...fixture, env, key, names, send, rpc, count, transport };
}

describe('HTTP and MCP access and metering', () => {
  it('rejects unauthenticated HTTP and MCP before corpus retrieval', async () => {
    const fixture = await setup();
    expect((await fixture.send('/api/brief?topic=leave', {}, false)).status).toBe(401);
    const response = await fixture.send('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }, false);
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Bearer');
    expect(await fixture.count()).toBe(0);
  });
  it('does not bill MCP discovery or malformed tool arguments', async () => {
    const fixture = await setup();
    const listed = await fixture.rpc('tools/list');
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain('cite_provision');
    const invalid = await fixture.rpc('tools/call', { name: 'cite_provision', arguments: { act: 'Test Act' } });
    expect(await invalid.text()).toMatch(/error|isError/);
    expect(await fixture.count()).toBe(0);
  });
  it('bills one successful MCP retrieval exactly once and preserves counter names', async () => {
    const fixture = await setup(1);
    const first = await fixture.rpc('tools/call', { name: 'cite_provision', arguments: { act: 'Test Act', section: '1' } });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('A verified test provision.');
    expect(await fixture.count()).toBe(1);
    const refused = await fixture.rpc('tools/call', { name: 'cite_provision', arguments: { act: 'Test Act', section: '1' } });
    expect(await refused.text()).toContain('Monthly usage fuse exceeded');
    expect(await fixture.count()).toBe(1);
    expect(new Set(fixture.names)).toEqual(new Set(['customer:customer_kept']));
  });
  it('does not bill failed MCP database retrieval', async () => {
    const fixture = await setup();
    fixture.sqlite.exec('DROP TABLE statute_sections');
    const response = await fixture.rpc('tools/call', { name: 'cite_provision', arguments: { act: 'Test Act', section: '1' } });
    expect(await response.text()).toMatch(/error|isError/);
    expect(await fixture.count()).toBe(0);
  });
  it('recovers a lost ledger acknowledgement without a second unit', async () => {
    const fixture = await setup();
    fixture.transport.loseNextPost = true;
    const response = await fixture.rpc('tools/call', { name: 'cite_provision', arguments: { act: 'Test Act', section: '1' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('A verified test provision.');
    expect(await fixture.count()).toBe(1);
  });
  it('reports an uncertain committed operation when its acknowledgement cannot be recovered', async () => {
    const fixture = await setup();
    fixture.transport.loseNextPost = true;
    fixture.transport.partitionAfterCommit = true;
    const response = await fixture.send('/api/statutes?act=Test+Act&section=1');
    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'USAGE_UNAVAILABLE', uncertain: true });
    expect(body.operationId).toEqual(expect.any(String));
    // A permanent partition cannot make HTTP delivery atomic with the ledger.
    // The committed receipt remains available for operator reconciliation.
    fixture.transport.unavailable = false;
    expect(await fixture.count()).toBe(1);
  });
  it('preserves uncertain usage receipts in MCP tool errors', async () => {
    const fixture = await setup();
    fixture.transport.loseNextPost = true;
    fixture.transport.partitionAfterCommit = true;
    const response = await fixture.rpc('tools/call', { name: 'cite_provision', arguments: { act: 'Test Act', section: '1' } });
    const body = await response.text();
    expect(body).toContain('USAGE_UNAVAILABLE');
    expect(body).not.toContain('FUSE_EXCEEDED');
    expect(body).toMatch(/"uncertain"\s*:\s*true/);
    expect(body).toContain('operationId');
    fixture.transport.unavailable = false;
    expect(await fixture.count()).toBe(1);
  });
  it.each([false, true])('refuses a ledger outage for unlimited or soft plans (soft=%s)', async (soft) => {
    const fixture = await setup();
    fixture.sqlite.prepare("UPDATE civic_workspace_billing SET plan='enterprise',fuse_limit=?,fuse_soft_warn=?").run(soft ? 1 : 0, soft ? 1 : 0);
    fixture.transport.unavailable = true;
    const response = await fixture.send('/api/statutes?act=Test+Act&section=1');
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('USAGE_UNAVAILABLE');
    fixture.transport.unavailable = false;
    expect(await fixture.count()).toBe(0);
  });
  it('validates HTTP method, body, and vector before any unit is consumed', async () => {
    const fixture = await setup();
    expect((await fixture.send('/api/match')).status).toBe(405);
    expect((await fixture.send('/api/match', { method: 'POST', body: '{' })).status).toBe(400);
    expect((await fixture.send('/api/match', { method: 'POST', body: JSON.stringify({ vector: [1] }) })).status).toBe(400);
    expect(await fixture.count()).toBe(0);
  });
  it('meters successful HTTP vector matches and never bills an upstream failure', async () => {
    const fixture = await setup();
    fixture.env.VECTORIZE = { async query() { return { matches: [{ id: 'acts-en-one', score: 0.9 }] }; } };
    const body = JSON.stringify({ vector: Array.from({ length: 768 }, (_, at) => at ? 0 : 1) });
    const ok = await fixture.send('/api/match', { method: 'POST', body });
    expect(ok.status).toBe(200);
    expect(await fixture.count()).toBe(1);
    fixture.env.VECTORIZE.query = async () => { throw new Error('private upstream details'); };
    const failed = await fixture.send('/api/match', { method: 'POST', body });
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('private upstream details');
    expect(await fixture.count()).toBe(1);
  });
  it('serves exact HTTP citations without an encoder and rejects unsupported coverage without billing', async () => {
    const fixture = await setup();
    const response = await fixture.send('/api/statutes?act=Test+Act&section=1&language=en');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('A verified test provision.');
    expect(await fixture.count()).toBe(1);
    for (const path of ['/api/news?topic=leave', '/api/debates?topic=leave', '/api/statutes?topic=leave&jurisdiction=ON',
      '/api/brief?topic=leave&since=2020-01-01']) {
      expect((await fixture.send(path)).status).toBe(501);
    }
    expect((await fixture.send('/api/statutes?topic=leave&limit=NaN')).status).toBe(400);
    expect(await fixture.count()).toBe(1);
  });
  it('serves a bounded change feed and refuses an unpublished corpus without billing', async () => {
    const fixture = await setup();
    expect((await fixture.send('/api/changes?limit=1')).status).toBe(200);
    expect(await fixture.count()).toBe(1);
    fixture.sqlite.exec('DELETE FROM corpus_state');
    expect((await fixture.send('/api/changes')).status).toBe(503);
    expect((await fixture.send('/api/brief?act=Test+Act&section=1')).status).toBe(503);
    expect(await fixture.count()).toBe(1);
  });
  it('serves restored compact metadata through strict R2 and retains binding rollback and usage history', async () => {
    const fixture = await setup();
    const original = fixture.sqlite.prepare('SELECT * FROM statute_sections').get()!;
    const text = String(original.text);
    original.text_hash = rowFingerprintWithText(original, text);
    fixture.sqlite.prepare('UPDATE statute_sections SET text_hash=? WHERE id=?').run(original.text_hash, original.id);
    const fresh = testD1({ schema: COMPACT_CORPUS_SCHEMA });
    closed.push(fresh.close);
    // Copy protected identity and publication rows. The corpus restore cannot
    // reset a workspace or the existing external usage namespace.
    for (const table of ['workspace', 'civic_workspace_billing', 'workspace_api_key', 'corpus_state']) {
      const ddl = fixture.sqlite.prepare('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?').get(table)?.sql;
      fresh.sqlite.exec(String(ddl));
      for (const row of fixture.sqlite.prepare(`SELECT * FROM ${table}`).all()) {
        fresh.sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`)
          .run(...Object.values(row));
      }
    }
    const storage = memoryTextBucket();
    const artifact = await prepareProvisionText({ rowId: String(original.id), corpusId: 'statutes-canada',
      rowFingerprint: String(original.text_hash), text });
    await writeImmutableProvisionText(storage.bucket, artifact);
    const pageData = { page: 1, fromAfter: '', through: String(original.id), rows: 1,
      statements: [{ query: INSERT_COMPACT_STATUTE_SQL, params: COMPACT_STATUTE_COLUMNS.map((column) => column === 'text' ? '' : original[column] ?? null) },
        { query: UPSERT_TEXT_REFERENCE_SQL, params: textReferenceBindings(artifact.reference) }] };
    await applyCompactRestorePage(fresh.db, { ...pageData, sha256: await compactPageDigest(pageData) },
      { bundleSha256: 'b'.repeat(64), revision: 'test-revision:legacy' });
    expect(fresh.sqlite.prepare('SELECT sum(length(text)) AS bytes FROM statute_sections').get()?.bytes).toBe(0);
    fixture.env.CIVIC_DB = fresh.db;
    fixture.env.CORPUS_TEXT_MODE = 'r2';
    fixture.env.CORPORA = storage.bucket as unknown as R2Bucket;
    const exact = await fixture.send('/api/statutes?act=Test+Act&section=1&language=en');
    expect(exact.status).toBe(200);
    expect(await exact.text()).toContain(text);
    fixture.env.VECTORIZE = { async query() { return { matches: [{ id: String(original.id), score: 0.99 }] }; } };
    fixture.env.ENCODER_TOKEN = 'fixture-only';
    fixture.env.ENCODER_SERVICE = { async fetch() { return Response.json({ vectors: [Array.from({ length: 768 }, (_, at) => at ? 0 : 1)] }); } };
    const semantic = await fixture.send('/api/statutes?topic=test+provision&language=en');
    expect(semantic.status).toBe(200);
    expect(await semantic.text()).toContain(text);
    expect(await fixture.count()).toBe(2);
    storage.objects.clear();
    expect((await fixture.send('/api/statutes?act=Test+Act&section=1')).status).toBe(502);
    expect(await fixture.count()).toBe(2);
    fixture.env.CIVIC_DB = fixture.db;
    fixture.env.CORPUS_TEXT_MODE = 'd1';
    delete fixture.env.CORPORA;
    const rollback = await fixture.send('/api/statutes?act=Test+Act&section=1');
    expect(rollback.status).toBe(200);
    expect(await rollback.text()).toContain(text);
    expect(await fixture.count()).toBe(3);
  });
});
