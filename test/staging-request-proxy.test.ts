import { appendFileSync, existsSync, fsyncSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileRelayLedger, MAX_RELAY_BODY_BYTES, stagingRequestRelay, stagingTarget } from '../scripts/lib/staging-request-relay';

const target = 'https://civicsignal-v1-stage-api-20261022.example-account.workers.dev';
function fixture(limit = 160) {
  const directory = mkdtempSync(join(tmpdir(), 'civicsignal-stage-relay-'));
  const path = join(directory, 'requests.jsonl');
  const ledger = new FileRelayLedger({ path, targetOrigin: target, limit });
  return { path, ledger, cleanup() { ledger.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const sender = (work: (request: Request) => Promise<Response>) => work as typeof fetch;

describe('strict staging target', () => {
  it.each(['https://civicsignal.example-account.workers.dev', 'https://api.civicsignal.chesterhillsolutions.ca',
    target.replace('https:', 'http:'), `${target}/api/statutes`, `${target}?key=PRIVATE`, `${target}#PRIVATE`,
    target.replace('https://', 'https://user:PRIVATE@'), target.replace('.workers.dev', '.workers.dev.evil.test'),
    target.replace('-api-', '-encoder-'), 'https://civicsignal-v1-stage-api-.example-account.workers.dev', 'not-a-url'])('rejects %s before any fetch or file operation', (origin) => {
    let fetched = false;
    expect(() => stagingRequestRelay({ targetOrigin: origin, ledger: { targetOrigin: origin, limit: 160, reserve() { throw new Error('must not reserve'); } },
      fetch: sender(async () => { fetched = true; return new Response(); }) })).toThrow();
    expect(fetched).toBe(false);
  });
});

describe('durable local staging ledger', () => {
  it('rejects limits above 160, invalid timeouts and a mismatched ledger identity before forwarding', () => {
    const directory = mkdtempSync(join(tmpdir(), 'civicsignal-stage-config-'));
    const path = join(directory, 'requests.jsonl');
    try {
      for (const limit of [0, -1, 161, NaN, 1.5]) {
        expect(() => new FileRelayLedger({ path, targetOrigin: target, limit })).toThrow('1 to 160');
        expect(existsSync(path)).toBe(false);
        expect(existsSync(`${path}.lock`)).toBe(false);
      }
      const ledger = new FileRelayLedger({ path, targetOrigin: target });
      for (const timeoutMs of [0, 60001, NaN]) expect(() => stagingRequestRelay({ targetOrigin: target, ledger, timeoutMs })).toThrow('timeout');
      expect(() => stagingRequestRelay({ targetOrigin: target.replace('20261022', '20261023'), ledger })).toThrow('identity');
      ledger.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('fsyncs reservations, enforces the cap across clean restarts, and binds the exact target and limit', () => {
    const h = fixture(2);
    try {
      h.ledger.reserve('GET', '/api/statutes');
      h.ledger.close();
      const resumed = new FileRelayLedger({ path: h.path, targetOrigin: target, limit: 2 });
      expect(resumed.status()).toMatchObject({ reserved: 1, remaining: 1 });
      resumed.reserve('POST', '/mcp'); resumed.close();
      expect(FileRelayLedger.inspect(h.path, target, 2)).toMatchObject({ reserved: 2, remaining: 0 });
      const exhausted = new FileRelayLedger({ path: h.path, targetOrigin: target, limit: 2 });
      expect(() => exhausted.reserve('GET', '/api/statutes')).toThrow('budget exhausted'); exhausted.close();
      expect(() => new FileRelayLedger({ path: h.path, targetOrigin: target, limit: 3 })).toThrow('target/limit');
      expect(() => new FileRelayLedger({ path: h.path, targetOrigin: target.replace('20261022', '20261023'), limit: 2 })).toThrow('target/limit');
      expect(FileRelayLedger.inspect(h.path, target, 2).reserved).toBe(2);
    } finally { h.cleanup(); }
  });
  it('excludes a competing process and refuses stale locks instead of racing automatic deletion', () => {
    const h = fixture();
    try {
      expect(() => new FileRelayLedger({ path: h.path, targetOrigin: target })).toThrow('lock exists');
      h.ledger.close();
      writeFileSync(`${h.path}.lock`, JSON.stringify({ format: 1, pid: 99999999, token: 'stale' }));
      expect(() => new FileRelayLedger({ path: h.path, targetOrigin: target })).toThrow('lock exists');
      expect(existsSync(`${h.path}.lock`)).toBe(true);
    } finally { h.cleanup(); }
  });
  it.each(['partial', 'sequence', 'unexpected-field', 'empty'])('fails closed for %s crash/inconsistent ledger without repairing it', (kind) => {
    const h = fixture();
    try {
      h.ledger.close();
      if (kind === 'partial') appendFileSync(h.path, '{"seq":1');
      if (kind === 'sequence') appendFileSync(h.path, JSON.stringify({ seq: 2, method: 'GET', pathname: '/api/statutes', time: new Date().toISOString() }) + '\n');
      if (kind === 'unexpected-field') appendFileSync(h.path, JSON.stringify({ seq: 1, method: 'GET', pathname: '/api/statutes', time: new Date().toISOString(), apiKey: 'DO-NOT-LOG' }) + '\n');
      if (kind === 'empty') writeFileSync(h.path, '');
      const original = readFileSync(h.path);
      expect(() => new FileRelayLedger({ path: h.path, targetOrigin: target })).toThrow();
      expect(readFileSync(h.path)).toEqual(original);
      expect(existsSync(`${h.path}.lock`)).toBe(false);
    } finally { h.cleanup(); }
  });
  it('never sends after an uncertain fsync acknowledgement and conservatively retains the complete reservation on restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'civicsignal-stage-fsync-'));
    const path = join(directory, 'requests.jsonl');
    let fail = false; let calls = 0;
    const ledger = new FileRelayLedger({ path, targetOrigin: target, limit: 2, sync(fd) { fsyncSync(fd); if (fail) throw new Error('uncertain fsync acknowledgement'); } });
    try {
      fail = true;
      const relay = stagingRequestRelay({ targetOrigin: target, ledger, fetch: sender(async () => { calls++; return new Response('ok'); }) });
      expect((await relay(new Request('http://127.0.0.1/api/statutes'))).status).toBe(503);
      expect((await relay(new Request('http://127.0.0.1/api/statutes'))).status).toBe(503);
      expect(calls).toBe(0);
      fail = false; ledger.close();
      const resumed = new FileRelayLedger({ path, targetOrigin: target, limit: 2 });
      expect(resumed.status()).toMatchObject({ reserved: 1, remaining: 1 }); resumed.close();
    } finally { fail = false; ledger.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('bounded HTTP/MCP forwarding', () => {
  it('counts concurrent failed attempts exactly once before fetch and never exceeds the durable cap', async () => {
    const h = fixture(5); let calls = 0;
    try {
      const relay = stagingRequestRelay({ targetOrigin: target, ledger: h.ledger, fetch: sender(async () => {
        calls++;
        expect(FileRelayLedger.inspect(h.path, target, 5).reserved).toBeGreaterThanOrEqual(calls);
        if (calls % 2) throw new Error('transport failure PRIVATE-KEY');
        return new Response('upstream unavailable', { status: 503 });
      }) });
      const responses = await Promise.all(Array.from({ length: 20 }, () => relay(new Request('http://127.0.0.1/mcp', { method: 'POST', body: '{}' }))));
      expect(calls).toBe(5);
      expect(responses.filter((response) => response.status === 429)).toHaveLength(15);
      expect(h.ledger.status().reserved).toBe(5);
      for (const response of responses) expect(await response.text()).not.toContain('PRIVATE-KEY');
    } finally { h.cleanup(); }
  });
  it('forwards auth/BYOK/body/query without persisting them, fixes the origin even for // paths, and labels overhead', async () => {
    const h = fixture();
    try {
      const relay = stagingRequestRelay({ targetOrigin: target, ledger: h.ledger, fetch: sender(async (request) => {
        const url = new URL(request.url);
        expect(url.origin).toBe(target);
        expect(url.pathname).toBe('//production.example/api/statutes');
        expect(url.searchParams.get('key')).toBe('QUERY-PRIVATE');
        expect(request.headers.get('authorization')).toBe('Bearer API-PRIVATE');
        expect(request.headers.get('x-byok-key')).toBe('BYOK-PRIVATE');
        expect(request.headers.has('host')).toBe(false);
        expect(await request.text()).toBe('BODY-PRIVATE');
        expect(request.redirect).toBe('error');
        return new Response('response', { headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' } });
      }) });
      const response = await relay(new Request('http://127.0.0.1//production.example/api/statutes?key=QUERY-PRIVATE', {
        method: 'POST', headers: { authorization: 'Bearer API-PRIVATE', 'x-byok-key': 'BYOK-PRIVATE', host: 'production.example' }, body: 'BODY-PRIVATE' }));
      expect(await response.text()).toBe('response');
      expect(response.headers.get('x-civicsignal-staging-target')).toBe(target);
      expect(Number(response.headers.get('x-civicsignal-staging-proxy-prepare-ms'))).toBeGreaterThanOrEqual(0);
      expect(response.headers.has('content-encoding')).toBe(false);
      const ledger = readFileSync(h.path, 'utf8');
      expect(ledger).not.toMatch(/API-PRIVATE|BYOK-PRIVATE|BODY-PRIVATE|QUERY-PRIVATE|authorization|byok/);
      const [header, attempt] = ledger.trim().split('\n').map((line) => JSON.parse(line));
      expect(header.targetOrigin).toBe(target);
      expect(Object.keys(attempt).sort()).toEqual(['method', 'pathname', 'seq', 'time']);
    } finally { h.cleanup(); }
  });
  it('rejects oversized bodies before reservation and permits exactly 128 KiB', async () => {
    const h = fixture(); let calls = 0;
    try {
      const relay = stagingRequestRelay({ targetOrigin: target, ledger: h.ledger, fetch: sender(async (request) => { calls++; expect((await request.arrayBuffer()).byteLength).toBe(MAX_RELAY_BODY_BYTES); return new Response('ok'); }) });
      const oversized = await relay(new Request('http://127.0.0.1/mcp', { method: 'POST', body: new Uint8Array(MAX_RELAY_BODY_BYTES + 1) }));
      expect(oversized.status).toBe(413); expect(h.ledger.status().reserved).toBe(0);
      const declared = await relay(new Request('http://127.0.0.1/mcp', { method: 'POST', headers: { 'content-length': String(MAX_RELAY_BODY_BYTES + 1) }, body: '{}' }));
      expect(declared.status).toBe(413);
      const accepted = await relay(new Request('http://127.0.0.1/mcp', { method: 'POST', body: new Uint8Array(MAX_RELAY_BODY_BYTES) }));
      expect(await accepted.text()).toBe('ok'); expect(calls).toBe(1); expect(h.ledger.status().reserved).toBe(1);
    } finally { h.cleanup(); }
  });
  it('never follows or forwards an upstream redirect to production', async () => {
    const h = fixture(); let calls = 0;
    try {
      const relay = stagingRequestRelay({ targetOrigin: target, ledger: h.ledger, fetch: sender(async (request) => {
        calls++; expect(request.redirect).toBe('error'); return new Response(null, { status: 302, headers: { location: 'https://api.civicsignal.chesterhillsolutions.ca' } });
      }) });
      const response = await relay(new Request('http://127.0.0.1/api/statutes'));
      expect(response.status).toBe(502); expect(response.headers.has('location')).toBe(false); expect(calls).toBe(1); expect(h.ledger.status().reserved).toBe(1);
    } finally { h.cleanup(); }
  });
  it('refuses a send when the deadline expires during the durable reservation, retaining that reservation', async () => {
    const h = fixture(); let calls = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const reserve = h.ledger.reserve.bind(h.ledger);
    vi.spyOn(h.ledger, 'reserve').mockImplementation((method, pathname) => {
      const attempt = reserve(method, pathname);
      // Native fsync can consume the whole deadline before the timer callback
      // gets a turn. Advance only monotonic time, without firing that timer.
      vi.spyOn(performance, 'now').mockReturnValue(11);
      return attempt;
    });
    try {
      const relay = stagingRequestRelay({ targetOrigin: target, ledger: h.ledger, timeoutMs: 10,
        fetch: sender(async () => { calls++; return new Response('unexpected'); }) });
      const response = await relay(new Request('http://127.0.0.1/api/statutes'));
      expect(response.status).toBe(504); expect(calls).toBe(0); expect(h.ledger.status().reserved).toBe(1);
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); h.cleanup(); }
  });
  it('aborts an entered upstream call on deadline or caller cancellation without refunding reservations', async () => {
    const h = fixture(); let outbound: AbortSignal | undefined;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    try {
      const relay = stagingRequestRelay({ targetOrigin: target, ledger: h.ledger, timeoutMs: 10,
        fetch: sender(async (request) => { outbound = request.signal; entered(); return new Promise<Response>(() => {}); }) });
      const pendingDeadline = relay(new Request('http://127.0.0.1/api/statutes'));
      await started;
      expect(outbound?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      const response = await pendingDeadline;
      expect(response.status).toBe(504); expect(outbound?.aborted).toBe(true); expect(h.ledger.status().reserved).toBe(1);
      const abort = new AbortController();
      let enteredAgain!: () => void; const startedAgain = new Promise<void>((resolve) => { enteredAgain = resolve; });
      const cancellable = stagingRequestRelay({ targetOrigin: target, ledger: h.ledger,
        fetch: sender(async () => { enteredAgain(); return new Promise<Response>(() => {}); }) });
      const pending = cancellable(new Request('http://127.0.0.1/mcp', { signal: abort.signal }));
      await startedAgain; abort.abort();
      expect((await pending).status).toBe(499); expect(h.ledger.status().reserved).toBe(2);
    } finally { vi.useRealTimers(); h.cleanup(); }
  });
  it('keeps the deadline active while a streaming MCP response is open', async () => {
    const h = fixture(); let cancelled = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    try {
      const relay = stagingRequestRelay({ targetOrigin: target, ledger: h.ledger, timeoutMs: 10,
        fetch: sender(async () => { entered(); return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }); }) });
      const pending = relay(new Request('http://127.0.0.1/mcp'));
      await started;
      const response = await pending;
      const rejected = expect(response.text()).rejects.toThrow('aborted');
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      expect(cancelled).toBe(true); expect(h.ledger.status().reserved).toBe(1);
    } finally { vi.useRealTimers(); h.cleanup(); }
  });
});
