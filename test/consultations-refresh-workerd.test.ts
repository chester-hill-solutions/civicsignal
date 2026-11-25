import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { Miniflare, Response as LocalResponse } from 'miniflare';
import { expect, it, vi } from 'vitest';

// The optional local intake receipt exercises the same test with a full acquired catalogue.
const comparison = process.env.CIVICSIGNAL_CONSULTATIONS_REFRESH_REFERENCE;
const sources = {
  csv: 'https://open.canada.ca/static/consultations_open.csv',
  schema: 'https://open.canada.ca/data/recombinant-published-schema/consultations.json',
};

it.skipIf(process.env.CIVICSIGNAL_WORKERD_TESTS !== '1')('runs a native consultations schedule and replays it against isolated storage', async () => {
  const reference = comparison ? JSON.parse(await readFile(comparison, 'utf8')) : undefined;
  const directory = await mkdtemp(join(tmpdir(), 'civicsignal-consultations-'));
  const csv = await readFile(reference ? `data/corpus/consultations/sources/${reference.csv.sha256}.csv` : 'test/fixtures/consultations/catalogue.csv');
  const schema = await readFile(reference ? `data/corpus/consultations/sources/${reference.schema.sha256}.json` : 'test/fixtures/consultations/schema.json');
  const rows = reference?.counts.rows ?? 9;
  const bundle = await build({ entryPoints: ['services/consultations/worker.ts'], bundle: true, format: 'esm',
    platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false });
  const name = 'consultations-local', outbound: string[] = [];
  const mf = new Miniflare({ unsafeTriggerHandlers: true, telemetry: { enabled: false },
    unsafeDevRegistryPath: join(directory, 'registry'), resourcePersistencePath: join(directory, 'state'),
    workers: [{ config: { name, compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
      env: { DB: { type: 'd1', id: name, dev: { remote: false } }, ARCHIVE: { type: 'r2', name, dev: { remote: false } },
        REFRESH: { type: 'workflow', name, worker: name, exportName: 'ConsultationsRefresh' },
        LOOKUP: { type: 'worker', worker: name, exportName: 'ConsultationLookup' } },
      exports: { ConsultationsRefresh: { type: 'workflow', name } },
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: bundle.outputFiles[0].text } } },
    }, dev: { outboundService: { type: 'fetcher', handler: async request => {
      outbound.push(request.url);
      if (request.url === sources.csv) return new LocalResponse(new Uint8Array(csv));
      if (request.url === sources.schema) return new LocalResponse(new Uint8Array(schema));
      throw new Error('Unexpected consultations publisher URL.');
    } } } }] });
  try {
    const db = await mf.getD1Database('DB', name);
    const ddl = await readFile('services/consultations/migrations/0001_consultations.sql', 'utf8');
    await db.batch(ddl.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    const bucket = await mf.getR2Bucket('ARCHIVE', name);
    const { REFRESH } = await mf.getBindings<{ REFRESH: Workflow }>(name);
    const address = await mf.ready;
    async function trigger(time: number) {
      const response = await fetch(new URL(`/cdn-cgi/local/scheduled?cron=15+11+*+*+*&time=${time}&format=json`, address));
      expect(await response.json()).toMatchObject({ outcome: 'ok' });
      const id = `consultations-${time}`, instance = await REFRESH.get(id);
      await vi.waitFor(async () => {
        const status = await instance.status();
        expect(status.status, JSON.stringify(status.error)).toBe('complete');
      }, { timeout: 90000, interval: 250 });
      const receipt = await bucket.get(`consultations/runs/${id}.json`);
      if (!receipt) throw new Error(`Missing refresh receipt for ${id}.`);
      return JSON.parse(await receipt.text());
    }
    const time = Date.parse(reference?.observedAt ?? '2026-11-25T11:15:00Z');
    const first = await trigger(time);
    expect(first.published.rows).toBe(rows);
    expect(first.lookup.id).toBe(first.published.sampleId);
    if (reference) expect(first.published.revision).toBe(reference.revision);
    expect(await trigger(time)).toEqual(first);
    const replay = await trigger(time + 86400000);
    expect(replay.published).toMatchObject({ rows, revision: first.published.revision, replayed: true });
    expect(await db.prepare('SELECT COUNT(*) FROM consultations_revisions').first('COUNT(*)')).toBe(rows);
    expect(outbound).toEqual([sources.csv, sources.schema, sources.csv, sources.schema]);
    expect((await bucket.list({ prefix: 'consultations/sources/' })).objects).toHaveLength(2);
    if (reference) console.info('Full consultations refresh', { rows, revision: first.published.revision,
      initialRowsWritten: first.published.rowsWritten, replayRowsWritten: replay.published.rowsWritten });
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 200000);
