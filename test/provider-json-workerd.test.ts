import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Response as LocalResponse } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Fake outbound service handles every request; no real provider, key or network. */
describe.skipIf(process.env['CIVICSIGNAL_WORKERD_TESTS'] !== '1')('provider JSON with native workerd fetch', () => {
  let mf: Miniflare | undefined, directory: string;
  const outbound: { url: string; method: string; authorization: string | null }[] = [];
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'civicsignal-provider-json-workerd-'));
    const result = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'provider-json-native-fixture.ts', contents: `
      import {providerJsonOnce} from './src/provider-json';
      export default {async fetch(request) {
        const mode=new URL(request.url).pathname.slice(1);
        try {
          const value=await providerJsonOnce({url:'https://provider.invalid/'+mode,
            headers:{authorization:'Bearer synthetic-provider-key'},body:{input:'synthetic'},
            timeoutMs:2000,responseBytes:1024,parse:value=>value});
          return Response.json({passed:true,value});
        } catch(error) {return Response.json({passed:false,phase:error?.phase,httpStatus:error?.httpStatus});}
      }};
    ` }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
    mf = new Miniflare({ telemetry: { enabled: false }, unsafeDevRegistryPath: join(directory, 'registry'),
      resourcePersistencePath: join(directory, 'persistence'), workers: [{
        config: { name: 'provider-json-native-local', compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'], env: {},
          manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: result.outputFiles[0]!.text } } } },
        dev: { outboundService: { type: 'fetcher', handler: async request => {
          outbound.push({ url: request.url, method: request.method, authorization: request.headers.get('authorization') });
          const url = new URL(request.url);
          if (url.origin !== 'https://provider.invalid') throw Error('External networking forbidden.');
          if (url.pathname === '/ok') return LocalResponse.json({ accepted: true });
          const matched = /^\/redirect-(302|307)-(same|cross)$/.exec(url.pathname);
          if (!matched) throw Error('Unexpected outbound call; no external networking.');
          const location = matched[2] === 'same' ? 'https://provider.invalid/credential-trap' : 'https://other-provider.invalid/credential-trap';
          return new LocalResponse('synthetic redirect body', { status: Number(matched[1]), headers: { location } });
        } } },
      }] });
  }, 30000);
  afterAll(async () => { try { await mf?.dispose(); } finally { if (directory) await rm(directory, { recursive: true, force: true }); } });

  it('dispatches a valid POST through unmocked native default fetch', async () => {
    const before = outbound.length, response = await mf!.dispatchFetch('https://local.invalid/ok');
    expect(await response.json()).toEqual({ passed: true, value: { accepted: true } });
    expect(outbound.slice(before)).toEqual([{ url: 'https://provider.invalid/ok', method: 'POST', authorization: 'Bearer synthetic-provider-key' }]);
  });

  it.each([[302, 'same'], [302, 'cross'], [307, 'same'], [307, 'cross']] as const)(
    'rejects HTTP%s %s-origin redirect without a follow-up or credential forwarding', async (status, origin) => {
      const before = outbound.length, path = '/redirect-' + status + '-' + origin;
      const response = await mf!.dispatchFetch('https://local.invalid' + path);
      expect(await response.json()).toEqual({ passed: false, phase: 'upstream-http', httpStatus: status });
      expect(outbound.slice(before)).toEqual([{ url: 'https://provider.invalid' + path, method: 'POST', authorization: 'Bearer synthetic-provider-key' }]);
    },
  );
});
