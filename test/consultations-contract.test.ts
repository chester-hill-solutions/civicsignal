import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a fixture row.');
  return value;
}
import {
  consultationFromRow,
  consultationId,
  parseConsultationCsv,
  readConsultationDictionary,
  stateAsOf,
  statusAgrees,
} from '../src/corpora/consultations';
import { parseCsvText } from '../src/csv';

const catalogue = readFileSync(new URL('./fixtures/consultations/catalogue.csv', import.meta.url), 'utf8');
const schema = JSON.parse(readFileSync(new URL('./fixtures/consultations/schema.json', import.meta.url), 'utf8')) as unknown;
const parsed = parseConsultationCsv(catalogue);
const dictionary = readConsultationDictionary(schema);
const observedAt = '2026-11-24T12:00:00Z';

it('parses the checked-in catalogue and builds unique, lowercase composite identities', () => {
  expect(parsed.header).toHaveLength(17);
  expect(parsed.rows).toHaveLength(9);
  const sameRegistration = parsed.rows.filter((row) => row.registration_number === 'C-0000001');
  expect(sameRegistration).toHaveLength(2);
  const ids = sameRegistration.map((row) => consultationId(row.owner_org, row.registration_number));
  expect(ids).toEqual(['casdo-ocena_C-0000001', 'cwa-aec_C-0000001']);
  expect(new Set(ids).size).toBe(2);
  expect(consultationId('IC', 'C-0058')).toBe('ic_C-0058');
  expect(consultationId('isc-sac', 'c-ISC0016')).not.toBe(consultationId('isc-sac', 'c-isc0016'));
});

it('normalizes link variants, unwraps Safe Links and retains published HTTP', () => {
  const safeRow = parsed.rows.find((row) => row.registration_number === 'C-0000117');
  const httpRow = parsed.rows.find((row) => row.registration_number === 'A-004148');
  const bareRow = parsed.rows.find((row) => row.registration_number === 'C-0000072');
  expect(safeRow).toBeDefined();
  expect(httpRow).toBeDefined();
  expect(bareRow).toBeDefined();
  const safe = consultationFromRow(required(safeRow), dictionary, observedAt).facts.editions.en.profile;
  expect(safe.kind).toBe('third-party-wrapper');
  expect(safe.unwrapped).toMatch(/^https:\/\/m\.facebook\.com\//);
  expect(safe.url).toBe(safe.unwrapped);
  expect(safe.published).toContain('safelinks.protection.outlook.com');

  const http = consultationFromRow(required(httpRow), dictionary, observedAt).facts.editions.en.profile;
  expect(http.url).toBe('http://esdc-consultations.canada.ca/homelessness');
  expect(http.kind).toBe('official');

  const schemeLess = consultationFromRow({
    ...required(bareRow),
    profile_page_en: ' agency.canada.ca/consultations/topic ',
  }, dictionary, observedAt).facts.editions.en.profile;
  expect(schemeLess.url).toBe('https://agency.canada.ca/consultations/topic');
  expect(schemeLess.published).toBe('agency.canada.ca/consultations/topic');
});

it('treats N/A and NA links as missing and preserves institution language labels', () => {
  const row = required(parsed.rows.find((candidate) => candidate.owner_org === 'ic'));
  const facts = consultationFromRow({
    ...row,
    profile_page_en: ' N/A ',
    profile_page_fr: 'NA',
  }, dictionary, observedAt).facts;
  expect(facts.editions.en.profile).toEqual({ published: 'N/A', url: null, kind: 'missing', unwrapped: null });
  expect(facts.editions.fr.profile).toEqual({ published: 'NA', url: null, kind: 'missing', unwrapped: null });
  expect(facts.institution).toEqual({
    en: 'Innovation, Science and Economic Development Canada',
    fr: 'Innovation, Sciences et Développement économique Canada',
  });
});

it('keeps missing French descriptions, dictionary labels and inferred closed status explicit', () => {
  const row = required(parsed.rows.find((candidate) => candidate.registration_number === 'A-003291'));
  const result = consultationFromRow(row, dictionary, observedAt);
  expect(result.facts.editions.fr.description).toBeNull();
  expect(result.facts.status).toEqual({
    code: 'C',
    label: { en: 'Closed', fr: 'Fermée' },
    inferred: true,
  });
  const open = consultationFromRow(required(parsed.rows.find((candidate) => candidate.status === 'O')), dictionary, observedAt);
  expect(open.facts.status).toEqual({
    code: 'O',
    label: { en: 'Open – Accepting Input', fr: 'Ouverte – Avis acceptés' },
    inferred: false,
  });
  expect(result.facts.subjects.find((subject) => subject.code === 'TX')?.label).toEqual({
    en: 'Taxes',
    fr: 'Impôts et taxes',
  });
  expect(result.facts.subjects.find((subject) => subject.code === 'ZZ')?.label).toBeUndefined();
  const partnerDictionary = readConsultationDictionary({
    resources: [{
      resource_name: 'consultations',
      fields: [{
        id: 'partner_departments',
        choices: { PD: { en: 'Partner department', fr: 'Ministère partenaire' } },
      }],
    }],
  });
  const knownPartner = consultationFromRow({ ...row, partner_departments: 'PD' }, partnerDictionary, observedAt).facts;
  expect(knownPartner.partnerDepartments).toEqual([{
    code: 'PD',
    label: { en: 'Partner department', fr: 'Ministère partenaire' },
  }]);
  const unknownCodes = consultationFromRow({ ...row, subjects: 'ZZ', partner_departments: 'XX' }, dictionary, observedAt).facts;
  expect(unknownCodes.subjects).toEqual([{ code: 'ZZ', label: null }]);
  expect(unknownCodes.partnerDepartments).toEqual([{ code: 'XX', label: null }]);
});

it('computes date states and publisher-status agreement', () => {
  const dates = { start: '2026-10-27', end: '2027-01-29' };
  expect(stateAsOf(dates, '2026-10-26T23:59:59Z')).toEqual({ state: 'planned', basis: 'dates' });
  expect(stateAsOf(dates, '2026-10-27T00:00:00Z')).toEqual({ state: 'open', basis: 'dates' });
  expect(stateAsOf(dates, '2027-01-29T23:59:59.999Z')).toEqual({ state: 'open', basis: 'dates' });
  expect(stateAsOf(dates, '2027-01-30T00:00:00Z')).toEqual({ state: 'closed', basis: 'dates' });
  expect(stateAsOf({ start: dates.start, end: null }, observedAt)).toEqual({ state: 'unknown', basis: 'missing-dates' });
  expect(statusAgrees('O', 'open')).toBe(true);
  expect(statusAgrees('P', 'planned')).toBe(true);
  expect(statusAgrees('C', 'closed')).toBe(true);
  expect(statusAgrees('X', 'closed')).toBeNull();
});

it('parses multiline CSV records and doubled quotes and normalizes bilingual search text', () => {
  expect(parseCsvText('\uFEFFa,b\r\n"line one\nline ""two""",value\r\n')).toEqual([
    ['a', 'b'],
    ['line one\nline "two"', 'value'],
  ]);
  const row = required(parsed.rows[0]);
  const result = consultationFromRow(row, dictionary, observedAt);
  expect(result.searchText.en).toContain('early engagement on phase 2 digital technologies accessibility regulations');
  expect(result.searchText.fr).toContain('consultation preliminaire sur le reglement de la phase 2');
});
