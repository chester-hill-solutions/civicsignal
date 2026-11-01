import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCivicSignalMcpHandler } from '../src/mcp/server';
import { sqliteCorpus } from './helpers/sqlite-corpus';
import type { CorpusContext } from '../src/corpora/types';
import type { Env } from '../src/types';
import { BillableDenied } from '../src/metering';

interface RpcBody {
  result?: {
    tools?: { name: string }[];
    isError?: boolean;
    structuredContent?: { result: { items?: Record<string, unknown>[] } };
  };
}

const open: ReturnType<typeof sqliteCorpus>[] = [];
afterEach(() => { for (const fixture of open.splice(0)) fixture.close(); });

function fixture(populated = true, semantic = false) {
  const fixture = sqliteCorpus();
  open.push(fixture);
  if (populated) fixture.sqlite.prepare(`INSERT INTO corpus_state(corpus_id,commit_sha,commit_date,as_of,row_count,last_run_at) VALUES ('statutes-canada', 'revision-1', '2026-10-20', '2026-10-20', 1, '2026-10-22T00:00:00Z')`).run();
  const ctx: CorpusContext = { db: fixture.db, fetch, now: () => new Date() };
  if (semantic) {
    ctx.vector = { async query() { return []; } };
    ctx.embedQuery = async () => [0.1];
  }
  let billed = 0;
  const runRetrieval = vi.fn(() => {});
  async function executeRetrieval<T>(work: () => Promise<T>): Promise<T> {
    runRetrieval();
    const value = await work();
    billed++;
    return value;
  }
  const handler = createCivicSignalMcpHandler({ request: new Request('https://api.example/mcp'), env: {} as Env, ctx, runRetrieval: executeRetrieval });
  async function rpc(method: string, params?: unknown, notification = false) {
    const response = await handler.fetch(new Request('https://api.example/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: 1 }), method, ...(params === undefined ? {} : { params }) }),
    }));
    const text = await response.text();
    const data = response.headers.get('content-type')?.includes('text/event-stream')
      ? text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).at(-1)
      : text;
    return { status: response.status, body: data ? JSON.parse(data) as RpcBody : null };
  }
  return { ...fixture, ctx, rpc, runRetrieval, billed: () => billed };
}

describe('MCP v1 discovery and retrieval boundary', () => {
  it('keeps initialization, discovery and notifications outside the billable callback', async () => {
    const { rpc, runRetrieval, billed } = fixture();
    expect((await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).status).toBe(200);
    expect((await rpc('notifications/initialized', undefined, true)).status).toBe(202);
    const tools = await rpc('tools/list');
    expect(tools.status).toBe(200);
    expect(tools.body?.result?.tools?.map((tool) => tool.name)).toEqual(['cite_provision', 'statute_changes']);
    expect(runRetrieval).not.toHaveBeenCalled();
    expect(billed()).toBe(0);
  });

  it('lists semantic tools only when the required backend and populated corpus exist', async () => {
    const ready = fixture(true, true);
    expect((await ready.rpc('tools/list')).body?.result?.tools?.map((tool) => tool.name)).toEqual(['brief_topic', 'statute_lookup', 'cite_provision', 'statute_changes']);
    const empty = fixture(false, true);
    expect((await empty.rpc('tools/list')).body?.result?.tools).toEqual([]);
  });

  it('executes the real change-feed read through the required callback exactly once', async () => {
    const { rpc, sqlite, runRetrieval, billed } = fixture();
    sqlite.exec(`INSERT INTO corpus_changes (corpus_id, change, row_id, instrument, citation, section, summary, source_url, occurred_at, recorded_at)
      VALUES ('statutes-canada', 'changed', 'row-1', 'Competition Act', 'C-34', '36', 'DO NOT EXPOSE', 'https://laws-lois.justice.gc.ca/en/acts/C-34/section-36.html', '2026-10-20', '2026-10-22')`);
    const called = await rpc('tools/call', { name: 'statute_changes', arguments: { after: 0, limit: 1 } });
    expect(called.body?.result?.isError).not.toBe(true);
    expect(called.body?.result?.structuredContent?.result.items).toHaveLength(1);
    expect(called.body?.result?.structuredContent?.result.items?.[0]).toMatchObject({ change: 'changed', citation: 'C-34', section: '36' });
    expect(JSON.stringify(called.body)).not.toContain('DO NOT EXPOSE');
    expect(runRetrieval).toHaveBeenCalledTimes(1);
    expect(billed()).toBe(1);
  });

  it('rejects unsupported tool arguments and failed reads without a successful unit', async () => {
    const { rpc, ctx, runRetrieval, billed } = fixture(true, true);
    const unsupported = await rpc('tools/call', { name: 'statute_lookup', arguments: { topic: 'housing', jurisdiction: 'ON' } });
    expect(unsupported.body?.result?.isError).toBe(true);
    expect(runRetrieval).not.toHaveBeenCalled();
    const invalidDate = await rpc('tools/call', { name: 'statute_changes', arguments: { since: '2026-02-30' } });
    expect(invalidDate.body?.result?.isError).toBe(true);
    expect(billed()).toBe(0);
    ctx.db = { prepare() { throw new Error('SECRET UPSTREAM RESPONSE'); } };
    // Keep metadata readiness stable so the fault targets the feed operation.
    ctx.corpusAvailability = { 'statutes-canada': { available: true, rowCount: 1, reason: 'published' } };
    const failed = await rpc('tools/call', { name: 'statute_changes', arguments: {} });
    expect(failed.body?.result?.isError).toBe(true);
    expect(JSON.stringify(failed.body)).not.toContain('SECRET UPSTREAM RESPONSE');
    expect(JSON.stringify(failed.body)).toContain('The retrieval could not complete. Retry later.');
    expect(billed()).toBe(0);
  });

  it('preserves deliberate quota denials without executing the retrieval', async () => {
    const { rpc, runRetrieval, billed } = fixture();
    runRetrieval.mockImplementationOnce(() => {
      throw new BillableDenied({ allowed: false, status: 429, body: { code: 'FUSE_EXCEEDED', error: 'Monthly usage fuse exceeded' } });
    });
    const denied = await rpc('tools/call', { name: 'statute_changes', arguments: {} });
    expect(denied.body?.result?.isError).toBe(true);
    expect(JSON.stringify(denied.body)).toContain('Monthly usage fuse exceeded');
    expect(billed()).toBe(0);
  });
});
