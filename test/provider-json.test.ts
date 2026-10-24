import { afterEach, describe, expect, it, vi } from 'vitest';
import { providerJsonOnce, ProviderJsonError, type ProviderJsonOptions, type ProviderJsonPhase } from '../src/provider-json';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const privateValue = 'synthetic-private-provider-value';
const utf8 = (text: string) => new TextEncoder().encode(text);
function options(overrides: Partial<ProviderJsonOptions<unknown>> = {}): ProviderJsonOptions<unknown> {
  return { url: 'https://provider.invalid/messages', headers: { authorization: 'Bearer synthetic-key' },
    body: { input: 'synthetic request' }, timeoutMs: 1000, responseBytes: 1024,
    send: vi.fn<typeof fetch>(async () => Response.json({ answer: 'A response.' })), parse: value => value, ...overrides };
}
async function refusal(pending: Promise<unknown>, phase: ProviderJsonPhase, status?: number) {
  let caught: unknown;
  try { await pending; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ProviderJsonError);
  expect(caught).toMatchObject({ phase, message: 'The provider JSON exchange did not complete.' });
  expect((caught as ProviderJsonError).httpStatus).toBe(status);
  expect('cause' in (caught as ProviderJsonError)).toBe(false);
  expect(String(caught) + JSON.stringify(caught)).not.toContain(privateValue);
}

describe('one bounded provider JSON exchange', () => {
  it('makes one POST with exact caller headers/body and validates within the exchange', async () => {
    const send = vi.fn<typeof fetch>(async () => Response.json({ answer: 'checked' }));
    const parse = vi.fn((value: unknown) => ({ accepted: value }));
    expect(await providerJsonOnce(options({ send, parse }))).toEqual({ accepted: { answer: 'checked' } });
    expect(send).toHaveBeenCalledTimes(1); expect(parse).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe('https://provider.invalid/messages'); expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual'); expect(JSON.parse(String(init?.body))).toEqual({ input: 'synthetic request' });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-key');
    expect(init?.signal?.aborted).toBe(false);
  });

  it('resolves default fetch per invocation so callers can intercept every transport', async () => {
    const input = options(); delete input.send;
    const send = vi.fn<typeof fetch>(async () => Response.json({ intercepted: true })); vi.stubGlobal('fetch', send);
    expect(await providerJsonOnce(input)).toEqual({ intercepted: true }); expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not serialize or send an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    const toJSON = vi.fn(() => { throw Error(privateValue); }), send = vi.fn<typeof fetch>();
    await refusal(providerJsonOnce(options({ signal: controller.signal, body: { toJSON }, send })), 'cancelled');
    expect(toJSON).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it.each(['cycle', 'bigint', 'undefined', 'throw'] as const)('sanitizes request serialization %s before sending', async kind => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const body = kind === 'cycle' ? cycle : kind === 'bigint' ? 1n : kind === 'undefined' ? undefined : { toJSON() { throw Error(privateValue); } };
    const send = vi.fn<typeof fetch>();
    await refusal(providerJsonOnce(options({ body, send })), 'request-serialization'); expect(send).not.toHaveBeenCalled();
  });

  it('uses UTF-8 request bytes for its optional pre-send cap', async () => {
    const send = vi.fn<typeof fetch>();
    await refusal(providerJsonOnce(options({ body: 'é', requestBytes: 3, send })), 'request-serialization');
    expect(send).not.toHaveBeenCalled();
    const success = options({ body: 'é', requestBytes: 4 }); expect(await providerJsonOnce(success)).toEqual({ answer: 'A response.' });
  });

  it('checks elapsed time after synchronous request serialization', async () => {
    let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const send = vi.fn<typeof fetch>();
    await refusal(providerJsonOnce(options({ timeoutMs: 5, send, body: { toJSON() { clock = 6; return {}; } } })), 'timeout');
    expect(send).not.toHaveBeenCalled();
  });

  it.each([302, 401, 429, 503])('returns only observed HTTP%s and cancels without parsing or retry', async status => {
    let cancelled = 0;
    const send = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }), { status }));
    const parse = vi.fn(); await refusal(providerJsonOnce(options({ send, parse })), 'upstream-http', status);
    expect(send).toHaveBeenCalledTimes(1); expect(parse).not.toHaveBeenCalled(); expect(cancelled).toBe(1);
  });

  it('sanitizes a transport rejection and does not invent an HTTP status', async () => {
    const send = vi.fn<typeof fetch>(async () => { throw Error(privateValue); });
    await refusal(providerJsonOnce(options({ send })), 'transport'); expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['100000', '-1', 'NaN', '9007199254740993'])('rejects invalid/oversized declared length %s before reading', async length => {
    let cancelled = 0; const parse = vi.fn();
    const send = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }), { headers: { 'content-length': length } }));
    await refusal(providerJsonOnce(options({ send, parse })), 'response-body', 200);
    expect(cancelled).toBe(1); expect(parse).not.toHaveBeenCalled();
  });

  it('caps actual streamed bytes despite an understated length', async () => {
    let cancelled = 0; const parse = vi.fn();
    const send = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(utf8('12345')); }, cancel() { cancelled++; },
    }), { headers: { 'content-length': '1' } }));
    await refusal(providerJsonOnce(options({ send, parse, responseBytes: 4 })), 'response-body', 200);
    expect(cancelled).toBe(1); expect(parse).not.toHaveBeenCalled();
  });

  it('keeps the admitted response limit despite later caller option mutation', async () => {
    const input = options({ responseBytes: 4 });
    input.send = async () => { input.responseBytes = 1000; return new Response('12345'); };
    await refusal(providerJsonOnce(input), 'response-body', 200);
  });

  it('sanitizes body read errors', async () => {
    const send = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.error(Error(privateValue)); } })));
    await refusal(providerJsonOnce(options({ send })), 'response-body', 200);
  });

  it.each(['invalid-json', 'invalid-utf8'])('refuses %s before domain validation', async kind => {
    const parse = vi.fn(); const send = vi.fn<typeof fetch>(async () => new Response(kind === 'invalid-json' ? privateValue : new Uint8Array([0x22, 0xc3, 0x28, 0x22])));
    await refusal(providerJsonOnce(options({ send, parse })), 'response-parse', 200); expect(parse).not.toHaveBeenCalled();
  });

  it('maps every callback exception to response-validation without its cause or text', async () => {
    await refusal(providerJsonOnce(options({ parse() { throw Error(privateValue); } })), 'response-validation', 200);
    await refusal(providerJsonOnce(options({ parse() { throw new ProviderJsonError('transport', 401); } })), 'response-validation', 200);
  });

  it('checks elapsed time after JSON.parse and after domain validation', async () => {
    let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const original = JSON.parse; vi.spyOn(JSON, 'parse').mockImplementation((text: string) => { const value: unknown = original(text); clock = 6; return value; });
    await refusal(providerJsonOnce(options({ timeoutMs: 5, send: async () => new Response('{"ok":true}') })), 'timeout', 200);
    vi.mocked(JSON.parse).mockRestore(); clock = 0;
    await refusal(providerJsonOnce(options({ timeoutMs: 5, parse() { clock = 6; return {}; } })), 'timeout', 200);
  });

  it('detects immediately fulfilled empty-chunk overruns even before timers fire', async () => {
    let clock = 0, cancelled = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const send = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      pull(c) { clock += 2; c.enqueue(new Uint8Array()); }, cancel() { cancelled++; },
    }, { highWaterMark: 0 })));
    await refusal(providerJsonOnce(options({ send, timeoutMs: 5 })), 'timeout', 200);
    expect(cancelled).toBe(1); expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['fetch', 'body', 'cleanup', 'validation'] as const)('bounds a stalled %s using the original timer', async kind => {
    vi.useFakeTimers(); vi.spyOn(performance, 'now').mockReturnValue(0); let cancelled = 0;
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const send = vi.fn<typeof fetch>(async () => {
      if (kind === 'fetch') { entered(); return new Promise<Response>(() => {}); }
      if (kind === 'validation') return Response.json({ ok: true });
      return new Response(new ReadableStream<Uint8Array>({
        pull() { if (kind === 'body') entered(); },
        cancel() { cancelled++; if (kind === 'cleanup') { entered(); return new Promise<void>(() => {}); } },
      }, { highWaterMark: 0 }), { status: kind === 'cleanup' ? 503 : 200 });
    });
    const pending = refusal(providerJsonOnce(options({ send, timeoutMs: 5, parse: kind === 'validation' ? () => { entered(); return new Promise(() => {}); } : value => value })), kind === 'cleanup' ? 'upstream-http' : 'timeout', kind === 'fetch' ? undefined : kind === 'cleanup' ? 503 : 200);
    await ready;
    await vi.advanceTimersByTimeAsync(6); await pending;
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    if (kind === 'body' || kind === 'cleanup') expect(cancelled).toBe(1);
  });

  it('cancels a fetch response that fulfils after the terminal timeout', async () => {
    vi.useFakeTimers(); vi.spyOn(performance, 'now').mockReturnValue(0); let resolve!: (response: Response) => void, cancelled = 0;
    const send = vi.fn<typeof fetch>(() => new Promise<Response>(r => { resolve = r; }));
    const pending = refusal(providerJsonOnce(options({ send, timeoutMs: 5 })), 'timeout');
    await vi.advanceTimersByTimeAsync(6); await pending;
    resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } })));
    await Promise.resolve(); await Promise.resolve(); expect(cancelled).toBe(1); expect(send).toHaveBeenCalledTimes(1);
  });

  it('cancels a fulfilled fetch whose synchronous work crossed the deadline', async () => {
    let clock = 0, cancelled = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const send = vi.fn<typeof fetch>(async () => { clock = 6; return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } })); });
    // The deadline is observed before the Promise fulfils: no HTTP status yet.
    await refusal(providerJsonOnce(options({ send, timeoutMs: 5 })), 'timeout'); expect(cancelled).toBe(1);
  });

  it('retains actual response status when observing it crosses the deadline', async () => {
    let clock = 0, cancelled = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const send = vi.fn<typeof fetch>(async () => {
      const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }));
      Object.defineProperty(response, 'status', { get() { clock = 6; return 200; } }); return response;
    });
    await refusal(providerJsonOnce(options({ send, timeoutMs: 5 })), 'timeout', 200); expect(cancelled).toBe(1);
  });

  it('propagates parent cancellation through an ignored-abort body and bounds its cleanup', async () => {
    vi.useFakeTimers(); vi.spyOn(performance, 'now').mockReturnValue(0); const parent = new AbortController(); let cancelled = 0;
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const send = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      pull() { entered(); }, cancel() { cancelled++; return new Promise<void>(() => {}); },
    }, { highWaterMark: 0 })));
    const pending = refusal(providerJsonOnce(options({ send, signal: parent.signal, timeoutMs: 10 })), 'cancelled', 200);
    await ready; parent.abort(); await pending;
    expect(cancelled).toBe(1); expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not accept cleanup that synchronously overruns the deadline', async () => {
    let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const send = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { clock = 6; } }), { status: 503 }));
    await refusal(providerJsonOnce(options({ send, timeoutMs: 5 })), 'upstream-http', 503);
  });

  it.each(['pending', 'throw'] as const)('does not accept a successful payload with %s reader cleanup', async kind => {
    vi.useFakeTimers(); vi.spyOn(performance, 'now').mockReturnValue(0); let cancelled = 0;
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const send = vi.fn<typeof fetch>(async () => {
      const response = Response.json({ ok: true }), body = response.body!, getReader = body.getReader.bind(body);
      Object.defineProperty(body, 'getReader', { value() {
        const reader = getReader(); Object.defineProperty(reader, 'cancel', { value() {
          cancelled++; entered(); if (kind === 'throw') throw Error(privateValue); return new Promise<void>(() => {});
        } }); return reader;
      } }); return response;
    });
    const pending = refusal(providerJsonOnce(options({ send, timeoutMs: 5 })), kind === 'pending' ? 'timeout' : 'response-body', 200);
    await ready;
    await vi.advanceTimersByTimeAsync(6); await pending;
    expect(cancelled).toBe(1); expect(send).toHaveBeenCalledTimes(1);
  });
});
