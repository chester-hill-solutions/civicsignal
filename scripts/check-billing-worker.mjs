import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const temporary = mkdtempSync(join(tmpdir(), 'civicsignal-worker-'));
const bundle = join(temporary, 'fixture.js');
const build = spawnSync('bun', ['build', 'test/fixtures/billing-worker.ts', '--target=browser', '--outfile', bundle], { encoding: 'utf8' });
if (build.status !== 0) throw new Error(`Worker fixture build failed: ${build.stderr}`);
const runtime = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: readFileSync(bundle, 'utf8'),
  compatibilityDate: '2026-10-01',
  durableObjects: { API_KEY_USAGE: 'ApiKeyUsageDO' },
}));
try {
  async function call(method, customer = 'fixture-a') {
    const response = await runtime.dispatchFetch(`https://fixture.test/?customer=${customer}`, { method });
    assert.equal(response.status, 200);
    return response.json();
  }
  assert.equal((await call('GET')).count, 0);
  assert.equal((await call('POST')).allowed, true);
  assert.equal((await call('GET')).count, 1);
  assert.equal((await call('GET')).count, 1);
  assert.equal((await call('POST')).allowed, false);
  assert.equal((await call('GET')).count, 1);
  assert.equal((await call('GET', 'fixture-b')).count, 0);
  assert.equal((await call('POST', 'fixture-b')).allowed, true);
  assert.equal((await call('GET')).month, '2026-11');
  console.log('billing Worker: read-only peek, hard fuse, customer isolation and period passed in workerd');
} finally { await runtime.dispose(); rmSync(temporary, { recursive: true, force: true }); }
