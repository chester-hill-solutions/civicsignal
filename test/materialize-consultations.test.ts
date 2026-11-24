import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONSULTATION_SOURCE, consultationId, parseConsultationCsv } from '../src/corpora/consultations';
import { materializeConsultations } from '../src/corpora/consultations-materialize';
import { testD1 } from './helpers/d1';

const csvText = readFileSync('test/fixtures/consultations/catalogue.csv', 'utf8');
const dictionaryJson: unknown = JSON.parse(readFileSync('test/fixtures/consultations/schema.json', 'utf8'));
const csvSha256 = 'a'.repeat(64);
const schemaSha256 = 'b'.repeat(64);
const firstAt = '2026-11-20T12:00:00.000Z';

function serializeCsv(rows: Record<string, string>[]) {
  const headers = Object.keys(rows[0] ?? {});
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  return [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ''))]
    .map((row) => row.map(quote).join(','))
    .join('\n');
}

function materializerFixture() {
  const f = testD1({ schema: '' });
  const publish = (csv: string, observedAt = firstAt) => materializeConsultations(f.sqlite, {
    csvText: csv,
    dictionaryJson,
    observedAt,
    csvSha256,
    schemaSha256,
    csvSource: { input: 'fixture.csv' },
    schemaSource: { input: 'schema.json' },
  });
  return { ...f, publish };
}

describe('consultations catalogue materializer', () => {
  it('adds all rows, then replays unchanged input without adding revisions', () => {
    const f = materializerFixture();
    try {
      const first = f.publish(csvText);
      expect(first.counts).toEqual({ rows: 9, added: 9, changed: 0, unchanged: 0, stale: 0, removed: 0 });
      expect(first.changes.added).toBe(9);
      const replay = f.publish(csvText);
      expect(replay).toMatchObject({
        revision: first.revision,
        counts: { rows: 9, added: 0, changed: 0, unchanged: 9, stale: 0, removed: 0 },
        changes: {
          added: 0,
          removed: 0,
          categories: {
            'end-extended': 0,
            'end-shortened': 0,
            'start-moved': 0,
            'status-changed': 0,
            'report-changed': 0,
            'edition-changed': 0,
            other: 0,
          },
          sample: [],
        },
      });
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM consultations_revisions').get()?.n).toBe(9);
    } finally {
      f.close();
    }
  });

  it('records changed fields while retaining the previous revision', () => {
    const f = materializerFixture();
    try {
      f.publish(csvText);
      const rows = parseConsultationCsv(csvText).rows;
      const target = rows.find((row) => row.owner_org === 'cwa-aec');
      if (!target) throw new Error('Expected the fixture row.');
      target.end_date = '2026-11-25';
      target.report_available_online = 'Y';
      const changed = f.publish(serializeCsv(rows), '2026-11-21T12:00:00.000Z');
      expect(changed.counts).toMatchObject({ added: 0, changed: 1, unchanged: 8, stale: 0, removed: 0 });
      expect(changed.changes.categories).toMatchObject({ 'end-extended': 1, 'report-changed': 1 });
      expect(changed.changes.sample).toEqual([expect.objectContaining({
        id: 'cwa-aec_C-0000001',
        event: 'changed',
        categories: ['end-extended', 'report-changed'],
      })]);

      const id = 'cwa-aec_C-0000001';
      const revisions = f.sqlite.prepare(
        'SELECT event, changed_fields_json, facts_json FROM consultations_revisions WHERE id=? ORDER BY observed_at',
      ).all(id) as { event: string; changed_fields_json: string; facts_json: string }[];
      expect(revisions).toHaveLength(2);
      expect(revisions.map((row) => row.event)).toEqual(['added', 'changed']);
      expect(JSON.parse(revisions[1].changed_fields_json)).toEqual(['dates.end', 'report.available']);
      expect(JSON.parse(revisions[0].facts_json).dates.end).not.toBe('2026-11-25');
      expect(JSON.parse(revisions[1].facts_json).dates.end).toBe('2026-11-25');
    } finally {
      f.close();
    }
  });

  it('does not treat a later observation that closes a record as a publisher change', () => {
    const f = materializerFixture();
    try {
      f.publish(csvText, '2026-11-21T12:00:00.000Z');
      const replay = f.publish(csvText, '2026-12-01T12:00:00.000Z');
      expect(replay.counts).toMatchObject({ added: 0, changed: 0, unchanged: 9, stale: 0 });
      const row = f.sqlite.prepare(
        'SELECT state_at_observation, revision FROM consultations_records WHERE id=?',
      ).get('ic_C-0058') as { state_at_observation: string; revision: number };
      expect(row).toEqual({ state_at_observation: 'closed', revision: 1 });
    } finally {
      f.close();
    }
  });

  it('marks an omitted record removed without counting it stale or erasing its last listing', () => {
    const f = materializerFixture();
    try {
      f.publish(csvText);
      const id = 'cwa-aec_C-0000001';
      const before = f.sqlite.prepare(
        'SELECT facts_json, search_en, search_fr FROM consultations_records WHERE id=?',
      ).get(id) as { facts_json: string; search_en: string; search_fr: string };
      const rows = parseConsultationCsv(csvText).rows.filter((row) =>
        consultationId(row.owner_org, row.registration_number) !== id);
      const second = f.publish(serializeCsv(rows), '2026-11-21T12:00:00.000Z');
      expect(second.counts).toMatchObject({ rows: 8, removed: 1, stale: 0 });
      expect(second.changes.removed).toBe(1);
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM consultations_records').get()?.n).toBe(9);

      const record = f.sqlite.prepare(
        'SELECT state_at_observation, first_observed_at, observed_at, removed_at, revision, facts_json, search_en, search_fr FROM consultations_records WHERE id=?',
      ).get(id) as {
        state_at_observation: string;
        first_observed_at: string;
        observed_at: string;
        removed_at: string;
        revision: number;
        facts_json: string;
        search_en: string;
        search_fr: string;
      };
      expect(record.first_observed_at).toBe(firstAt);
      expect(record.observed_at).toBe(firstAt);
      expect(record.removed_at).toBe('2026-11-21T12:00:00.000Z');
      expect(record.revision).toBe(2);
      expect(record).toMatchObject({
        facts_json: before.facts_json,
        search_en: before.search_en,
        search_fr: before.search_fr,
      });
      const removal = f.sqlite.prepare(
        'SELECT event, revision, changed_fields_json, facts_json FROM consultations_revisions WHERE id=? ORDER BY observed_at DESC LIMIT 1',
      ).get(id) as { event: string; revision: number; changed_fields_json: string; facts_json: string };
      expect(removal).toMatchObject({ event: 'removed', revision: 2, changed_fields_json: '[]' });
      expect(removal.facts_json).toBe(record.facts_json);
    } finally {
      f.close();
    }
  });

  it('clears removal on reappearance and increments the revision as an added event', () => {
    const f = materializerFixture();
    try {
      const id = 'cwa-aec_C-0000001';
      f.publish(csvText);
      const withoutTarget = parseConsultationCsv(csvText).rows.filter((row) =>
        consultationId(row.owner_org, row.registration_number) !== id);
      f.publish(serializeCsv(withoutTarget), '2026-11-21T12:00:00.000Z');
      const reappeared = f.publish(csvText, '2026-11-22T12:00:00.000Z');
      expect(reappeared.counts).toMatchObject({ added: 1, removed: 0, changed: 0 });
      expect(reappeared.changes.added).toBe(1);
      expect(f.sqlite.prepare('SELECT removed_at, revision FROM consultations_records WHERE id=?').get(id))
        .toEqual({ removed_at: null, revision: 3 });
      expect(f.sqlite.prepare(
        'SELECT event, revision FROM consultations_revisions WHERE id=? ORDER BY observed_at',
      ).all(id)).toEqual([
        { event: 'added', revision: 1 },
        { event: 'removed', revision: 2 },
        { event: 'added', revision: 3 },
      ]);
    } finally {
      f.close();
    }
  });

  it('classifies end-date shortening and report-link additions', () => {
    const f = materializerFixture();
    try {
      const rows = parseConsultationCsv(csvText).rows;
      const target = rows.find((row) => row.owner_org === 'cwa-aec');
      if (!target) throw new Error('Expected the fixture row.');
      f.publish(csvText);
      target.end_date = '2026-10-26';
      target.report_available_online = 'Y';
      target.report_link_en = 'https://example.ca/report';
      const extensionAndReport = f.publish(serializeCsv(rows), '2026-11-21T12:00:00.000Z');
      expect(extensionAndReport.changes.categories).toMatchObject({
        'end-extended': 1,
        'report-changed': 1,
      });

      target.end_date = '2026-10-24';
      const shortened = f.publish(serializeCsv(rows), '2026-11-22T12:00:00.000Z');
      expect(shortened.changes.categories['end-shortened']).toBe(1);
    } finally {
      f.close();
    }
  });

  it('orders the digest sample by id and caps it at 50 entries', () => {
    const f = materializerFixture();
    try {
      const rows = parseConsultationCsv(csvText).rows;
      for (let index = 0; index < 55; index++) {
        rows.push({
          ...rows[0],
          owner_org: `sample-${String(index).padStart(2, '0')}`,
          registration_number: `R-${String(index).padStart(2, '0')}`,
        });
      }
      const result = f.publish(serializeCsv(rows));
      const ids = result.changes.sample.map((entry) => entry.id);
      const expected = rows.map((row) => consultationId(row.owner_org, row.registration_number))
        .sort((a, b) => a.localeCompare(b, 'en'))
        .slice(0, 50);
      expect(result.changes.sample).toHaveLength(50);
      expect(ids).toEqual(expected);
      expect(result.changes.added).toBe(64);
    } finally {
      f.close();
    }
  });

  it('rejects duplicate pairs and older observations', () => {
    const f = materializerFixture();
    try {
      const rows = parseConsultationCsv(csvText).rows;
      expect(() => f.publish(serializeCsv([...rows, rows[0]]))).toThrow(/duplicate owner_org and registration_number/);
      f.publish(csvText, '2026-11-21T12:00:00.000Z');
      expect(() => f.publish(csvText, firstAt)).toThrow('A newer consultation observation already exists.');
    } finally {
      f.close();
    }
  });

  it('stores catalogue hashes and both source metadata values', () => {
    const f = materializerFixture();
    try {
      f.publish(csvText);
      const catalogue = f.sqlite.prepare(
        'SELECT source, csv_sha256, schema_sha256, csv_source_json, schema_source_json FROM consultations_catalogues WHERE source=?',
      ).get(CONSULTATION_SOURCE) as {
        source: string;
        csv_sha256: string;
        schema_sha256: string;
        csv_source_json: string;
        schema_source_json: string;
      };
      expect(catalogue).toMatchObject({ source: CONSULTATION_SOURCE, csv_sha256: csvSha256, schema_sha256: schemaSha256 });
      expect(JSON.parse(catalogue.csv_source_json)).toEqual({ input: 'fixture.csv' });
      expect(JSON.parse(catalogue.schema_source_json)).toEqual({ input: 'schema.json' });
    } finally {
      f.close();
    }
  });
});
