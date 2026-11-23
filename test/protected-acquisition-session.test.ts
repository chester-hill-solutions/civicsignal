import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTECTED_ACQUISITION_FACT_QUERIES as queries } from '../scripts/lib/protected-acquisition-facts';
import { PROTECTED_ACQUISITION_SOURCE as source } from '../scripts/lib/protected-acquisition';
import { runFixtureAcquisitionSession } from '../scripts/lib/protected-acquisition-session';
import type { AcquisitionSendInit } from '../scripts/lib/protected-acquisition-transport';

const roots: string[] = [];
const api = `https://api.cloudflare.com/client/v4/accounts/${source.accountId}`;
const database = `${api}/d1/database/${source.d1Id}`;
const kv = `${api}/storage/kv/namespaces/${source.kvNamespaceId}`;
const downloadOrigin = 'https://fixture-export.invalid';
const signed = `${downloadOrigin}/fixture.sql?signature=PRIVATE_SIGNED_VALUE`;
const customer = { id: 'fixture', plan: 'free', fuseLimit: 1000 };
const sql = 'CREATE TABLE captured(id INTEGER);';
const credential = 'SYNTHETIC_MANAGEMENT_CREDENTIAL_0123456789';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const envelope = (results: unknown[]) => Response.json({ success: true, result: [{ success: true, results }] });

function fixture({ drift, maxRequests = 11, signedUrl = signed }: {
  drift?: 'facts' | 'kv';
  maxRequests?: number;
  signedUrl?: string;
} = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'civic-acquisition-session-')));
  roots.push(parent);
  chmodSync(parent, 0o700);
  const root = join(parent, 'session');
  const calls: string[] = [];
  const wall = Date.UTC(2026, 9, 31);
  let monotonic = 0, facts = 0, values = 0, polls = 0;
  const select = vi.fn(() => ({ fixtureOnly: true as const, value: credential, expiresAt: wall + 60_000 }));
  const send = async (url: string, init: AcquisitionSendInit) => {
    expect(init.redirect).toBe('manual');
    expect(init.credentials).toBe('omit');
    if (url === signedUrl) {
      calls.push('download');
      expect(init.method).toBe('GET');
      expect(init.headers).toEqual({});
      return new Response(sql);
    }
    expect(init.headers.authorization).toBe(`Bearer ${credential}`);
    if (url === database + '/query') {
      const query = JSON.parse(String(init.body)).sql;
      if (query === queries['d1-schema']) {
        calls.push('schema');
        return envelope([{ type: 'table', name: 'sqlite_sequence', tbl_name: 'sqlite_sequence',
          sql: 'CREATE TABLE sqlite_sequence(name,seq)' }]);
      }
      expect(query).toBe(queries['d1-sequences']);
      calls.push('sequences');
      facts++;
      return envelope([{ name: 'corpus_runs', seq: drift === 'facts' && facts === 2 ? 2 : 1 }]);
    }
    if (url === database + '/export') {
      calls.push('export');
      polls++;
      const body = JSON.parse(String(init.body));
      if (polls === 1) {
        expect(body).not.toHaveProperty('current_bookmark');
        return Response.json({ success: true, result: { at_bookmark: 'fixture-export-bookmark' } });
      }
      expect(body.current_bookmark).toBe('fixture-export-bookmark');
      return Response.json({ success: true, result: { status: 'complete', result: { signed_url: signedUrl } } });
    }
    if (url === kv + '/keys?limit=100') {
      calls.push('keys');
      return Response.json({ success: true, result: [{ name: 'customer:fixture' }] });
    }
    expect(url).toBe(kv + '/values/customer%3Afixture');
    calls.push('value');
    values++;
    return Response.json(drift === 'kv' && values === 2 ? { ...customer, fuseLimit: 1001 } : customer);
  };
  const run = () => runFixtureAcquisitionSession({
    mode: 'fixture-only',
    sessionDirectory: root,
    transport: {
      validUntil: wall + 60_000, signedDownloadOrigin: downloadOrigin,
      limits: { maxRequests, wallMs: 10_000, managementMs: 1000, downloadMs: 1000, responseBytes: 262_144,
        downloadBytes: 1024, aggregateResponseBytes: 1_000_000, minStartSpacingMs: 1 },
      clock: { monotonic: () => monotonic, wall: () => wall, sleep: async (ms) => { monotonic += ms; } },
      syntheticCredential: select,
      send,
    },
    captureLimits: { maxRequests: 8, kvPages: 1, kvNames: 2, exportPolls: 2, minStartSpacingMs: 1, wallMs: 10_000, requestMs: 1000 },
  });
  return { root, run, calls, select };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('owned offline composition of the protected capture', () => {
  it('checks both facts and KV views before the exact signed download under one budget', async () => {
    const f = fixture();
    const receipt = await f.run();
    expect(f.calls).toEqual(['schema', 'sequences', 'keys', 'value', 'export', 'export', 'keys', 'value',
      'schema', 'sequences', 'download']);
    expect(f.select).toHaveBeenCalledTimes(1);
    expect(receipt).toMatchObject({
      fixtureSessionComplete: true, fixtureOnly: true, requests: 11, kvNames: 1, kvPages: [1, 1], exportPolls: 2,
      providerAuthenticated: false, globalQuiescenceEstablished: false, productionAcquisitionQualified: false,
      standaloneAcceptance: false, sql: { bytes: Buffer.byteLength(sql), sha256: hash(sql) },
    });
    expect(receipt.facts.before).toBe(hash(readFileSync(join(f.root, 'before', 'source-facts.json'))));
    expect(receipt.facts.after).toBe(hash(readFileSync(join(f.root, 'after', 'source-facts.json'))));
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE_SIGNED_VALUE|SYNTHETIC_MANAGEMENT|CREATE TABLE/);
    expect(readFileSync(join(f.root, 'transport', 'source.private.sql'), 'utf8')).toBe(sql);
    const result = join(f.root, 'transport', 'session.result.json');
    expect(JSON.parse(readFileSync(result, 'utf8'))).toEqual(receipt);
    expect(statSync(result).mode & 0o777).toBe(0o600);
    await expect(f.run()).rejects.toHaveProperty('code', 'ACQUISITION_SESSION_LOCAL');
    expect(f.calls).toHaveLength(11);
  });

  it.each([
    ['facts', 'ACQUISITION_SESSION_FACTS_DRIFT', 10],
    ['kv', 'ACQUISITION_KV_DRIFT', 8],
  ] as const)('terminally refuses %s drift before download', async (drift, code, count) => {
    const f = fixture({ drift });
    await expect(f.run()).rejects.toMatchObject({ code, ioSettled: true });
    expect(f.calls).toHaveLength(count);
    expect(f.calls).not.toContain('download');
    expect(existsSync(join(f.root, 'transport', 'owner.failure.json'))).toBe(true);
    expect(existsSync(join(f.root, 'transport', 'session.result.json'))).toBe(false);
    await expect(f.run()).rejects.toHaveProperty('code', 'ACQUISITION_SESSION_LOCAL');
    expect(f.calls).toHaveLength(count);
  });

  it('refuses to reset the shared budget for the final download', async () => {
    const f = fixture({ maxRequests: 10 });
    await expect(f.run()).rejects.toHaveProperty('code', 'ACQUISITION_TRANSPORT_REQUEST_BOUND');
    expect(f.calls).toHaveLength(10);
    expect(f.calls).not.toContain('download');
    expect(existsSync(join(f.root, 'transport', 'source.private.sql'))).toBe(false);
  });

  it('retains the descriptor but refuses download outside the pinned origin', async () => {
    const f = fixture({ signedUrl: 'https://wrong-fixture.invalid/private.sql' });
    await expect(f.run()).rejects.toHaveProperty('code', 'ACQUISITION_TRANSPORT_ORIGIN');
    expect(f.calls).toHaveLength(10);
    expect(existsSync(join(f.root, 'capture', 'signed-export-descriptor.private.json'))).toBe(true);
    expect(existsSync(join(f.root, 'transport', 'session.result.json'))).toBe(false);
  });
});
