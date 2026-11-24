import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, type MiniflareOptions } from 'miniflare';
import { SourceFeedResponseSchema } from '../src/routes/source-feed-contract';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workerName = 'source-feed-d1-parity';
const source = 'gazette';
const language = 'en';
const part = 'I';
const editionId = 'gazette:pi:en:2026-04-25:v160:n17';
const publicationDate = '2026-04-25';
const observedAt = '2026-11-23T15:00:00.000Z';
const citationUrl = 'https://gazette.gc.ca/rp-pr/p1/2026/2026-04-25/html/example-eng.html';

let active: Miniflare | undefined;
let directory: string | undefined;
afterEach(async () => {
  await active?.dispose();
  active = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe.skipIf(process.env['CIVICSIGNAL_WORKERD_TESTS'] !== '1')('source feed in actual Workerd D1', () => {
  it('pages through additions, corrections and tombstones, then returns a quiescent cursor', async () => {
    directory = await mkdtemp(join(tmpdir(), 'civicsignal-source-feed-workerd-'));
    const migration = await readFile(new URL('../preview/source-feed/migrations/0001_source_feed.sql', import.meta.url), 'utf8');
    const bundle = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'source-feed-workerd-fixture.ts', contents: `
      import { matchSourceFeed, parseSourceFeedRequest, readSourceFeed } from './src/routes/source-feed';
      export default { async fetch(request, env) {
        const url = new URL(request.url), source = matchSourceFeed(url.pathname);
        if (!source) return Response.json({ error: 'not found' }, { status: 404 });
        const query = parseSourceFeedRequest(source, url);
        return Response.json(await readSourceFeed(env.CIVIC_DB, { source, query }));
      }};
    ` }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*'], write: false });
    const workerCode = bundle.outputFiles[0]?.text;
    if (!workerCode) throw new Error('The source-feed Workerd fixture did not produce a bundle.');
    const options: MiniflareOptions = { telemetry: { enabled: false }, unsafeDevRegistryPath: join(directory, 'registry'),
      resourcePersistencePath: join(directory, 'persistence'), workers: [{ config: {
        name: workerName, compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
        env: { CIVIC_DB: { type: 'd1', id: 'source-feed-local-d1', dev: { remote: false } } },
        manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: workerCode } } },
      } }] };
    active = new Miniflare(options);
    const db = await active.getD1Database('CIVIC_DB', workerName);
    for (const statement of migration.split(';').map((item) => item.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare('INSERT INTO source_feed_editions (source, language, edition_id, part, publication_date, observed_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(source, language, editionId, part, publicationDate, observedAt).run();
    const rows = [
      { kind: 'added', recordId: 'gazette:pi:en:2026-04-25:v160:n17:export-permit', label: 'Export permit', beforeSearch: null, afterSearch: 'export permit' },
      { kind: 'added', recordId: 'gazette:pi:en:2026-04-25:v160:n17:other-notice', label: 'Other notice', beforeSearch: null, afterSearch: 'other notice' },
      { kind: 'corrected', recordId: 'gazette:pi:en:2026-04-25:v160:n17:export-permit', label: 'Replacement permit', beforeSearch: 'export permit', afterSearch: 'replacement permit' },
      { kind: 'removed', recordId: 'gazette:pi:en:2026-04-25:v160:n17:export-permit', label: 'Replacement permit', beforeSearch: 'replacement permit', afterSearch: null },
    ] as const;
    const insert = db.prepare(`INSERT INTO source_feed_events
      (source, language, edition_id, part, kind, record_id, publication_date, observed_at, citation_url, label, before_search, after_search)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of rows) {
      await insert.bind(source, language, editionId, part, row.kind, row.recordId, publicationDate, observedAt,
        citationUrl, row.label, row.beforeSearch, row.afterSearch).run();
    }

    const request = async (query: string) => {
      const mf = active;
      if (!mf) throw new Error('The source-feed Workerd fixture is not running.');
      const response = await mf.dispatchFetch(`https://local.invalid/api/gazette/changes?language=en&part=I&${query}`);
      expect(response.status).toBe(200);
      return SourceFeedResponseSchema.parse(await response.json());
    };

    const first = await request('topic=export&limit=1');
    expect(first.events).toMatchObject([{ kind: 'added', label: 'Export permit', matches: { before: false, after: true } }]);
    expect(first.hasMore).toBe(true);
    const continuation = await request(`topic=export&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`);
    expect(continuation.events).toMatchObject([{ kind: 'corrected', label: 'Replacement permit', matches: { before: true, after: false } }]);
    expect(continuation.scope).toMatchObject({ source, language });
    expect(continuation.hasMore).toBe(false);
    const quiescentFiltered = await request(`topic=export&limit=1&cursor=${encodeURIComponent(continuation.nextCursor)}`);
    expect(quiescentFiltered.events).toEqual([]);
    expect(quiescentFiltered.nextCursor).toBe(continuation.nextCursor);

    const allFirst = await request('limit=2');
    const allContinuation = await request(`limit=2&cursor=${encodeURIComponent(allFirst.nextCursor)}`);
    expect(allContinuation.events).toMatchObject([
      { kind: 'corrected', label: 'Replacement permit' },
      { kind: 'removed', label: 'Replacement permit' },
    ]);
    const quiescentAll = await request(`limit=2&cursor=${encodeURIComponent(allContinuation.nextCursor)}`);
    expect(quiescentAll.events).toEqual([]);
    expect(quiescentAll.nextCursor).toBe(allContinuation.nextCursor);
  }, 20_000);
});
