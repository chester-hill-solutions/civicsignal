import { describe, expect, it } from 'vitest';
import { corsHeaders, readJsonBody, RequestInputError } from '../src/http';
import { BYOK_KEY_HEADER, BYOK_PROVIDER_HEADER } from '../src/routes/chat';
import type { Env } from '../src/types';

describe('browser BYOK requests', () => {
  it('permits both generation headers in a preflight', () => {
    const headers = corsHeaders({ ALLOWED_ORIGINS: 'https://app.example' } as Env, 'https://app.example', 'request-1');
    const allowed = headers['Access-Control-Allow-Headers'].toLowerCase().split(',').map((header) => header.trim());
    expect(allowed).toContain(BYOK_KEY_HEADER);
    expect(allowed).toContain(BYOK_PROVIDER_HEADER);
    expect(headers['Access-Control-Allow-Origin']).toBe('https://app.example');
  });
});

describe('bounded JSON input', () => {
  function request(body: string, headers?: HeadersInit) {
    return new Request('https://api.example/api/chat', { method: 'POST', body, headers });
  }

  it('reads valid JSON within the limit', async () => {
    await expect(readJsonBody(request('{"ok":true}'), 64)).resolves.toEqual({ ok: true });
  });

  it('rejects malformed JSON with a caller error', async () => {
    await expect(readJsonBody(request('{'), 64)).rejects.toMatchObject({ name: 'RequestInputError', status: 400 });
  });

  it('rejects an advertised oversized body before reading it', async () => {
    await expect(readJsonBody(request('{}', { 'Content-Length': '65' }), 64)).rejects.toMatchObject({ status: 413 });
  });

  it('enforces bytes even without Content-Length or with a false length', async () => {
    await expect(readJsonBody(request(JSON.stringify('é'.repeat(40))), 64)).rejects.toBeInstanceOf(RequestInputError);
    await expect(readJsonBody(request(JSON.stringify('a'.repeat(70)), { 'Content-Length': '2' }), 64)).rejects.toMatchObject({ status: 413 });
  });
});
