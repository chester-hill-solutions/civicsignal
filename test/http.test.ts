import { describe, expect, it } from 'vitest';
import { corsHeaders, errorResponse, readJsonBody, RequestInputError } from '../src/http';
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

describe('safe generation failure envelope',()=>{
  it('serializes only provider, allowed phase and observed valid status',async()=>{
    const generation={provider:'google' as const,phase:'response-parse' as const,upstreamStatus:200,cause:'private-cause',name:'private-name',answer:'private-answer',model:'private-model',url:'https://private.test',key:'private-key'};
    const response=errorResponse('UPSTREAM_UNAVAILABLE','The request could not complete. Retry later.',{} as Env,null,'request-1',502,[],generation);
    const body=await response.json() as Record<string,unknown>;
    expect(body.generation).toEqual({provider:'google',phase:'response-parse',upstreamStatus:200});expect(response.status).toBe(502);
    expect(JSON.stringify(body)).not.toContain('private-');expect(body).toMatchObject({code:'UPSTREAM_UNAVAILABLE',correlationId:'request-1',retrieval:[]});
  });
  it.each([0,600,-1,401.5,'401'])('omits an invalid observed status%s',async upstreamStatus=>{
    const generation=JSON.parse(JSON.stringify({provider:'anthropic',phase:'transport',upstreamStatus}));
    const response=errorResponse('UPSTREAM_UNAVAILABLE','safe',{} as Env,null,'request-1',502,[],generation);
    expect((await response.json() as Record<string,unknown>).generation).toEqual({provider:'anthropic',phase:'transport'});
  });
  it.each([{provider:'constructor',phase:'transport'},{provider:'google',phase:'private-phase'}])('omits non-allowlisted generation metadata%j',async generation=>{
    const response=errorResponse('UPSTREAM_UNAVAILABLE','safe',{} as Env,null,'request-1',502,[],JSON.parse(JSON.stringify(generation)));
    expect(await response.json()).not.toHaveProperty('generation');
  });
});
