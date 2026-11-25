import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  ConsultationCoverageSchema, ConsultationLookupResponseSchema, ConsultationSearchResponseSchema,
  consultationFromRow, parseConsultationCsv, readConsultationDictionary,
} from '../src/corpora/consultations';
import { prepareConsultations } from '../src/routes/consultations';
import { consultationsOpenApi } from '../src/routes/consultations-openapi';
import { discoverSources } from '../src/routes/discovery-sources';
import type { Env } from '../src/types';
import { testD1 } from './helpers/d1';

const migrationPath = 'preview/consultations/migrations/0001_consultations.sql';
const fallbackSchema = `
CREATE TABLE consultations_catalogues (
  source TEXT PRIMARY KEY, observed_at TEXT NOT NULL, revision TEXT NOT NULL,
  csv_sha256 TEXT NOT NULL, schema_sha256 TEXT NOT NULL,
  csv_source_json TEXT NOT NULL, schema_source_json TEXT NOT NULL
);
CREATE TABLE consultations_records (
  id TEXT PRIMARY KEY, owner_org TEXT NOT NULL, registration_number TEXT NOT NULL,
  status_code TEXT NOT NULL, start_date TEXT, end_date TEXT, state_at_observation TEXT NOT NULL,
  report_available INTEGER, observed_at TEXT NOT NULL, first_observed_at TEXT NOT NULL,
  revision INTEGER NOT NULL, facts_json TEXT NOT NULL, search_en TEXT NOT NULL, search_fr TEXT NOT NULL,
  removed_at TEXT
);
CREATE TABLE consultations_revisions (
  id TEXT NOT NULL, observed_at TEXT NOT NULL, revision INTEGER NOT NULL, event TEXT NOT NULL,
  changed_fields_json TEXT NOT NULL, facts_json TEXT NOT NULL, PRIMARY KEY(id, observed_at)
);
`;
const migrationSchema = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : fallbackSchema;
const schema = migrationSchema.includes('removed_at') ? migrationSchema
  : `${migrationSchema}\nALTER TABLE consultations_records ADD COLUMN removed_at TEXT;\n`;
const noticeSchema = `CREATE TABLE notices (
  catalogue_revision TEXT NOT NULL, catalogue_observed_at TEXT NOT NULL, consultation_id TEXT NOT NULL,
  language TEXT NOT NULL, status TEXT NOT NULL, published_url TEXT, final_url TEXT, checked_at TEXT NOT NULL,
  http_status INTEGER, media_type TEXT, body_sha256 TEXT, body_bytes INTEGER, object_path TEXT,
  sections_json TEXT NOT NULL, detail TEXT, sources_json TEXT,
  last_attempt_status TEXT, last_attempt_at TEXT, PRIMARY KEY(catalogue_revision, consultation_id, language)
);`;
const catalogueObservedAt = '2026-11-24T12:00:00.000Z';
const csv = parseConsultationCsv(readFileSync('test/fixtures/consultations/catalogue.csv', 'utf8'));
const dictionary = readConsultationDictionary(JSON.parse(readFileSync('test/fixtures/consultations/schema.json', 'utf8')));

function fixture(options: { catalogue?: boolean; preview?: string } = {}) {
  const state = testD1({ schema });
  if (options.catalogue !== false) {
    state.sqlite.prepare(`INSERT INTO consultations_catalogues
      VALUES (?,?,?,?,?,?,?)`).run('canada', catalogueObservedAt, 'r1', 'csv-hash', 'schema-hash', '{}', '{}');
  }
  const records = csv.rows.map((row, index) => {
    const observedAt = index === 0 ? '2026-11-24T13:00:00.000Z' : '2026-11-24T11:00:00.000Z';
    const materialized = consultationFromRow(row, dictionary, observedAt);
    const { facts, searchText } = materialized;
    state.sqlite.prepare(`INSERT INTO consultations_records
      (id,owner_org,registration_number,status_code,start_date,end_date,state_at_observation,report_available,
       observed_at,first_observed_at,revision,facts_json,search_en,search_fr,removed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(facts.id, facts.ownerOrg, facts.registrationNumber, facts.statusCode,
      facts.dates.start, facts.dates.end, facts.stateAtObservation,
      facts.reportAvailableOnline === null ? null : Number(facts.reportAvailableOnline),
      observedAt, '2026-11-20T12:00:00.000Z', 2, JSON.stringify(facts), searchText.en, searchText.fr, null);
    state.sqlite.prepare(`INSERT INTO consultations_revisions
      VALUES (?,?,?,?,?,?)`).run(facts.id, '2026-11-23T12:00:00.000Z', 1, 'added', '[]', JSON.stringify(facts));
    state.sqlite.prepare(`INSERT INTO consultations_revisions
      VALUES (?,?,?,?,?,?)`).run(facts.id, '2026-11-24T11:00:00.000Z', 2, 'changed',
      JSON.stringify(['editions.en.title']), JSON.stringify(facts));
    return facts;
  });
  const env = { CONSULTATIONS_PREVIEW: options.preview ?? 'on', CIVIC_DB: state.db } as Env;
  return { ...state, env, records };
}

async function get(env: Env, path: string): Promise<unknown> {
  const prepared = prepareConsultations(new URL(`https://local.invalid${path}`));
  if (!prepared) throw new Error(`Expected consultations route for ${path}`);
  return prepared(env)();
}

it('guards preview and validates required, bounded, and closed query parameters', () => {
  const disabled = fixture({ preview: 'off' });
  try {
    expect(() => prepareConsultations(new URL('/api/consultations?query=x&language=en', 'https://local.invalid'))?.(disabled.env))
      .toThrow(/disabled/);
    const env = { ...disabled.env, CONSULTATIONS_PREVIEW: 'on' } as Env;
    for (const path of [
      '/api/consultations?query=x',
      '/api/consultations?query=&language=en',
      '/api/consultations?query=x&language=de',
      '/api/consultations?query=x&language=en&limit=101',
      '/api/consultations?query=x&language=en&state=active',
      '/api/consultations?query=x&language=en&unexpected=1',
    ]) expect(() => prepareConsultations(new URL(path, 'https://local.invalid'))?.(env)).toThrow();
    expect(() => prepareConsultations(new URL('/api/consultations?query=x&language=en', 'https://local.invalid'))?.({
      CONSULTATIONS_PREVIEW: 'on',
    } as Env)).toThrow(/storage is unavailable/);
  } finally { disabled.close(); }
});

it('searches both language indexes and returns bounded, correctly classified snippets', async () => {
  const f = fixture();
  try {
    const english = ConsultationSearchResponseSchema.parse(await get(f.env,
      '/api/consultations?query=artificial%20intelligence&language=en&asOf=2026-11-24T12%3A00%3A00Z'));
    expect(english.items[0]).toMatchObject({
      id: 'ic_C-0058', match: { field: 'title' }, editions: ['en', 'fr'],
    });
    expect(english.items[0]?.description).toBeNull();
    const englishDescription = ConsultationSearchResponseSchema.parse(await get(f.env,
      '/api/consultations?query=roundtable&language=en'));
    expect(englishDescription.items[0]).toMatchObject({
      id: 'ic_C-0058', match: { field: 'description', snippet: expect.stringContaining('Roundtable') },
    });
    const french = ConsultationSearchResponseSchema.parse(await get(f.env,
      '/api/consultations?query=intelligence%20artificielle&language=fr&limit=100'));
    expect(french.items.some(item => item.id === 'ic_C-0058')).toBe(true);
    expect(french.items.find(item => item.id === 'ic_C-0058')?.match.field).toBe('title');
    expect(french.items.every(item => (item.description?.length ?? 0) <= 400)).toBe(true);
    const frenchDescription = ConsultationSearchResponseSchema.parse(await get(f.env,
      '/api/consultations?query=table%20ronde&language=fr'));
    expect(frenchDescription.items[0]).toMatchObject({
      id: 'ic_C-0058', match: { field: 'description', snippet: expect.stringContaining('Table ronde') },
    });
  } finally { f.close(); }
});

it('filters open, planned, and closed states using inclusive UTC date boundaries', async () => {
  const f = fixture();
  try {
    const results = async (state: string, asOf: string) => ConsultationSearchResponseSchema.parse(await get(f.env,
      `/api/consultations?query=e&language=en&state=${state}&asOf=${asOf}`));
    const open = await results('open', '2026-11-24');
    const planned = await results('planned', '2026-11-24');
    const closed = await results('closed', '2026-11-24');
    expect(open.items.map(item => item.id)).toContain('esdc-edsc_C-1235757');
    expect(planned.items.map(item => item.id)).toContain('cnsc-ccsn_C202504');
    expect(closed.items.map(item => item.id)).toContain('ic_C-0058');
    expect((await results('open', '2027-01-29')).items.map(item => item.id)).toContain('esdc-edsc_C-1235757');
    expect((await results('closed', '2027-01-30')).items.map(item => item.id)).toContain('esdc-edsc_C-1235757');
  } finally { f.close(); }
});

it('returns current lookup and newest-first revisions, and null for an unknown identifier', async () => {
  const f = fixture();
  try {
    const found = ConsultationLookupResponseSchema.parse(await get(f.env,
      '/api/consultations/ic_C-0058?asOf=2026-11-24'));
    expect(found.item).toMatchObject({ id: 'ic_C-0058', firstObservedAt: '2026-11-20T12:00:00.000Z', revision: 2 });
    expect(found).not.toHaveProperty('participationNotices');
    expect(found.revisions.map(revision => revision.revision)).toEqual([2, 1]);
    expect(found.revisions[0]?.changedFields).toEqual(['editions.en.title']);
    expect(await get(f.env, '/api/consultations/no_such-record')).toMatchObject({ item: null, revisions: [] });
  } finally { f.close(); }
});

it('adds only current-revision, exact-ID and language-matched participation notice evidence to lookup', async () => {
  const f = fixture();
  const noticeStore = testD1({ schema: noticeSchema });
  try {
    const record = f.records.find((item) => item.id === 'ic_C-0058');
    if (!record) throw new Error('Expected the consultation fixture.');
    const insert = noticeStore.sqlite.prepare(`INSERT INTO notices
      (catalogue_revision,catalogue_observed_at,consultation_id,language,status,published_url,final_url,checked_at,
       http_status,media_type,body_sha256,body_bytes,object_path,sections_json,detail)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const language of ['en', 'fr'] as const) {
      const sourceUrl = record.editions[language].profile.url;
      if (!sourceUrl) throw new Error(`Missing ${language} catalogue profile URL.`);
      insert.run('r1', catalogueObservedAt, record.id, language, 'fetched', sourceUrl, sourceUrl,
        '2026-11-24T14:00:00.000Z', 200, 'text/html', language === 'en' ? 'a'.repeat(64) : 'b'.repeat(64), 1200,
        'notice-objects/hash.html.gz', JSON.stringify([{ kind: 'submission-instructions', heading: language === 'en' ? 'How to submit' : 'Comment soumettre',
          fragment: language === 'en' ? 'submit' : 'soumettre', level: 2, text: language === 'en' ? 'Send written comments to the department by email.' : 'Envoyez vos commentaires écrits au ministère par courriel.' }]), null);
    }
    // An older catalogue row and a same-revision row for another ID must not leak into the result.
    insert.run('old-r0', catalogueObservedAt, record.id, 'en', 'fetched', record.editions.en.profile.url,
      record.editions.en.profile.url, '2026-11-23T14:00:00.000Z', 200, 'text/html', 'c'.repeat(64), 10,
      'old.html.gz', JSON.stringify([{ kind: 'submission-instructions', heading: 'Old', fragment: 'old', level: 2, text: 'STALE QUOTE' }]), null);
    insert.run('r1', catalogueObservedAt, 'other-record', 'en', 'fetched', record.editions.en.profile.url,
      record.editions.en.profile.url, '2026-11-24T14:00:00.000Z', 200, 'text/html', 'd'.repeat(64), 10,
      'other.html.gz', JSON.stringify([{ kind: 'submission-instructions', heading: 'Other', fragment: 'other', level: 2, text: 'WRONG ID' }]), null);

    const env = { ...f.env, CONSULTATION_NOTICES_DB: noticeStore.db } as Env;
    const found = ConsultationLookupResponseSchema.parse(await get(env, '/api/consultations/ic_C-0058'));
    expect(found.participationNotices).toMatchObject({ catalogueRevision: 'r1', editions: [
      { consultationId: record.id, language: 'en', status: 'fetched', sourceHash: 'a'.repeat(64), sourceUrl: record.editions.en.profile.url,
        sections: [{ heading: 'How to submit', citationUrl: `${record.editions.en.profile.url}#submit`, quote: 'Send written comments to the department by email.', truncated: false }] },
      { consultationId: record.id, language: 'fr', status: 'fetched', sourceHash: 'b'.repeat(64), sourceUrl: record.editions.fr.profile.url,
        sections: [{ heading: 'Comment soumettre', quote: 'Envoyez vos commentaires écrits au ministère par courriel.' }] },
    ] });
    expect(JSON.stringify(found)).not.toContain('STALE QUOTE');
    expect(JSON.stringify(found)).not.toContain('WRONG ID');
  } finally { f.close(); noticeStore.close(); }
});

it('preserves per-source attribution for a catalogue-listed multi-source notice', async () => {
  const f = fixture();
  const noticeStore = testD1({ schema: noticeSchema });
  try {
    const record = f.records.find((item) => item.id === 'ic_C-0058');
    if (!record?.editions.en.profile.url) throw new Error('Missing English catalogue profile URL.');
    const secondUrl = 'https://www.canada.ca/en/example/additional-participation-details.html';
    const editedFacts = structuredClone(record);
    editedFacts.editions.en.profile.published = `${record.editions.en.profile.url} ; ${secondUrl}`;
    f.sqlite.prepare('UPDATE consultations_records SET facts_json=? WHERE id=?')
      .run(JSON.stringify(editedFacts), record.id);
    const firstHash = 'e'.repeat(64);
    const secondHash = 'f'.repeat(64);
    noticeStore.sqlite.prepare(`INSERT INTO notices
      (catalogue_revision,catalogue_observed_at,consultation_id,language,status,published_url,final_url,checked_at,
       http_status,media_type,body_sha256,body_bytes,object_path,sections_json,detail,sources_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('r1', catalogueObservedAt, record.id, 'en', 'fetched',
      record.editions.en.profile.url, record.editions.en.profile.url, '2026-11-24T14:00:00.000Z', 200,
      'text/html', firstHash, 100, 'first.html.gz', JSON.stringify([{ kind: 'submission-instructions',
        heading: 'Additional submission details', sourceUrl: secondUrl, bodySha256: secondHash,
        fragment: 'instructions', text: 'Include the completed form with your application.' }]), null,
      JSON.stringify([
        { order: 0, status: 'fetched', sourceUrl: record.editions.en.profile.url,
          finalUrl: record.editions.en.profile.url, sha256: firstHash, bytes: 100 },
        { order: 1, status: 'fetched', sourceUrl: secondUrl, finalUrl: secondUrl, sha256: secondHash, bytes: 120 },
      ]));
    const env = { ...f.env, CONSULTATION_NOTICES_DB: noticeStore.db } as Env;
    const found = ConsultationLookupResponseSchema.parse(await get(env, '/api/consultations/ic_C-0058'));
    expect(found.participationNotices?.editions[0]).toMatchObject({
      sourceHash: null,
      sourceUrl: null,
      sources: [
        { order: 0, sourceUrl: record.editions.en.profile.url, sourceHash: firstHash },
        { order: 1, sourceUrl: secondUrl, sourceHash: secondHash },
      ],
      sections: [{ heading: 'Additional submission details', citationUrl: `${secondUrl}#instructions`,
        sourceUrl: secondUrl, sourceHash: secondHash, quote: 'Include the completed form with your application.' }],
    });
  } finally { f.close(); noticeStore.close(); }
});

it('keeps removed records retrievable, excludes them from current coverage, and restores search on reappearance', async () => {
  const f = fixture();
  try {
    const base = ConsultationCoverageSchema.parse(await get(f.env, '/api/consultations/coverage'));
    const listed = f.records.find(record => record.id === 'ic_C-0058');
    if (!listed) throw new Error('Expected the fixture consultation.');
    const id = 'test_removed-ai';
    const facts = { ...listed, id, registrationNumber: 'removed-ai' };
    const observedAt = '2026-11-24T11:00:00.000Z';
    const searchEn = 'consultation responsible adoption artificial intelligence roundtable discussion';
    const searchFr = 'consultation adoption responsable intelligence artificielle table ronde';
    f.sqlite.prepare(`INSERT INTO consultations_records
      (id,owner_org,registration_number,status_code,start_date,end_date,state_at_observation,report_available,
       observed_at,first_observed_at,revision,facts_json,search_en,search_fr,removed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, facts.ownerOrg, facts.registrationNumber, facts.statusCode,
      facts.dates.start, facts.dates.end, facts.stateAtObservation,
      facts.reportAvailableOnline === null ? null : Number(facts.reportAvailableOnline),
      observedAt, '2026-11-20T12:00:00.000Z', 3, JSON.stringify(facts), searchEn, searchFr,
      '2026-11-25T12:00:00.000Z');
    const putRevision = (at: string, revision: number, event: string) => f.sqlite.prepare(
      'INSERT INTO consultations_revisions VALUES (?,?,?,?,?,?)',
    ).run(id, at, revision, event, '[]', JSON.stringify(facts));
    putRevision('2026-11-20T12:00:00.000Z', 1, 'added');
    putRevision('2026-11-24T11:00:00.000Z', 2, 'changed');
    putRevision('2026-11-25T12:00:00.000Z', 3, 'removed');

    const absent = ConsultationSearchResponseSchema.parse(await get(f.env,
      '/api/consultations?query=artificial%20intelligence&language=en&limit=100'));
    expect(absent.items.some(item => item.id === id)).toBe(false);
    const removedLookup = ConsultationLookupResponseSchema.parse(await get(f.env, `/api/consultations/${id}`));
    expect(removedLookup.item).toMatchObject({ id, removedAt: '2026-11-25T12:00:00.000Z', dates: facts.dates });
    expect(removedLookup.revisions[0]).toMatchObject({ event: 'removed', revision: 3 });

    const afterRemoval = ConsultationCoverageSchema.parse(await get(f.env, '/api/consultations/coverage'));
    expect(afterRemoval.counts.total).toBe(base.counts.total);
    expect(afterRemoval.counts.removed).toBe(1);
    expect(afterRemoval.counts.byState).toEqual(base.counts.byState);
    expect(afterRemoval.reports).toEqual(base.reports);
    expect(afterRemoval.revisions.total).toBe(base.revisions.total + 3);

    f.sqlite.prepare(`UPDATE consultations_records SET removed_at=NULL, revision=4,
      observed_at='2026-11-26T12:00:00.000Z' WHERE id=?`).run(id);
    putRevision('2026-11-26T12:00:00.000Z', 4, 'changed');
    const reappeared = ConsultationSearchResponseSchema.parse(await get(f.env,
      '/api/consultations?query=artificial%20intelligence&language=en&limit=100'));
    expect(reappeared.items.some(item => item.id === id)).toBe(true);
    const reappearedLookup = ConsultationLookupResponseSchema.parse(await get(f.env, `/api/consultations/${id}`));
    expect(reappearedLookup.item).toMatchObject({ removedAt: null });
  } finally { f.close(); }
});

it('computes coverage counts and rejects coverage without a published catalogue', async () => {
  const f = fixture();
  const empty = fixture({ catalogue: false });
  try {
    const coverage = ConsultationCoverageSchema.parse(await get(f.env, '/api/consultations/coverage?asOf=2026-11-24'));
    expect(coverage.counts.total).toBe(csv.rows.length);
    expect(coverage.counts.removed).toBe(0);
    expect(coverage.counts.stale).toBe(csv.rows.length - 1);
    expect(coverage.revisions.total).toBe(csv.rows.length * 2);
    expect(coverage.reports.available).toBeGreaterThan(0);
    const scoped = ConsultationCoverageSchema.parse(await get(f.env, '/api/consultations/coverage?institution=ic'));
    expect(scoped.counts.total).toBe(1);
    expect(scoped.revisions.total).toBe(2);
    await expect(get(empty.env, '/api/consultations/coverage')).rejects.toMatchObject({ status: 501 });
  } finally { f.close(); empty.close(); }
});

it('publishes OpenAPI operations and consultation discovery availability', async () => {
  const api = consultationsOpenApi();
  expect(api.paths['/api/consultations']?.get.operationId).toBe('searchConsultations');
  expect(api.paths['/api/consultations/coverage']?.get.operationId).toBe('getConsultationCoverage');
  expect(api.paths['/api/consultations/{id}']?.get.operationId).toBe('getConsultation');
  expect(api.paths['/api/consultations/openapi.json']?.get.operationId).toBe('getConsultationsOpenApi');
  expect(JSON.stringify(api.paths['/api/consultations/{id}']?.get.responses[200])).toContain('participationNotices');
  const f = fixture();
  try {
    const available = (await discoverSources({ env: f.env, accessReady: true }))
      .find(source => source.id === 'consultations');
    expect(available).toMatchObject({ status: 'available', editions: [
      { language: 'en', revision: 'r1' }, { language: 'fr', revision: 'r1' },
    ] });
    expect(available?.question).toBe('Which federal consultations ask about artificial intelligence, and when do they close?');
    const disabled = (await discoverSources({ env: { ...f.env, CONSULTATIONS_PREVIEW: 'off' } as Env, accessReady: true }))
      .find(source => source.id === 'consultations');
    expect(disabled).toMatchObject({ status: 'disabled', editions: [] });
  } finally { f.close(); }
});
