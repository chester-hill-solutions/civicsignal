import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareWorkspaceKey } from '../src/key-operations';
import { FundingSearchResponse, FundingVersionsResponse } from '../src/corpora/funding';
import type { Capabilities } from '../src/routes/capabilities';
import { normalizeForSearch } from '../src/text';

it.skipIf(process.env.CIVICSIGNAL_WORKERD_TESTS !== '1')('searches normalized funding sections and pins history to the local D1 cutoff', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'civic-funding-workerd-'));
  const name = 'funding-preview';
  const bundle = await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'browser',
    target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false });
  const mf = new Miniflare({ telemetry: { enabled: false }, unsafeDevRegistryPath: join(directory, 'registry'),
    resourcePersistencePath: join(directory, 'state'), workers: [{ config: {
      name, compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
      env: { CIVIC_DB: { type: 'd1', id: 'local-funding-test', dev: { remote: false } },
        COMMITTEE_DB: { type: 'd1', id: 'local-committee-test', dev: { remote: false } },
        COMMITTEE_CORPUS_PREVIEW: { type: 'text', value: 'on' },
        API_KEY_USAGE: { type: 'durable-object', worker: name, exportName: 'ApiKeyUsageDO' },
        FUNDING_PREVIEW: { type: 'text', value: 'on' } },
      exports: { ApiKeyUsageDO: { type: 'durable-object', storage: 'sqlite' } },
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: bundle.outputFiles[0].text } } },
    } }] });
  try {
    const db = await mf.getD1Database('CIVIC_DB', name);
    for (const file of ['migrations/0005_workspace_auth.sql', 'preview/funding/migrations/0001_funding.sql']) {
      const statements = (await readFile(file, 'utf8')).replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
      await db.batch(statements.map(sql => db.prepare(sql)));
    }
    const key = prepareWorkspaceKey('funding-preview', 'Workerd funding fixture');
    const observedAt = '2026-11-23T18:00:00.000Z';
    const indexes = JSON.stringify({ en: 'https://nserc.canada.ca/en/cci', fr: 'https://nserc.canada.ca/fr/cci' });
    const gaps = JSON.stringify([]);
    const section = { field: 'eligibility', heading: 'Admissibilité', text: `${'Le programme est évalué. '.repeat(40)}L’équipement scientifique est admissible.`,
      url: 'https://nserc.canada.ca/fr/equipment#eligibility' };
    const edition = { id: 'nserc-equipment', language: 'fr', title: 'Équipement de recherche',
      url: 'https://nserc.canada.ca/fr/equipment', status: 'open', statusText: null, availability: 'published',
      sections: [section] };
    const futureEdition = { ...edition, title: 'Future equipment edition' };
    await db.batch([
      db.prepare("INSERT INTO workspace (id) VALUES ('funding-preview')"),
      db.prepare("INSERT INTO civic_workspace_billing (workspace_id,plan,fuse_limit) VALUES ('funding-preview','free',3)"),
      db.prepare(key.sql),
      db.prepare('INSERT INTO funding_catalogues VALUES (?,?,?,?,?)').bind('nserc', observedAt, 'catalogue-r1', indexes, gaps),
      db.prepare(`INSERT INTO funding_editions (source,id,language,revision,title,url,status,status_text,availability,sections_json,search_text)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind('nserc', edition.id, edition.language, 'edition-r1', edition.title, edition.url,
        edition.status, edition.statusText, edition.availability, JSON.stringify(edition.sections),
        normalizeForSearch([edition.title, edition.id, ...edition.sections.map(s => s.heading + ' ' + s.text)].join('\n'))),
      db.prepare(`INSERT INTO funding_sections
        (source,id,language,section_index,field,heading,text,url,normalized_heading,normalized_text) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind('nserc', edition.id, edition.language, 0, section.field, section.heading, section.text, section.url,
          normalizeForSearch(section.heading), normalizeForSearch(section.text)),
      db.prepare('INSERT INTO funding_versions VALUES (?,?,?,?,?,?,?)').bind('nserc', edition.id, 'fr', observedAt,
        'edition-r1', 'added', JSON.stringify(edition)),
      db.prepare('INSERT INTO funding_versions VALUES (?,?,?,?,?,?,?)').bind('nserc', edition.id, 'fr', '2026-11-23T19:00:00.000Z',
        'edition-r2', 'changed', JSON.stringify(futureEdition)),
    ]);

    const committees = await mf.getD1Database('COMMITTEE_DB', name);
    const committeeSchema = await readFile('preview/committees/migrations/0001_committee_preview.sql', 'utf8');
    await committees.batch(committeeSchema.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)
      .map(sql => committees.prepare(sql)));
    await committees.batch([
      committees.prepare("INSERT INTO cc_snapshot VALUES ('45-1',?)").bind(observedAt),
      committees.prepare("INSERT INTO cc_records(session,id,language,kind,metadata_json) VALUES ('45-1','brief','fr','brief','{}')"),
      committees.prepare("INSERT INTO cc_passages(session,language,document_id,position,text) VALUES ('45-1','fr','brief',1,'formation')"),
      committees.prepare("INSERT INTO cc_fts(cc_fts) VALUES('rebuild')"),
    ]);
    const discovery = await mf.dispatchFetch('https://local.invalid/.well-known/civicsignal.json');
    const caps = await discovery.json() as Capabilities;
    expect(caps.sources.find(source => source.id === 'committees')).toMatchObject({
      status: 'available', editions: [{ language: 'fr', scope: '45-1', coverageThrough: observedAt }],
    });
    expect(caps.sources.find(source => source.id === 'nserc')).toMatchObject({
      status: 'available', editions: [{ language: 'fr', observedAt, revision: 'catalogue-r1' }],
    });
    expect(caps.researchQuestions.find(question => question.language === 'fr')).toMatchObject({
      status: 'partial', missingSources: ['esdc'],
    });

    const searchUrl = 'https://local.invalid/api/funding-programs?source=nserc&language=fr&query=equipement';
    expect((await mf.dispatchFetch(searchUrl)).status).toBe(401);
    const headers = { Authorization: `Bearer ${key.rawKey}` };
    const search = await mf.dispatchFetch(searchUrl, { headers });
    expect(search.status).toBe(200);
    expect(FundingSearchResponse.parse(await search.json())).toMatchObject({ revision: 'catalogue-r1', items: [{
      id: edition.id, language: 'fr', revision: 'edition-r1', match: { section: 'eligibility', heading: 'Admissibilité',
        snippet: expect.stringContaining('L’équipement'), url: section.url },
    }] });
    const history = await mf.dispatchFetch(`https://local.invalid/api/funding-programs/${edition.id}/versions?language=fr`, { headers });
    expect(history.status).toBe(200);
    expect(FundingVersionsResponse.parse(await history.json())).toMatchObject({ revision: 'catalogue-r1',
      items: [{ revision: 'edition-r1', event: 'added' }] });
    const coverage = await mf.dispatchFetch('https://local.invalid/api/funding-programs/coverage?source=nserc', { headers });
    expect(coverage.status).toBe(200);
    expect(await coverage.json()).toMatchObject({ observedAt, revision: 'catalogue-r1' });
    expect((await mf.dispatchFetch(searchUrl, { headers })).status).toBe(429);
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
