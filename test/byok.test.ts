import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatByok, isByokProvider, OPENCODE_ZEN_MODEL, OPENCODE_ZEN_LIMITS, PROVIDERS } from '../src/byok';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('BYOK upstream requests', () => {
  it.each(['anthropic','openai','google','opencode-zen'] as const)('preserves %s endpoint/auth/body/default model in one bounded POST',async provider=>{
    const key='fixture-generation-key',messages=[{role:'user',content:'A question'}],system='Use citations.';
    const answer='A cited answer.',reply=provider==='openai'?{choices:[{message:{content:answer}}]}:provider==='google'?{candidates:[{content:{parts:[{text:answer}]}}]}:{content:[{type:'text',text:answer}]};
    const send=vi.fn(async()=>Response.json(reply));vi.stubGlobal('fetch',send);
    const result=await chatByok({provider,apiKey:key,system,messages,maxTokens:128});
    const [url,init]=send.mock.calls[0] as unknown as [string,RequestInit];
    const models={anthropic:'claude-sonnet-4-5',openai:'gpt-4.1-mini',google:'gemini-2.5-flash','opencode-zen':'claude-haiku-4-5'};
    const endpoints={anthropic:'https://api.anthropic.com/v1/messages',openai:'https://api.openai.com/v1/chat/completions',google:'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent','opencode-zen':'https://opencode.ai/inference/anthropic/v1/messages'};
    expect(url).toBe(endpoints[provider]);expect(init.method).toBe('POST');expect(init.redirect).toBe('error');expect(send).toHaveBeenCalledTimes(1);
    const headers=new Headers(init.headers);
    expect(headers.get(provider==='anthropic'?'x-api-key':provider==='google'?'x-goog-api-key':'authorization')).toBe(provider==='openai'||provider==='opencode-zen'?'Bearer '+key:key);
    if(provider==='anthropic')expect(headers.get('anthropic-version')).toBe('2023-06-01');
    const body=JSON.parse(String(init.body));
    expect(body).toEqual(provider==='google'?{systemInstruction:{parts:[{text:system}]},generationConfig:{maxOutputTokens:128},contents:[{role:'user',parts:[{text:'A question'}]}]}:
      provider==='openai'?{model:models[provider],max_tokens:128,messages:[{role:'system',content:system},...messages]}:{model:models[provider],max_tokens:128,system,messages});
    expect(result).toEqual({answer,provider,model:models[provider],cited:0});expect(JSON.stringify(result)).not.toContain(key);
  });
  it('authenticates a Google request with the supplied key in the header', async () => {
    const send = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'A cited answer.' }] } }] })));
    vi.stubGlobal('fetch', send);
    const result = await chatByok({ provider: 'google', apiKey: 'caller-generation-key', system: 'Use citations.', messages: [{ role: 'user', content: 'A question' }], maxTokens: 300 });
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(new Headers(init.headers).get('x-goog-api-key')).toBe('caller-generation-key');
    expect(JSON.parse(String(init.body)).generationConfig.maxOutputTokens).toBe(300);
    expect(String(init.body)).not.toContain('caller-generation-key');
    expect(result.answer).toBe('A cited answer.');
    expect(JSON.stringify(result)).not.toContain('caller-generation-key');
  });

  it('does not leak a key echoed by an upstream failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('caller-generation-key', { status: 401 })));
    await expect(chatByok({ provider: 'google', apiKey: 'caller-generation-key', system: '', messages: [{ role: 'user', content: 'A question' }] }))
      .rejects.toMatchObject({ name: 'GenerationFailureError', provider: 'google', phase: 'upstream-http', upstreamStatus: 401 });
  });

  it('accepts only actual provider names', () => {
    expect(isByokProvider('google')).toBe(true);
    expect(isByokProvider('constructor')).toBe(false);
    expect(isByokProvider('__proto__')).toBe(false);
  });
});

describe('OpenCode Zen Messages adapter', () => {
  const input = { provider: 'opencode-zen' as const, apiKey: 'caller-generation-key', system: 'Use the retrieved citation.',
    messages: [{ role: 'user', content: 'Name the cited statute.' }], maxTokens: 128 };
  it('uses the fixed paid model, bearer header, shared serializer/parser and requested128 bound', async () => {
    const send = vi.fn(async () => Response.json({ content: [{ type: 'text', text: ' A cited answer. ' }] }));
    vi.stubGlobal('fetch', send);
    const result = await chatByok(input);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://opencode.ai/inference/anthropic/v1/messages');
    expect(init.method).toBe('POST'); expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer caller-generation-key');
    expect(new Headers(init.headers).has('x-api-key')).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({ model: OPENCODE_ZEN_MODEL, max_tokens: 128,
      system: input.system, messages: input.messages });
    expect(PROVIDERS['opencode-zen'].body).toBe(PROVIDERS.anthropic.body);
    expect(PROVIDERS['opencode-zen'].parse).toBe(PROVIDERS.anthropic.parse);
    expect(result).toEqual({ answer: 'A cited answer.', model: OPENCODE_ZEN_MODEL, provider: 'opencode-zen', cited: 0 });
    expect(JSON.stringify(result)).not.toContain(input.apiKey);expect(String(init.body)).not.toContain(input.apiKey);
  });
  it('rejects an unsupported API-family model without sending or falling back', async () => {
    const send = vi.fn();vi.stubGlobal('fetch', send);
    await expect(chatByok({ ...input, model: 'gpt-4.1-mini' })).rejects.toThrow('supports only');
    expect(send).not.toHaveBeenCalled();
  });
  it('keeps the product output-token schema separate from the128-token smoke', async () => {
    const send = vi.fn(async () => Response.json({ content: [{ type: 'text', text: 'A valid answer.' }] }));vi.stubGlobal('fetch', send);
    await chatByok({ ...input, maxTokens: 4096 });
    expect(JSON.parse(String((send.mock.calls[0] as unknown as [string, RequestInit])[1].body)).max_tokens).toBe(4096);
  });
  it.each([302, 401, 503])('refuses status%s once without returning an echoed key', async (status) => {
    const send = vi.fn(async () => new Response(input.apiKey, { status }));vi.stubGlobal('fetch', send);
    await expect(chatByok(input)).rejects.toMatchObject({ name: 'GenerationFailureError', provider: 'opencode-zen', phase: 'upstream-http', upstreamStatus: status });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(['invalid-json', 'transport'])('sanitizes%s failures that contain the key', async (kind) => {
    vi.stubGlobal('fetch', vi.fn(async () => { if (kind === 'transport') throw Error(input.apiKey);return new Response(input.apiKey); }));
    await expect(chatByok(input)).rejects.toMatchObject({ phase: kind === 'transport' ? 'transport' : 'response-parse' });
  });
  it('caps the response before parsing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(OPENCODE_ZEN_LIMITS.responseBytes + 1))));
    await expect(chatByok(input)).rejects.toMatchObject({ phase: 'response-body', upstreamStatus: 200 });
  });
  it('refuses a successful provider response that echoes the generation key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ content: [{ type: 'text', text: input.apiKey }] })));
    await expect(chatByok(input)).rejects.toMatchObject({ phase: 'response-validation', upstreamStatus: 200 });
  });
  it.each(['fetch', 'body', 'cleanup'])('bounds stalled%s without another send', async (kind) => {
    vi.useFakeTimers();let cancelled = 0;
    const send = vi.fn(async (_url: string, init: RequestInit) => {
      if (kind === 'fetch') return new Promise<Response>(() => {});
      return new Response(new ReadableStream<Uint8Array>({ start() {}, cancel() { cancelled++;if (kind === 'cleanup') return new Promise<void>(() => {}); } }), { status: kind === 'cleanup' ? 503 : 200 });
    });
    vi.stubGlobal('fetch', send);
    const request = expect(chatByok(input)).rejects.toMatchObject({ phase: kind === 'cleanup' ? 'upstream-http' : 'timeout',
      ...(kind === 'cleanup' ? { upstreamStatus: 503 } : kind === 'body' ? { upstreamStatus: 200 } : {}) });
    await vi.advanceTimersByTimeAsync(OPENCODE_ZEN_LIMITS.timeoutMs + 1);await request;
    expect(send).toHaveBeenCalledTimes(1);expect((send.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(true);
    if (kind !== 'fetch') expect(cancelled).toBe(1);
  });
  it('checks elapsed time during immediately fulfilled empty chunks', async () => {
    let clock = 0;vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const send = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull(c) { clock += 10_000;c.enqueue(new Uint8Array()); } }, { highWaterMark: 0 })));
    vi.stubGlobal('fetch', send);
    await expect(chatByok(input)).rejects.toMatchObject({ phase: 'timeout' });expect(send).toHaveBeenCalledTimes(1);
  });
  it('disposes an immediately fulfilled response received past the monotonic deadline', async () => {
    let clock = 0,cancelled = 0;vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const send = vi.fn(async () => { clock = OPENCODE_ZEN_LIMITS.timeoutMs + 1;return new Response(new ReadableStream({ cancel() { cancelled++; } })); });
    vi.stubGlobal('fetch', send);
    await expect(chatByok(input)).rejects.toMatchObject({ phase: 'timeout' });expect(cancelled).toBe(1);expect(send).toHaveBeenCalledTimes(1);
  });
  it('keeps the shared parser inside the same absolute deadline', async () => {
    let clock = 0;vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const parse = PROVIDERS['opencode-zen'].parse;
    vi.spyOn(PROVIDERS['opencode-zen'], 'parse').mockImplementation((body) => { const result = parse(body);clock = OPENCODE_ZEN_LIMITS.timeoutMs + 1;return result; });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ content: [{ type: 'text', text: 'A cited answer.' }] })));
    await expect(chatByok(input)).rejects.toMatchObject({ phase: 'timeout' });
  });
  it('disposes a late response after the sole timed-out fetch', async () => {
    vi.useFakeTimers();let resolve!: (value: Response) => void,cancelled = 0;
    const send = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));vi.stubGlobal('fetch', send);
    const request = expect(chatByok(input)).rejects.toMatchObject({ phase: 'timeout' });
    await vi.advanceTimersByTimeAsync(OPENCODE_ZEN_LIMITS.timeoutMs + 1);await request;
    resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
    await vi.advanceTimersByTimeAsync(1);expect(cancelled).toBe(1);expect(send).toHaveBeenCalledTimes(1);
  });
});
