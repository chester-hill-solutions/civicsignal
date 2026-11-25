import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { materializeConsultations } from '../src/corpora/consultations-materialize';
import { parseConsultationCsv } from '../src/corpora/consultations';
import { publishConsultations } from '../services/consultations/publish';
import { testD1 } from './helpers/d1';

const schema = readFileSync('services/consultations/migrations/0001_consultations.sql', 'utf8');
const csv = readFileSync('test/fixtures/consultations/catalogue.csv', 'utf8');
const dictionary = readFileSync('test/fixtures/consultations/schema.json', 'utf8');
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const input = (csvText: string, observedAt: string) => ({
  csvText, observedAt, csvSha256: digest(csvText), dictionaryJson: JSON.parse(dictionary), schemaSha256: digest(dictionary),
});
const early = '2026-11-20T12:00:00.000Z';
const later = '2026-12-01T12:00:00.000Z';
const latest = '2026-12-02T12:00:00.000Z';

const close: Array<() => void> = [];
function open(schema: string) {
  const fixture = testD1({ schema });
  close.push(fixture.close);
  return fixture;
}
afterEach(() => { while (close.length) close.pop()?.(); });

function serialized(rows: Record<string,string>[]) {
  const header = Object.keys(rows[0]);
  const escape = (cell: string) => '"' + cell.replaceAll('"','""') + '"';
  return [header, ...rows.map(row => header.map(key => row[key]))].map(cells => cells.map(escape).join(',')).join('\n');
}

function compareStores(hosted: ReturnType<typeof open>, local: ReturnType<typeof open>) {
  const rows = (store: typeof local, sql: string) => store.sqlite.prepare(sql).all().map(row => ({
    ...row, facts_json: JSON.parse(String(row.facts_json)),
  }));
  for (const sql of ['SELECT * FROM consultations_records ORDER BY id',
    'SELECT * FROM consultations_revisions ORDER BY id,observed_at']) {
    expect(rows(hosted, sql)).toEqual(rows(local, sql));
  }
}

describe('hosted consultations publication', () => {
  it('matches local revisions, lookups and bilingual facts after new, unchanged, removed and reappearing editions', async () => {
    const local = open('');
    const hosted = open(schema);
    const rows = parseConsultationCsv(csv).rows;
    rows[0].title_fr += ' (mise à jour)';
    const changed = serialized(rows.slice(0,-1));
    for (const [source,observedAt] of [[csv,early],[csv,later],[changed,latest],[csv,'2026-12-03T12:00:00.000Z']]) {
      const packet = input(source,observedAt);
      const expected = materializeConsultations(local.sqlite,packet);
      const result = await publishConsultations(hosted.db,packet);
      expect(result).toMatchObject({ revision:expected.revision,rows:expected.counts.rows,
        replayed:observedAt===later,sampleTitles:{ en:expect.any(String),fr:expect.any(String) } });
      compareStores(hosted,local);
    }
  });

  it('keeps the prior head on a failed commit and can resume staged changes without duplicate history or touching notices', async () => {
    const { db,sqlite } = open(schema);
    const first = await publishConsultations(db,input(csv,early));
    sqlite.exec(`CREATE TABLE notices(quote TEXT); INSERT INTO notices VALUES ('original');
      CREATE TRIGGER fail_head BEFORE UPDATE ON consultations_catalogues BEGIN SELECT RAISE(ABORT,'injected'); END;`);
    const rows = parseConsultationCsv(csv).rows;
    rows[0].title_en += ' changed';
    const packet = input(serialized(rows),later);
    await expect(publishConsultations(db,packet)).rejects.toThrow('injected');
    expect(sqlite.prepare('SELECT revision FROM consultations_catalogues').get()?.revision).toBe(first.revision);
    expect(sqlite.prepare('SELECT count(*) AS n FROM consultations_revisions').get()?.n).toBe(first.rows);
    expect(sqlite.prepare('SELECT count(*) AS n FROM consultation_pending').get()?.n).toBe(1);
    sqlite.exec('DROP TRIGGER fail_head');
    await publishConsultations(db,packet);
    const retry = await publishConsultations(db,packet);
    expect(retry).toMatchObject({ replayed:true,rowsWritten:0 });
    expect(sqlite.prepare('SELECT count(*) AS n FROM consultations_revisions').get()?.n).toBe(first.rows+1);
    expect(sqlite.prepare('SELECT quote FROM notices').get()?.quote).toBe('original');
  });

  it('rejects truncated and over-wide CSV rows without replacing a good catalogue', async () => {
    const { db, sqlite } = open(schema);
    const first = await publishConsultations(db, input(csv, early));
    for (const badRow of ['C-100,one field', Array(18).fill('unexpected').join(',')]) {
      const truncated = csv.trimEnd() + '\n' + badRow;
      await expect(publishConsultations(db, input(truncated, later))).rejects.toThrow(/width/);
    }
    expect(sqlite.prepare('SELECT revision FROM consultations_catalogues').get()?.revision).toBe(first.revision);
  });

  it('rejects an overlapping stale diff then permits a retry against the winner', async () => {
    const { db,sqlite } = open(schema);
    await publishConsultations(db,input(csv,early));
    const rows = parseConsultationCsv(csv).rows;
    rows[0].title_en += ' changed';
    const stale = input(serialized(rows),latest);
    // Pause the older-base publisher immediately before its atomic commit.
    const original = db.batch.bind(db);
    db.batch = async statements => {
      db.batch = original;
      await publishConsultations(db,input(csv,later));
      return original(statements);
    };
    await expect(publishConsultations(db,stale)).rejects.toThrow(/CHECK/);
    expect(sqlite.prepare('SELECT observed_at FROM consultations_catalogues').get()?.observed_at).toBe(later);
    await publishConsultations(db,stale);
    await expect(publishConsultations(db,input(csv,later))).rejects.toThrow(/newer/);
    await expect(publishConsultations(db,input(csv,latest))).rejects.toThrow(/conflicting/);
  });
});
