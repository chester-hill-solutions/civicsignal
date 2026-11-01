#!/usr/bin/env bun
/** Exercise conditional create against a real local R2 binding in workerd.
 * No remote bindings or Cloudflare credentials are used. Requires localhost.
 */
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

const mf = new Miniflare({ telemetry: { enabled: false }, unsafeDevRegistryPath: resolve('dist/miniflare-snapshot-registry'),
  workers: [{ config: { name: 'snapshot-r2-immutability', compatibilityDate: '2026-10-22',
    env: { TEST: { type: 'r2', name: 'local-snapshot-immutability', dev: { remote: false } } },
    manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: `
export default { async fetch(request, env) {
  const key = crypto.randomUUID();
  const first = await env.TEST.put(key, 'first', { onlyIf: { etagDoesNotMatch: '*' } });
  const second = await env.TEST.put(key, 'second', { onlyIf: { etagDoesNotMatch: '*' } });
  const object = await env.TEST.get(key);
  const body = await object.text();
  const third = await env.TEST.put(key, 'third', { onlyIf: new Headers({ 'If-None-Match': '*' }) });
  const afterHeader = await (await env.TEST.get(key)).text();
  await env.TEST.delete(key);
  return Response.json({ firstCreated: !!first, duplicateWasNull: second === null, originalPreserved: body === 'first',
    headerDuplicateWasNull: third === null, originalPreservedAfterHeader: afterHeader === 'first' });
}};` } } },
  } }] });
try {
  const response = await mf.dispatchFetch('https://local-r2-immutability.invalid');
  const evidence = await response.json() as Record<string, boolean>;
  if (response.status !== 200 || Object.values(evidence).some((value) => value !== true)) throw new Error(`R2 immutable creation failed: ${JSON.stringify(evidence)}`);
  console.log(JSON.stringify({ runtime: 'local workerd R2 binding', ...evidence }));
} finally { await mf.dispose(); }
