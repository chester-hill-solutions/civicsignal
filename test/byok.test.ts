import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatByok, isByokProvider } from '../src/byok';

afterEach(() => vi.unstubAllGlobals());

describe('BYOK upstream requests', () => {
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
      .rejects.toThrow('The Google endpoint returned 401.');
  });

  it('accepts only actual provider names', () => {
    expect(isByokProvider('google')).toBe(true);
    expect(isByokProvider('constructor')).toBe(false);
    expect(isByokProvider('__proto__')).toBe(false);
  });
});
