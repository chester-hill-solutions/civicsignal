import { afterEach, describe, expect, it } from 'vitest';
import { ApiKeyUsageDO, DurableObjectUsageLedger } from '@chester-hill-solutions/api-billing/durable-object';
import worker from '../src/index';
import type { Env } from '../src/types';
import { prepareWorkspaceKey } from '../src/key-operations';
import { testD1 } from './helpers/d1';

const closing: (() => void)[] = [];
afterEach(() => { for (const close of closing.splice(0)) close(); });

interface Storage {
  get(key: string): Promise<unknown>;
  put(key: string | Record<string, unknown>, value?: unknown): Promise<void>;
  transaction<T>(work: (storage: Storage) => Promise<T>): Promise<T>;
}

function fixture(limit = 2) {
  const original = testD1();
  const authoritative = testD1();
  closing.push(original.close, authoritative.close);
  const key = prepareWorkspaceKey('rollback_workspace', 'Synthetic rollback fixture');
  // Model the initial protected copy. Subsequent auth mutations affect only the
  // authoritative store, leaving the original corpus backup's auth rows stale.
  for (const store of [original, authoritative]) {
    store.sqlite.exec("INSERT INTO workspace(id) VALUES('rollback_workspace')");
    store.sqlite.prepare(`INSERT INTO civic_workspace_billing
      (workspace_id,plan,fuse_limit,fuse_soft_warn,enabled)
      VALUES('rollback_workspace','free',?,0,1)`).run(limit);
    store.sqlite.exec(key.sql);
    store.sqlite.exec(`INSERT INTO corpus_state
      (corpus_id,commit_sha,commit_date,as_of,row_count,last_run_at,parser_version)
      VALUES('statutes-canada','fixture-revision','2026-10-23','2026-10-23',1,
        '2026-10-23T00:00:00Z','statutes-v2')`);
    store.sqlite.exec(`INSERT INTO statute_sections
      (id,corpus_id,act,citation,section,text,source_url,jurisdiction,in_force,language)
      VALUES('acts-en-fixture','statutes-canada','Fixture Act','F-1','1',
        'Verified corpus text.','https://example.invalid/F-1/1','CA',1,'en')`);
  }
  const data = new Map<string, unknown>();
  const names: string[] = [];
  const storage: Storage = {
    async get(key) { return data.get(key); },
    async put(key, value) {
      if (typeof key === 'string') data.set(key, value);
      else for (const entry of Object.entries(key)) data.set(...entry);
    },
    async transaction(work) {
      const previous = new Map(data);
      try { return await work(storage); }
      catch (error) {
        data.clear();
        for (const entry of previous) data.set(...entry);
        throw error;
      }
    },
  };
  // Real CHS metering and DO protocol; only the platform's durable storage and
  // namespace transport are supplied by this entirely local fixture.
  const object = new ApiKeyUsageDO({ storage } as unknown as ConstructorParameters<typeof ApiKeyUsageDO>[0]);
  const namespace = {
    idFromName(name: string) { names.push(name); return name; },
    get() { return { fetch: (input: string, init?: RequestInit) => object.fetch(new Request(input, init)) }; },
  };
  const env: Env = { CIVIC_DB: authoritative.db, AUTH_DB: authoritative.db,
    API_KEY_USAGE: namespace as unknown as DurableObjectNamespace };
  const tasks: Promise<unknown>[] = [];
  const context = { waitUntil(task: Promise<unknown>) { tasks.push(task); },
    passThroughOnException() {}, props: {} } as ExecutionContext;
  const send = async (mcp = false, rawKey = key.rawKey) => {
    const path = mcp ? '/mcp' : '/api/statutes?act=Fixture+Act&section=1';
    const response = await worker.fetch(new Request('https://local.invalid' + path, {
      method: mcp ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + rawKey,
        ...(mcp ? { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } : {}) },
      ...(mcp ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'cite_provision', arguments: { act: 'Fixture Act', section: '1' } } }) } : {}),
    }), env, context);
    await Promise.all(tasks.splice(0));
    return response;
  };
  const count = async () => (await new DurableObjectUsageLedger(env.API_KEY_USAGE!)
    .peekMonthly('rollback_workspace', limit)).count;
  const operationReceipts = () => [...data.entries()].filter(([key]) => key.startsWith('operation:month:'));
  return { original, authoritative, key, env, send, count, names, operationReceipts,
    rollback() { env.CIVIC_DB = original.db; env.CORPUS_TEXT_MODE = 'd1'; } };
}

async function statuses(subject: ReturnType<typeof fixture>) {
  return [(await subject.send()).status, (await subject.send(true)).status];
}

describe('corpus-only rollback authorization contracts', () => {
  it('keeps CIVIC_DB authorization when AUTH_DB is absent', async () => {
    const subject = fixture();
    delete subject.env.AUTH_DB;
    expect((await subject.send()).status).toBe(200);
    expect(await subject.count()).toBe(1);
  });

  it('keeps the same HTTP/MCP allowance and operation receipts across corpus rollback', async () => {
    const subject = fixture();
    expect((await subject.send()).status).toBe(200);
    const [firstReceipt] = subject.operationReceipts();
    expect(firstReceipt).toBeDefined();
    subject.rollback();
    const mcp = await subject.send(true);
    expect(mcp.status).toBe(200);
    // Drain SSE/JSON before inspecting usage: HTTP headers alone do not prove
    // the MCP tool and its success-metering callback have completed.
    expect(await mcp.text()).toContain('Verified corpus text.');
    expect(await subject.count()).toBe(2);
    expect(subject.operationReceipts()).toHaveLength(2);
    expect(subject.operationReceipts()).toContainEqual(firstReceipt);
    expect((await subject.send()).status).toBe(429);
    expect(await subject.count()).toBe(2);
    expect(new Set(subject.names)).toEqual(new Set(['customer:rollback_workspace']));
  });

  it('never resurrects a key revoked after the original corpus backup', async () => {
    const subject = fixture();
    subject.authoritative.sqlite.prepare("UPDATE workspace_api_key SET status='revoked' WHERE id=?")
      .run(subject.key.id);
    subject.rollback();
    expect(await statuses(subject)).toEqual([401, 401]);
    expect(await subject.count()).toBe(0);
  });

  it('preserves a retrieval capability removal on HTTP and MCP', async () => {
    const subject = fixture();
    subject.authoritative.sqlite.prepare("UPDATE workspace_api_key SET capabilities='[]' WHERE id=?")
      .run(subject.key.id);
    subject.rollback();
    expect(await statuses(subject)).toEqual([403, 403]);
    expect(await subject.count()).toBe(0);
  });

  it('keeps disabled workspace billing disabled on HTTP and MCP', async () => {
    const subject = fixture();
    subject.authoritative.sqlite.exec('UPDATE civic_workspace_billing SET enabled=0');
    subject.rollback();
    expect(await statuses(subject)).toEqual([403, 403]);
    expect(await subject.count()).toBe(0);
  });

  it('keeps a tightened allowance and refuses further HTTP/MCP units', async () => {
    const subject = fixture();
    expect((await subject.send()).status).toBe(200);
    subject.authoritative.sqlite.exec('UPDATE civic_workspace_billing SET fuse_limit=1');
    subject.rollback();
    const http = await subject.send();
    const mcp = await subject.send(true);
    expect(http.status).toBe(429);
    expect(await mcp.text()).toContain('FUSE_EXCEEDED');
    expect(await subject.count()).toBe(1);
  });

  it('fails closed when explicit AUTH_DB is broken instead of using stale corpus auth', async () => {
    const subject = fixture();
    subject.authoritative.sqlite.exec('DROP TABLE workspace_api_key');
    subject.rollback();
    for (const mcp of [false, true]) {
      const response = await subject.send(mcp);
      expect(response.status).toBe(503);
      expect(await response.text()).toContain('AUTH_UNAVAILABLE');
    }
    expect(await subject.count()).toBe(0);
  });

  it('fails closed when billing is unavailable in explicit AUTH_DB', async () => {
    const subject = fixture();
    subject.authoritative.sqlite.exec('DROP TABLE civic_workspace_billing');
    subject.rollback();
    for (const mcp of [false, true]) {
      const response = await subject.send(mcp);
      expect(response.status).toBe(503);
      expect(await response.text()).toContain('AUTH_UNAVAILABLE');
    }
    expect(await subject.count()).toBe(0);
  });

  it('keeps replacement keys and revocation in the same authoritative workspace', async () => {
    const subject = fixture(4);
    const replacement = prepareWorkspaceKey('rollback_workspace', 'Synthetic replacement');
    subject.authoritative.sqlite.exec(replacement.sql);
    subject.authoritative.sqlite.prepare("UPDATE workspace_api_key SET status='revoked' WHERE id=?")
      .run(subject.key.id);
    subject.rollback();
    expect(await statuses(subject)).toEqual([401, 401]);
    const http = await subject.send(false, replacement.rawKey);
    expect(http.status).toBe(200);
    const mcp = await subject.send(true, replacement.rawKey);
    expect(mcp.status).toBe(200);
    expect(await mcp.text()).toContain('Verified corpus text.');
    expect(await subject.count()).toBe(2);
    expect(new Set(subject.names)).toEqual(new Set(['customer:rollback_workspace']));
  });

  it('does not require auth tables on the corpus store when AUTH_DB is explicit', async () => {
    const subject = fixture();
    subject.original.sqlite.exec('DROP TABLE workspace_api_key; DROP TABLE civic_workspace_billing; DROP TABLE workspace');
    subject.rollback();
    expect((await subject.send()).status).toBe(200);
    expect(await subject.count()).toBe(1);
  });
});
