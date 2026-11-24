import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { FundingInventory, FundingSearchResponse, FundingCatalogueCoverage, FundingLookupResponse, FundingVersionsResponse } from '../src/corpora/funding';
import { prepareFunding } from '../src/routes/funding';
import { normalizeForSearch } from '../src/text';
import type { Env } from '../src/types';
import { testD1 } from './helpers/d1';

const schema = readFileSync(new URL('../preview/funding/migrations/0001_funding.sql', import.meta.url), 'utf8');
const revision = 'r1';
const indexes = { en: 'https://example.test/en', fr: 'https://example.test/fr' };
const section = (language: 'en' | 'fr') => ({ field: 'eligibility', heading: 'Eligibility',
  text: `${'Canadian researchers may apply. '.repeat(20)}L’équipement scientifique est admissible.`,
  url: `https://example.test/${language}/program#eligibility` });
const edition = (id: string, language: 'en' | 'fr', availability: 'published' | 'metadata-only' = 'published') => ({
  id, language, title: id.endsWith('alpha') ? 'Alpha Research Grant' : 'Beta Fellowship',
  url: `https://example.test/${language}/${id}`, status: 'open', statusText: 'Applications are open',
  availability, sections: [section(language)],
});

function fixture() {
  const state = testD1({ schema });
  const inventory = { source: 'nserc', observedAt: '2026-11-20T12:00:00.000Z', indexes, records: [
    edition('nserc-alpha', 'en'), edition('nserc-alpha', 'fr'), edition('nserc-beta', 'en', 'metadata-only'),
  ], gaps: [{ language: 'fr' as const, id: null, url: indexes.fr, reason: 'Source index unavailable.' }] };
  expect(FundingInventory.parse(inventory).records).toHaveLength(3);
  state.sqlite.prepare('INSERT INTO funding_catalogues VALUES (?,?,?,?,?)').run('nserc', inventory.observedAt, revision, JSON.stringify(indexes), JSON.stringify(inventory.gaps));
  for (const record of inventory.records) state.sqlite.prepare(`INSERT INTO funding_editions
    (source,id,language,revision,title,url,status,status_text,availability,sections_json,search_text) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('nserc', record.id, record.language, revision, record.title, record.url, record.status,
      record.statusText, record.availability, JSON.stringify(record.sections),
      `${record.title} ${record.statusText} ${record.availability === 'published' ? record.sections.map((x) => x.text).join(' ') : ''}`
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
  const putSection = state.sqlite.prepare(`INSERT INTO funding_sections
    (source,id,language,section_index,field,heading,text,url,normalized_heading,normalized_text) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const record of inventory.records) record.sections.forEach((entry, sectionIndex) => putSection.run('nserc', record.id,
    record.language, sectionIndex, entry.field, entry.heading, entry.text, entry.url, normalizeForSearch(entry.heading), normalizeForSearch(entry.text)));
  const past = { ...edition('nserc-alpha', 'en'), title: 'Alpha Grant' };
  state.sqlite.prepare('INSERT INTO funding_versions VALUES (?,?,?,?,?,?,?)').run('nserc', 'nserc-alpha', 'en', '2026-11-19T12:00:00.000Z', 'r0', 'added', JSON.stringify(past));
  state.sqlite.prepare('INSERT INTO funding_versions VALUES (?,?,?,?,?,?,?)').run('nserc', 'nserc-alpha', 'en', inventory.observedAt, 'r1', 'changed', JSON.stringify(edition('nserc-alpha', 'en')));
  const env = { FUNDING_PREVIEW: 'on', CIVIC_DB: state.db } as unknown as Env;
  return { ...state, env };
}

async function get(db: D1Database, env: Env, path: string) {
  const prepared = prepareFunding(new URL(`https://local.invalid${path}`));
  if (!prepared) throw new Error('Expected funding API route.');
  return prepared(env)();
}

it('validates inventory packets and returns cited searchable hits with compact edition metadata', async () => {
  const f = fixture();
  try {
    const result = FundingSearchResponse.parse(await get(f.db, f.env,
      '/api/funding-programs?source=nserc&language=en&query=researcher&limit=1'));
    expect(result.items).toMatchObject([{ id: 'nserc-alpha', revision: 'r1', match: { section: 'eligibility', url: section('en').url } }]);
    expect(result.items[0]).not.toHaveProperty('sections');
    expect(result.nextOffset).toBeNull();
    const accentless = FundingSearchResponse.parse(await get(f.db, f.env,
      '/api/funding-programs?source=nserc&language=fr&query=equipement'));
    expect(accentless.items).toMatchObject([{ id: 'nserc-alpha', match: { section: 'eligibility',
      url: section('fr').url, snippet: expect.stringContaining('L’équipement') } }]);
    const browse = FundingSearchResponse.parse(await get(f.db, f.env,
      '/api/funding-programs?source=nserc&language=en&limit=1'));
    expect(browse.nextOffset).toBe(1);
    await expect(get(f.db, f.env, '/api/funding-programs?source=nserc&language=en&limit=1&offset=1&revision=old'))
      .rejects.toMatchObject({ status: 400 });
  } finally { f.close(); }
});

it('returns exact cited editions, searchable and metadata-only coverage counts, and paged versions', async () => {
  const f = fixture();
  try {
    const lookup = FundingLookupResponse.parse(await get(f.db, f.env, '/api/funding-programs/nserc-alpha?language=en'));
    expect(lookup.item).toMatchObject({ id: 'nserc-alpha', revision: 'r1', sections: [section('en')] });
    const covered = FundingCatalogueCoverage.parse(await get(f.db, f.env, '/api/funding-programs/coverage?source=nserc'));
    expect(covered.recordsPerLanguage.en).toEqual({ total: 2, searchable: 1, metadataOnly: 1 });
    const history = FundingVersionsResponse.parse(await get(f.db, f.env,
      '/api/funding-programs/nserc-alpha/versions?language=en&limit=1'));
    expect(history).toMatchObject({ revision: 'r1', items: [{ revision: 'r1', event: 'changed' }], nextOffset: 1 });
    const next = FundingVersionsResponse.parse(await get(f.db, f.env,
      '/api/funding-programs/nserc-alpha/versions?language=en&limit=1&offset=1&revision=r1'));
    expect(next.items[0]?.event).toBe('added');
    await expect(get(f.db, f.env, '/api/funding-programs/esdc-anything?language=en'))
      .rejects.toMatchObject({ status: 501 });
  } finally { f.close(); }
});
