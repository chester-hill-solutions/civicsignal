import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONSULTATION_SOURCE, parseConsultationCsv } from '../src/corpora/consultations';
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
      expect(first.counts).toEqual({ rows: 9, added: 9, changed: 0, unchanged: 0, stale: 0 });
      const replay = f.publish(csvText);
      expect(replay).toMatchObject({
        revision: first.revision,
        counts: { rows: 9, added: 0, changed: 0, unchanged: 9, stale: 0 },
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
      expect(changed.counts).toMatchObject({ added: 0, changed: 1, unchanged: 8, stale: 0 });

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

  it('retains records omitted from the latest observation and preserves first observation metadata', () => {
    const f = materializerFixture();
    try {
      f.publish(csvText);
      const rows = parseConsultationCsv(csvText).rows.slice(1);
      const second = f.publish(serializeCsv(rows), '2026-11-21T12:00:00.000Z');
      expect(second.counts.stale).toBe(1);
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM consultations_records').get()?.n).toBe(9);

      const record = f.sqlite.prepare(
        'SELECT state_at_observation, first_observed_at, observed_at FROM consultations_records WHERE id=?',
      ).get('cwa-aec_C-0000001') as { state_at_observation: string; first_observed_at: string; observed_at: string };
      expect(record.first_observed_at).toBe(firstAt);
      expect(record.observed_at).toBe('2026-11-21T12:00:00.000Z');
      expect(record.state_at_observation).toBe('closed');
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
