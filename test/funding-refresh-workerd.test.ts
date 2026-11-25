import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { Miniflare, Response as LocalResponse } from 'miniflare';
import { expect, it, vi } from 'vitest';
import { FundingInventory, type FundingSource } from '../src/corpora/funding';
import { materializeFunding } from '../scripts/materialize-funding';
import { testD1 } from './helpers/d1';
import { readNsercInventory } from '../services/funding/archive';

const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function inventoryFixture(source: FundingSource) {
  const path = source === 'esdc' ? process.env.CIVICSIGNAL_ESDC_REFRESH_REFERENCE : process.env.CIVICSIGNAL_NSERC_REFRESH_REFERENCE;
  const pages = new Map<string, Uint8Array>();
  if (path) {
    const packet = FundingInventory.parse(JSON.parse(await readFile(path, 'utf8')));
    for (const file of packet.sources ?? []) {
      pages.set(file.sha256, await readFile(join(dirname(path), 'sources', 'objects', file.sha256.slice(0, 2), file.sha256)));
    }
    return { packet, pages };
  }
  const urls = source === 'esdc' ? {
    en: 'https://www.canada.ca/en/employment-social-development/services/funding/programs.html',
    fr: 'https://www.canada.ca/fr/emploi-developpement-social/services/financement/programmes.html',
  } : { en: 'https://nserc-crsng.canada.ca/en/grants', fr: 'https://nserc-crsng.canada.ca/fr/subventions' };
  const records = (['en', 'fr'] as const).map(language => ({
    id: source + '-grant', language, url: urls[language], title: language === 'en' ? 'Research grant' : 'Subvention de recherche',
    status: 'ongoing', statusText: null, availability: 'published',
    sections: [{ field: 'eligibility', heading: 'Institutions', text: 'College', url: urls[language] }],
  }));
  const sources = records.map(row => {
    const body = new TextEncoder().encode(`<p>${row.title}</p>`), sha256 = digest(body);
    pages.set(sha256, body);
    return { url: row.url, resolvedUrl: row.url, bytes: body.length, sha256, etag: null, lastModified: null };
  });
  const packet = FundingInventory.parse({ indexes: urls, source, observedAt: '2026-11-25T12:00:00.000Z', sources, records, gaps: [] });
  return { packet, pages };
}

it('refuses a funding inventory when a retained publisher page has changed under its original key', async () => {
  const { packet, pages } = await inventoryFixture('nserc');
  const bytes = new TextEncoder().encode(JSON.stringify(packet)), sha256 = digest(bytes);
  const key = `funding/nserc/inventories/${sha256}.json`;
  const objects = new Map([[key, bytes]]);
  for (const [hash, page] of pages) objects.set(`funding/nserc/sources/${hash}.html`, Uint8Array.from(page));
  const first = packet.sources?.[0];
  if (!first || !packet.sources) throw new Error('Expected a source reference.');
  const reader = { async get(k: string) {
    const body = objects.get(k);
    return body ? { size: body.length, arrayBuffer: async () => Uint8Array.from(body).buffer } : null;
  } };
  const ref = { key, sha256, bytes: bytes.length, sources: packet.sources.length,
    sourceBytes: packet.sources.reduce((sum, page) => sum + page.bytes, 0) };
  const sourceKey = `funding/nserc/sources/${first.sha256}.html`;
  objects.set(sourceKey, new Uint8Array(first.bytes));
  await expect(readNsercInventory(reader, ref, packet.observedAt)).rejects.toThrow('checksum mismatch');
  objects.delete(sourceKey);
  await expect(readNsercInventory(reader, ref, packet.observedAt)).rejects.toThrow('Missing or truncated');
});

it.skipIf(process.env.CIVICSIGNAL_WORKERD_TESTS !== '1').each(['nserc', 'esdc'] as const)(
  'runs the scheduled %s funding publisher from archived originals and replays the same editions', async source => {
  const { packet, pages } = await inventoryFixture(source);
  const esdc = source === 'esdc';
  const entry = esdc ? 'services/funding/esdc/worker.ts' : 'services/funding/worker.ts';
  const workflow = esdc ? 'EsdcRefresh' : 'FundingRefresh';
  const lookup = esdc ? 'EsdcLookup' : 'FundingLookup';
  const local = testD1({ schema: '' });
  const expected = materializeFunding(local.sqlite, packet);
  local.close();
  const bundle = await build({ entryPoints: [entry], bundle: true, format: 'esm',
    platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false });
  const directory = await mkdtemp(join(tmpdir(), 'funding-workflow-')), name = 'funding-local';
  const mf = new Miniflare({ telemetry: { enabled: false }, unsafeTriggerHandlers: true,
    unsafeDevRegistryPath: join(directory, 'registry'), resourcePersistencePath: join(directory, 'state'),
    workers: [{ config: { name, compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
      env: { DB: { type: 'd1', id: name, dev: { remote: false } }, ARCHIVE: { type: 'r2', name, dev: { remote: false } },
        REFRESH: { type: 'workflow', name, worker: name, exportName: workflow },
        LOOKUP: { type: 'worker', worker: name, exportName: lookup },
        COLLECTOR: { type: 'fetcher', handler: async (req, runtime) => {
          expect(req.method).toBe('POST');
          expect(new URL(req.url).pathname).toBe('/collect');
          const { observedAt } = await req.json() as { observedAt: string };
          const body = JSON.stringify({ ...packet, observedAt }), sha256 = digest(body);
          const key = `funding/${source}/inventories/${sha256}.json`;
          const bucket = await runtime.getR2Bucket('ARCHIVE', name);
          await bucket.put(key, body);
          if (esdc) {
            // The reference importer records confirmed missing pages in its gap list.
            // Recreate the collector's per-observation status objects for this local replay.
            for (const gap of packet.gaps) {
              const terminal = /^confirmed-detail-http-(404|410)$/.exec(gap.reason);
              if (terminal) {
                const checkpoint = `funding/esdc/observations/${observedAt}/pages/${digest(gap.url)}.json`;
                await bucket.put(checkpoint, JSON.stringify({ url: gap.url, status: Number(terminal[1]) }));
              }
            }
          }
          return LocalResponse.json({ key, sha256, bytes: Buffer.byteLength(body), sources: packet.sources?.length,
            sourceBytes: packet.sources?.reduce((sum, file) => sum + file.bytes, 0) });
        } } },
      exports: { [workflow]: { type: 'workflow', name } },
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: bundle.outputFiles[0].text } } },
    } }] });
  try {
    const db = await mf.getD1Database('DB', name), bucket = await mf.getR2Bucket('ARCHIVE', name);
    for (const migration of (await readdir('preview/funding/migrations')).filter(f => f.endsWith('.sql')).sort()) {
      const ddl = await readFile(join('preview/funding/migrations', migration), 'utf8');
      await db.batch(ddl.replace(/^--.*$/gm, '').split(';').map(q => q.trim()).filter(Boolean).map(q => db.prepare(q)));
    }
    for (const [sha256, page] of pages) await bucket.put(`funding/${source}/sources/${sha256}.html`, page);
    const { REFRESH } = await mf.getBindings<{ REFRESH: Workflow }>(name);
    async function trigger(time: number) {
      const url = new URL('/cdn-cgi/local/scheduled', await mf.ready);
      url.search = new URLSearchParams({ cron: '30 11 * * *', time: String(time), format: 'json' }).toString();
      expect(await (await fetch(url)).json()).toMatchObject({ outcome: 'ok' });
      const id = `${source}-${time}`, instance = await REFRESH.get(id);
      await vi.waitFor(async () => {
        const status = await instance.status();
        expect(status.status, JSON.stringify(status.error)).toBe('complete');
      }, { timeout: 90000, interval: 100 });
      const receipt = await bucket.get(`funding/${source}/runs/${id}.json`);
      if (!receipt) throw new Error(`Missing ${source} receipt.`);
      return JSON.parse(await receipt.text());
    }
    const time = Date.parse(packet.observedAt);
    const first = await trigger(time);
    expect(first.published).toMatchObject({ revision: expected.revision, editions: expected.editions, events: expected.events });
    expect(first.lookup.map((item: { language: string }) => item.language)).toEqual(['en', 'fr']);
    expect(await trigger(time)).toEqual(first);
    const replay = await trigger(time + 86400000);
    expect(replay.published).toMatchObject({ revision: expected.revision, replayed: true, events: { added: 0, changed: 0, removed: 0 } });
    expect(await db.prepare('SELECT COUNT(*) FROM funding_versions').first('COUNT(*)')).toBe(expected.editions);
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 240000);
