import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { expect, it } from 'vitest';
import { materializeFunding } from '../scripts/materialize-funding';
import { FundingInventory } from '../src/corpora/funding';
import { fundingSearchText } from '../src/corpora/funding-publication';
import { normalizeForSearch } from '../src/text';
import { testD1 } from './helpers/d1';

const reference = process.env.CIVICSIGNAL_ESDC_FUNDING_REFERENCE;
it.skipIf(!reference || process.env.CIVICSIGNAL_WORKERD_TESTS !== '1')(
  'publishes and replays an acquired ESDC inventory in native local D1 with exact serving and history parity',
  async () => {
    if (!reference) throw new Error('Expected an acquired ESDC reference.');
    const body = await readFile(reference, 'utf8');
    const packet = FundingInventory.parse(JSON.parse(body));
    expect(packet.source).toBe('esdc');
    const replayAt = new Date(Date.parse(packet.observedAt) + 86400000).toISOString();
    const local = testD1({ schema: '' });
    const expected = materializeFunding(local.sqlite, packet);
    const bundle = await build({ stdin: { contents: `
      import { publishFunding } from './services/funding/publish';
      export default { async fetch(request, env) {
        const object = await env.ARCHIVE.get('esdc-inventory');
        const input = await object.json();
        if (new URL(request.url).pathname === '/replay') input.observedAt = await request.text();
        return Response.json(await publishFunding(env.DB, 'esdc', input));
      } };`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'esm',
      platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false });
    const directory = await mkdtemp(join(tmpdir(), 'esdc-funding-d1-')), name = 'esdc-funding-local';
    const mf = new Miniflare({ telemetry: { enabled: false }, unsafeDevRegistryPath: join(directory, 'registry'),
      resourcePersistencePath: join(directory, 'state'), workers: [{ config: {
        name, compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
        env: { DB: { type: 'd1', id: name, dev: { remote: false } }, ARCHIVE: { type: 'r2', name, dev: { remote: false } } },
        manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: bundle.outputFiles[0].text } } },
      } }] });
    try {
      const db = await mf.getD1Database('DB', name);
      for (const file of (await readdir('preview/funding/migrations')).filter(file => file.endsWith('.sql')).sort()) {
        const ddl = await readFile(join('preview/funding/migrations', file), 'utf8');
        await db.batch(ddl.replace(/^--.*$/gm, '').split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
      }
      const archive = await mf.getR2Bucket('ARCHIVE', name);
      await archive.put('esdc-inventory', body);
      const firstResponse = await mf.dispatchFetch('https://local.invalid/publish', { method: 'POST' });
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json() as { rowsRead: number; rowsWritten: number };
      expect(first).toMatchObject({ ...expected, replayed: false });
      const replayResponse = await mf.dispatchFetch('https://local.invalid/replay', { method: 'POST', body: replayAt });
      expect(replayResponse.status).toBe(200);
      const replay = await replayResponse.json() as { rowsRead: number; rowsWritten: number };
      const same = materializeFunding(local.sqlite, { ...packet, observedAt: replayAt });
      expect(replay).toMatchObject({ ...same, replayed: true });
      expect(replay.rowsWritten).toBeLessThan(first.rowsWritten);
      const digests: Record<string, { rows: number; sha256: string }> = {};
      for (const [table, order] of [['funding_catalogues', 'source'], ['funding_editions', 'id,language'],
        ['funding_sections', 'id,language,section_index'], ['funding_versions', 'id,language,observed_at']]) {
        const query = `SELECT * FROM ${table} WHERE source='esdc' ORDER BY ${order} LIMIT ? OFFSET ?`;
        const page = table === 'funding_sections' ? 100 : 5;
        const digest = createHash('sha256');
        let rows = 0;
        for (;;) {
          const remote = await db.prepare(query).bind(page, rows).all();
          expect(remote.results).toEqual(local.sqlite.prepare(query).all(page, rows));
          for (const row of remote.results) digest.update(JSON.stringify(row)).update('\n');
          rows += remote.results.length;
          if (remote.results.length < page) break;
        }
        digests[table] = { rows, sha256: digest.digest('hex') };
      }
      const sizes = packet.records.map(row => {
        const indexedSections = row.sections.map(section => ({ ...section,
          normalizedHeading: normalizeForSearch(section.heading), normalizedText: normalizeForSearch(section.text) }));
        const values = [JSON.stringify(row), fundingSearchText(row), JSON.stringify(indexedSections)].map(value => Buffer.byteLength(value));
        return { edition: `${row.id}/${row.language}`, largestValueBytes: Math.max(...values),
          combinedPayloadBytes: values.reduce((total, bytes) => total + bytes, 0) };
      });
      const largestEdition = sizes.sort((a, b) => b.combinedPayloadBytes - a.combinedPayloadBytes)[0];
      console.info('ESDC native D1 publication', { inventoryBytes: Buffer.byteLength(body), editions: expected.editions,
        gaps: expected.gaps, revision: expected.revision, initialRowsRead: first.rowsRead, initialRowsWritten: first.rowsWritten,
        replayRowsRead: replay.rowsRead, replayRowsWritten: replay.rowsWritten, largestEdition,
        largestBoundValueBytes: Math.max(...sizes.map(row => row.largestValueBytes)), digests });
    } finally {
      await mf.dispose();
      local.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 120000,
);
