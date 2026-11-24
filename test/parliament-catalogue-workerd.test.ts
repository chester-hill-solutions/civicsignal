import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareWorkspaceKey } from '../src/key-operations';
import { ParliamentLookup, PassagePage } from '../src/corpora/parliament-catalogue';

it.skipIf(process.env.CIVICSIGNAL_WORKERD_TESTS !== '1')('reads an authenticated cutoff and division atomically in Workerd D1', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'civic-parliament-workerd-'));
  const name = 'parliament-preview';
  const bundle = await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'browser',
    target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false });
  const mf = new Miniflare({ telemetry: { enabled: false }, unsafeDevRegistryPath: join(directory, 'registry'),
    resourcePersistencePath: join(directory, 'state'), workers: [{ config: {
      name, compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
      env: { CIVIC_DB: { type: 'd1', id: 'local-parliament-test', dev: { remote: false } },
        API_KEY_USAGE: { type: 'durable-object', worker: name, exportName: 'ApiKeyUsageDO' },
        PARLIAMENT_CATALOGUE_PREVIEW: { type: 'text', value: 'on' } },
      exports: { ApiKeyUsageDO: { type: 'durable-object', storage: 'sqlite' } },
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: bundle.outputFiles[0].text } } },
    } }] });
  try {
    const db = await mf.getD1Database('CIVIC_DB', name);
    for (const file of ['migrations/0005_workspace_auth.sql', 'preview/parliament/migrations/0001_catalogues.sql',
      'preview/parliament/migrations/0002_chamber_records.sql']) {
      const statements = (await readFile(file, 'utf8')).replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
      await db.batch(statements.map(sql => db.prepare(sql)));
    }
    const key = prepareWorkspaceKey('preview', 'local fixture');
    const details = { kind: 'house-vote', result: 'Adoptée', yeas: 11, nays: 4, paired: 0 };
    await db.batch([
      db.prepare("INSERT INTO workspace (id) VALUES ('preview')"),
      db.prepare("INSERT INTO civic_workspace_billing (workspace_id,plan,fuse_limit) VALUES ('preview','free',2)"),
      db.prepare(key.sql),
      db.prepare("INSERT INTO parliament_catalogues VALUES ('house-votes','45-1',?,?,1)").bind('2026-11-23T23:00:00.000Z', 'a'.repeat(64)),
      ...['en', 'fr'].map(language => db.prepare(`INSERT INTO parliament_editions
        (collection,session,key,language,title,summary,date,url,search_text,details_json)
        VALUES ('house-votes','45-1','1',?,'Motion','Decision','2026-11-23',?,'motion',?)`).bind(language,
        'https://www.ourcommons.ca/' + (language === 'fr' ? 'deputes/fr' : 'Members/en') + '/votes/45/1/1',
        JSON.stringify({ ...details, result: language === 'fr' ? 'Adoptée' : 'Agreed To' }))),
      db.prepare("INSERT INTO parliament_catalogues VALUES ('senate-journals','45-1',?,?,1)").bind('2026-11-23T23:00:00.000Z', 'b'.repeat(64)),
      db.prepare(`INSERT INTO parliament_editions VALUES ('senate-journals','45-1','1','fr','Journaux','','2026-11-23',
        'https://sencanada.ca/fr/','journaux',?)`).bind(JSON.stringify({ kind: 'senate-journal', status: 'published', passageCount: 1 })),
      db.prepare(`INSERT INTO parliament_editions VALUES ('senate-journals','45-1','1','en','Journals','','2026-11-23',
        'https://sencanada.ca/en/','journals',?)`).bind(JSON.stringify({ kind: 'senate-journal', status: 'unavailable', passageCount: 0 })),
      db.prepare(`INSERT INTO parliament_entries VALUES ('senate-journals','45-1','fr','1',1,?,'motion adoptee',NULL,NULL)`).bind(
        JSON.stringify({ text: 'Motion adoptée', url: 'https://sencanada.ca/fr/', links: [] })),
    ]);
    const url = 'https://local.invalid/api/parliament/house-votes/1?language=fr';
    expect((await mf.dispatchFetch(url)).status).toBe(401);
    const headers = { Authorization: 'Bearer ' + key.rawKey };
    const response = await mf.dispatchFetch(url, { headers });
    expect(response.status).toBe(200);
    expect(ParliamentLookup.parse(await response.json())).toMatchObject({ coverage: { recordsPerLanguage: 1 }, item: { details } });
    const journal = await mf.dispatchFetch('https://local.invalid/api/parliament/senate-journals/1/passages?language=fr&query=adoptee', { headers });
    expect(journal.status).toBe(200);
    expect(PassagePage.parse(await journal.json())).toMatchObject({
      coverage: { unavailableEditions: { en: 1, fr: 0 } }, items: [{ ordinal: 1, passage: { text: 'Motion adoptée' } }],
    });
    expect((await mf.dispatchFetch(url, { headers })).status).toBe(429);
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
