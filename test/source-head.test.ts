import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubCorpusSource } from '../src/ingest/source';
import { parseSourceHeadRateLimits, parseSourceHeadRevision, requestSourceHead, SourceHeadError,
  SOURCE_HEAD_MAX_BYTES, SOURCE_HEAD_TIMEOUT_MS, type SourceHeadSend } from '../src/ingest/source-head';

const api = 'https://source.invalid/repos/justicecanada/laws-lois-xml';
const commit = '0507465393c224c0491fc8c17c88340217acc656';
const revision = { sha: commit, commit: { committer: { date: '2026-10-15T12:34:56Z' } } };
const request = (send: SourceHeadSend) => requestSourceHead(api, 'main', { 'user-agent': 'source-test' }, send);
const json = (value: unknown) => new Response(JSON.stringify(value));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('bounded corpus source head', () => {
  it('reads one metadata commit with the existing auth, accept, user agent and selected branch', async () => {
    const secret = 'PRIVATE-EXPLICIT-ENV-TOKEN';
    const send = vi.fn<SourceHeadSend>(async () => json([revision]));
    vi.stubGlobal('fetch', send);
    const source = new GitHubCorpusSource({ api, token: secret, branch: 'feature/é' });
    expect(await source.head()).toEqual({ commit, date: '2026-10-15' });
    expect(send).toHaveBeenCalledOnce();
    const [url, init] = send.mock.calls[0]!;
    const actual = new URL(url);
    expect(actual.pathname).toBe('/repos/justicecanada/laws-lois-xml/commits');
    expect([...actual.searchParams]).toEqual([['sha', 'feature/é'], ['per_page', '1']]);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: {
      accept: 'application/vnd.github+json', 'user-agent': 'civicsignal-corpus-pipeline', authorization: `Bearer ${secret}`,
    } });
    expect(init.signal?.aborted).toBe(false);
  });

  it('keeps anonymous discovery anonymous and full-SHA branch lookup exact', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const send: SourceHeadSend = async (url, init) => { calls.push({ url, init }); return json([revision]); };
    vi.stubGlobal('fetch', send);
    expect(await new GitHubCorpusSource({ api, branch: commit }).head()).toEqual({ commit, date: '2026-10-15' });
    expect(new URL(calls[0]!.url).searchParams.get('sha')).toBe(commit);
    expect(new Headers(calls[0]!.init.headers).has('authorization')).toBe(false);
  });

  it('uses the metadata list rather than a large detailed commit and accepts a large bounded message', async () => {
    const detailed = { ...revision, files: [{ patch: 'x'.repeat(2 * SOURCE_HEAD_MAX_BYTES) }] };
    expect(Buffer.byteLength(JSON.stringify(detailed))).toBeGreaterThan(SOURCE_HEAD_MAX_BYTES);
    const send = vi.fn<SourceHeadSend>(async (url) => {
      expect(new URL(url).searchParams.get('per_page')).toBe('1');
      expect(new URL(url).pathname.endsWith('/commits')).toBe(true);
      return json([{ ...revision, commit: { ...revision.commit, message: 'é'.repeat(160_000) } }]);
    });
    expect(await request(send)).toEqual({ commit, date: '2026-10-15' });
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([403, 429])('reports primary exhaustion only with status%s and numeric remaining0', async (status) => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status, headers: {
      'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-used': '60',
      'x-ratelimit-reset': '1792766400', 'retry-after': '30', 'x-ratelimit-resource': 'PRIVATE',
    } });
    const send = vi.fn<SourceHeadSend>(async () => response);
    await expect(request(send)).rejects.toMatchObject({ name: 'SourceHeadError', code: 'primary-rate-limit', status,
      rateLimits: { limit: 60, remaining: 0, used: 60, reset: 1792766400, retryAfterSeconds: 30 } });
    expect(send).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    [403, '1'], [403, '0e0'], [403, '0,0'], [429, undefined], [503, '0'],
  ])('leaves status%s remaining%s as refused without asserting a reason', async (status, remaining) => {
    const headers: Record<string,string> = remaining === undefined ? {} : { 'x-ratelimit-remaining': remaining };
    await expect(request(async () => new Response('PRIVATE SERVER BODY', { status, headers }))).rejects.toMatchObject({ code: 'http-refused', status });
  });

  it('never reads or exposes a refused body, raw headers, URL, token or transport cause', async () => {
    const secret = 'PRIVATE-MARKER'; let pulls = 0;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ pull() { pulls++; }, cancel }), { status: 403,
      headers: { 'x-ratelimit-remaining': 'PRIVATE-MARKER', 'set-cookie': secret, 'retry-after': secret } });
    let error: unknown;
    try { await requestSourceHead(api + '/PRIVATE-MARKER', 'main', { authorization: `Bearer ${secret}` }, async () => response); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(SourceHeadError); expect(cancel).toHaveBeenCalledOnce();
    // The stream may pre-pull once when constructed, but the client acquires no reader.
    expect(pulls).toBeLessThanOrEqual(1);
    expect(String(error) + JSON.stringify(error)).not.toMatch(/PRIVATE|source\.invalid|set-cookie|authorization/);
    expect(error).not.toHaveProperty('cause');
    await expect(request(async () => { throw new TypeError(`PRIVATE-MARKER at ${api}`); })).rejects.toMatchObject({ code: 'transport' });
  });

  it.each([301, 302, 307, 308])('refuses redirect%s without following it or reading its body', async (status) => {
    const cancel = vi.fn(), send = vi.fn<SourceHeadSend>(async (_url, init) => {
      expect(init.redirect).toBe('manual');
      return new Response(new ReadableStream({ cancel }), { status, headers: { location: 'https://PRIVATE.invalid' } });
    });
    await expect(request(send)).rejects.toMatchObject({ code: 'redirect-refused', status });
    expect(send).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds declared bytes before reading and cancels the body', async () => {
    const cancel = vi.fn();
    await expect(request(async () => new Response(new ReadableStream({ cancel }), {
      headers: { 'content-length': String(SOURCE_HEAD_MAX_BYTES + 1) },
    }))).rejects.toMatchObject({ code: 'response-too-large' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds actual streamed bytes even when Content-Length is small or absent', async () => {
    for (const headers of [new Headers(), new Headers({ 'content-length': '2' })]) {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(SOURCE_HEAD_MAX_BYTES)); c.enqueue(new Uint8Array(1)); }, cancel });
      await expect(request(async () => new Response(body, { headers }))).rejects.toMatchObject({ code: 'response-too-large' });
      expect(cancel).toHaveBeenCalledOnce();
    }
  });

  it.each(['NaN', '-1', '1e6', '1,2', '9007199254740992'])('refuses malformed Content-Length%s', async (value) => {
    await expect(request(async () => new Response('[]', { headers: { 'content-length': value } }))).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it.each([[], [revision, revision], revision, [{ sha: 'short', commit: revision.commit }],
    [{ ...revision, commit: {} }], [{ ...revision, commit: { committer: { date: '2026-02-30T00:00:00Z' } } }],
    [{ ...revision, commit: { committer: { date: 'PRIVATE' } } }], null])('refuses malformed nominal success%j', async value => {
    await expect(request(async () => json(value))).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('refuses invalid JSON, invalid UTF8 and a failing body without exposing their data', async () => {
    const responses = [new Response('PRIVATE not JSON'), new Response(new Uint8Array([0xff])),
      new Response(new ReadableStream({ pull() { throw Error('PRIVATE stream error'); } }))];
    for (const response of responses) {
      try { await request(async () => response); throw Error('Expected refusal'); }
      catch (error) { expect(error).toBeInstanceOf(SourceHeadError); expect(String(error)+JSON.stringify(error)).not.toContain('PRIVATE'); }
    }
  });

  it('enforces one total deadline while fetch is pending, aborting without retry', async () => {
    vi.useFakeTimers();
    const send = vi.fn<SourceHeadSend>(() => new Promise(() => {}));
    const pending = request(send), refused = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(SOURCE_HEAD_TIMEOUT_MS); await refused;
    expect(send).toHaveBeenCalledOnce(); expect(send.mock.calls[0]![1].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the same total deadline for the body and cancels a pending read', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(); const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('[')); }, cancel });
    const send = vi.fn<SourceHeadSend>(async () => new Response(body));
    const pending = request(send), refused = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(SOURCE_HEAD_TIMEOUT_MS); await refused;
    expect(cancel).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a late fetch response if a transport ignored the already-expired abort', async () => {
    vi.useFakeTimers();
    let deliver!: (response: Response) => void;
    const send = vi.fn<SourceHeadSend>(() => new Promise(resolve => { deliver = resolve; }));
    const pending = request(send), refused = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(SOURCE_HEAD_TIMEOUT_MS); await refused;
    const cancel = vi.fn();
    deliver(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('public source-head metadata parsers', () => {
  it('retains only strict unsigned safe numeric rate-limit fields', () => {
    expect(parseSourceHeadRateLimits(new Headers({ 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0',
      'x-ratelimit-used': '60', 'x-ratelimit-reset': '1792766400', 'retry-after': '86400',
      'x-ratelimit-resource': 'PRIVATE', server: 'PRIVATE' }))).toEqual({ limit: 60, remaining: 0, used: 60, reset: 1792766400, retryAfterSeconds: 86400 });
  });
  it.each(['-1', '+1', '00', '1.0', '1e3', '1,2', 'NaN', 'Infinity', '9007199254740992', ' PRIVATE '])('omits malformed numeric fields%s', value => {
    const headers = { get: () => value };
    expect(parseSourceHeadRateLimits(headers)).toEqual({});
  });
  it('omits HTTP-date and excessive Retry-After instead of inferring a clock-based delay', () => {
    for (const value of ['86401', 'Fri, 23 Oct 2026 14:00:00 GMT']) {
      expect(parseSourceHeadRateLimits(new Headers({ 'retry-after': value }))).toEqual({});
    }
  });
  it('preserves the original date-prefix contract for a valid offset timestamp', () => {
    expect(parseSourceHeadRevision({ ...revision, commit: { committer: { date: '2026-10-15T23:30:00-04:00' } } })).toEqual({ commit, date: '2026-10-15' });
  });
  it.each(['2026-10-15T24:00:00Z','2026-10-15T12:60:00Z','2026-10-15T12:00:60Z','2026-10-15T12:00:00+24:00'])('refuses normalized invalid timestamp%s', timestamp => {
    expect(()=>parseSourceHeadRevision({ ...revision, commit: { committer: { date: timestamp } } })).toThrow(SourceHeadError);
  });
  it('persists code/status/numeric quota metadata within the coordinator500-character bound', () => {
    const error = new SourceHeadError('primary-rate-limit',403,{limit:Number.MAX_SAFE_INTEGER,remaining:0,used:Number.MAX_SAFE_INTEGER,reset:Number.MAX_SAFE_INTEGER,retryAfterSeconds:86400});
    const saved = String(error).slice(0,500);
    expect(saved).toBe(String(error)); expect(saved.length).toBeLessThan(500);
    const projection=JSON.parse(saved.slice('SourceHeadError: Corpus source head failed: '.length));
    expect(projection).toEqual({code:'primary-rate-limit',status:403,rateLimits:{limit:Number.MAX_SAFE_INTEGER,remaining:0,used:Number.MAX_SAFE_INTEGER,reset:Number.MAX_SAFE_INTEGER,retryAfterSeconds:86400}});
    expect(String(new SourceHeadError('http-refused',403,{remaining:Number.NaN,retryAfterSeconds:86401}))).not.toMatch(/NaN|86401/);
  });
});
