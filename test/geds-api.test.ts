import { describe, expect, it } from 'vitest';
import { prepareGeds } from '../src/routes/geds';
import { buildGedsOpenApi } from '../src/geds/openapi';
import { AccessError } from '../src/access';
import { RequestInputError } from '../src/http';
import type { Env } from '../src/types';
import { gedsDatabase, refreshFixture } from './helpers/geds';

async function testEnv() {
  const { db, archive } = gedsDatabase();
  await refreshFixture(db, archive, 'snapshot-a.csv', '2026-01-01T00:00:00Z');
  await refreshFixture(db, archive, 'snapshot-b.csv', '2026-02-01T00:00:00Z');
  const env = {
    CIVIC_DB: db,
    GEDS_PREVIEW: 'on',
    PRODUCT_NAME: 'CivicSignal',
  } as unknown as Env;
  return { env, db };
}

async function call(env: Env, path: string) {
  const url = new URL(`https://api.example.test${path}`);
  const prepare = prepareGeds(url);
  if (!prepare) throw new Error(`not a GEDS route: ${path}`);
  try {
    const json = await prepare(env)();
    return { response: { status: 200 }, json: json as any };
  } catch (error: unknown) {
    const status = error instanceof AccessError || error instanceof RequestInputError ? error.status : 500;
    const code = error instanceof AccessError ? error.code : error instanceof RequestInputError ? 'INVALID_ARGUMENT' : 'INTERNAL';
    return { response: { status }, json: { code } as any };
  }
}

describe('GEDS prepared HTTP handlers', () => {
  it('publishes English and French OpenAPI examples for the same unit lookup', () => {
    const document = buildGedsOpenApi('https://directory.example.test', 'Directory API');
    const examples = JSON.stringify(document.paths['/api/organizations']);
    expect(document.servers[0]?.url).toBe('https://directory.example.test');
    expect(examples).toContain('Corporate Management Branch');
    expect(examples).toContain('Direction générale de la gestion intégrée');
    expect(examples).toContain('org_example');
  });

  it('requires the preview flag and directory database binding', async () => {
    const { env } = await testEnv();
    env.GEDS_PREVIEW = 'off';
    const disabled = await call(env, '/api/organizations?q=Corporate');
    expect(disabled.response.status).toBe(501);
    expect(disabled.json.code).toBe('UNSUPPORTED_COVERAGE');
    env.GEDS_PREVIEW = 'on';
    const noDatabase = await call({ ...env, CIVIC_DB: undefined } as unknown as Env, '/api/organizations?q=Corporate');
    expect(noDatabase.response.status).toBe(503);
    expect(noDatabase.json.code).toBe('RETRIEVAL_UNAVAILABLE');
  });

  it('rejects ambiguous filters, invalid path encoding and rolled-over calendar dates', async () => {
    const { env } = await testEnv();
    for (const path of ['/api/people?asOf=2026-02-30', '/api/organizations?lang=en&lang=fr',
      '/api/people?exact=yes', '/api/people?unrecognized=1', '/api/people/%FF']) {
      expect((await call(env, path)).json.code).toBe('INVALID_ARGUMENT');
    }
  });

  it('resolves a real unit from English and French names to one id', async () => {
    const { env } = await testEnv();
    const en = await call(env, '/api/organizations?q=Corporate%20Management%20Branch&lang=en');
    const fr = await call(env, '/api/organizations?q=Direction%20g%C3%A9n%C3%A9rale%20de%20la%20gestion%20int%C3%A9gr%C3%A9e&lang=fr');
    expect(en.response.status).toBe(200);
    expect(fr.response.status).toBe(200);
    expect(en.json.items[0].id).toBe(fr.json.items[0].id);
    expect(en.json.language).toBe('en');
    expect(fr.json.language).toBe('fr');
    expect(fr.json.items[0].name).toBe('Direction générale de la gestion intégrée');
    expect(en.json.snapshot.id).toBeTruthy();
  });

  it('traverses a unit to a person and returns the published contact with a citation', async () => {
    const { env } = await testEnv();
    const orgs = await call(env, '/api/organizations?q=Programs%20Branch');
    const orgId = orgs.json.items[0].id;
    const people = await call(env, `/api/organizations/${orgId}/people`);
    expect(people.response.status).toBe(200);
    const jordan = people.json.items.find((p: any) => p.name === 'Jordan Lee');
    expect(jordan).toBeTruthy();
    expect(jordan.title.en).toBe('Manager, Programs');
    expect(jordan.contact.value).toBe('613-555-0201');

    const contact = await call(env, `/api/people/${jordan.id}/contact?organizationId=${orgId}`);
    expect(contact.response.status).toBe(200);
    expect(contact.json.contact.citation.datasetId).toBe('8ec4a9df-b76b-4a67-8f93-cdbc2e040098');
    expect(contact.json.contact.citation.resourceUrl).toContain('gedsOpenData.zip');
    expect(contact.json.contact.citation.text).toContain('Jordan Lee');
    expect(contact.json.snapshot.id).toBeTruthy();
  });

  it('serves a historical asOf with the earlier role and rejects an impossible date', async () => {
    const { env } = await testEnv();
    const people = await call(env, '/api/people?q=Jordan%20Lee&asOf=2026-01-15');
    const jordan = people.json.items.find((p: any) => p.name === 'Jordan Lee');
    const old = await call(env, `/api/people/${jordan.id}?asOf=2026-01-15`);
    expect(old.response.status).toBe(200);
    expect(old.json.roles[0].title.en).toBe('Senior Analyst');
    expect(old.json.roles[0].organization.name).toBe('Corporate Management Branch');

    const before = await call(env, '/api/people?q=Jordan&asOf=2025-01-01');
    expect(before.response.status).toBe(404);
    expect(before.json.code).toBe('NO_SNAPSHOT_AS_OF');
  });

  it('returns a general office contact instead of an empty unit with no explanation', async () => {
    const { env } = await testEnv();
    const orgs = await call(env, '/api/organizations?q=General%20Office');
    const people = await call(env, `/api/organizations/${orgs.json.items[0].id}/people`);
    expect(people.json.items).toHaveLength(0);
    expect(people.json.officeContact.contact.isGeneralOffice).toBe(true);
    expect(people.json.officeContact.contact.label).toContain('General office');
    expect(people.json.officeContact.contact.citation.text).toContain('613-555-0100');
  });

  it('rejects invalid pagination and language without billing a success', async () => {
    const { env } = await testEnv();
    const badLimit = await call(env, '/api/organizations?q=Corporate&limit=0');
    expect(badLimit.response.status).toBe(400);
    expect(badLimit.json.code).toBe('INVALID_ARGUMENT');
    const badLang = await call(env, '/api/organizations?q=Corporate&lang=de');
    expect(badLang.response.status).toBe(400);
    expect(badLang.json.code).toBe('INVALID_ARGUMENT');
  });

  it('returns 404 for an id that is not published at the snapshot', async () => {
    const { env } = await testEnv();
    const missing = await call(env, '/api/organizations/org_not_there');
    expect(missing.response.status).toBe(404);
    expect(missing.json.code).toBe('NOT_FOUND');
  });
});
