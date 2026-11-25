import { createRequire } from 'node:module';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GAZETTE_PREVIEW_ISSUES, gazetteRecordId, type GazetteEdition, type GazetteRecordKind } from '../src/corpora/gazette';
import { parseGazetteReplayManifest } from '../scripts/gazette-local';
import { importGazetteEdition, importGazetteEditions } from '../scripts/lib/gazette-store';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof SqliteDatabase };
const schema = readFileSync(new URL('../preview/gazette/migrations/0001_gazette.sql', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./fixtures/gazette/week.json', import.meta.url), 'utf8')) as {
  issues: Array<{ part: 'I' | 'II'; language: 'en' | 'fr'; issueDate: string; volume: number; issueNumber: number; file: string }>;
};

describe('local Gazette edition storage', () => {
  let sqlite: SqliteDatabase;
  beforeEach(() => { sqlite = new DatabaseSync(':memory:'); sqlite.exec(schema); });
  afterEach(() => sqlite.close());

  function syntheticEditions(): GazetteEdition[] {
    return GAZETTE_PREVIEW_ISSUES.map((key) => {
      const kinds: GazetteRecordKind[] = key.part === 'I' ? ['notice', 'proposal'] : ['instrument', 'instrument'];
      const records = kinds.map((kind, index) => {
        const token = key.part === 'II' ? `sor-2026-${66 + index}` : `${kind}-${index + 1}`;
        return {
          ...key,
          id: gazetteRecordId(key, token),
          kind,
          title: kind === 'proposal' ? 'Export control list proposal' : `${kind} fixture ${index + 1}`,
          citationUrl: `https://gazette.gc.ca/rp-pr/p${key.part === 'I' ? '1' : '2'}/${key.issueDate.slice(0, 4)}/${key.issueDate}/html/${token}-${key.language === 'en' ? 'eng' : 'fra'}.html${key.part === 'I' ? '#section-1' : ''}`,
          ...(key.part === 'II' ? { registrationNumber: `SOR/2026-${66 + index}`, registrationDate: '2026-03-31' } : {}),
        };
      });
      return { ...key, records };
    });
  }

  function at<T>(values: T[], index: number): T {
    const value = values[index];
    if (value === undefined) throw new Error(`Missing fixture value at ${index}`);
    return value;
  }

  function records() {
    return sqlite.prepare('SELECT id, part, language, kind, title, citation_url AS citationUrl FROM gazette_records ORDER BY id').all();
  }

  it('replays metadata-only synthetic editions and is repeatably idempotent', () => {
    const editions = syntheticEditions();
    const outcomes = editions.map((edition) => importGazetteEdition(sqlite, edition));
    expect(outcomes).toHaveLength(4);
    expect(outcomes.every(({ status }) => status === 'imported')).toBe(true);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM gazette_editions').get()).toEqual({ count: 4 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM gazette_records').get()).toEqual({
      count: editions.reduce((sum, edition) => sum + edition.records.length, 0),
    });
    const before = sqlite.prepare('SELECT total_changes() AS count').get();
    expect(editions.map((edition) => importGazetteEdition(sqlite, edition).status)).toEqual(['unchanged', 'unchanged', 'unchanged', 'unchanged']);
    expect(sqlite.prepare('SELECT total_changes() AS count').get()).toEqual(before);
  });

  it('replaces one corrected edition, removes obsolete rows, and preserves other language editions', () => {
    const editions = syntheticEditions();
    editions.forEach((edition) => importGazetteEdition(sqlite, edition));
    const target = at(editions, 0);
    const firstRecord = at(target.records, 0);
    const corrected = { ...target, records: [{ ...firstRecord, title: 'Corrected proposal title' }] };
    expect(importGazetteEdition(sqlite, corrected)).toMatchObject({ status: 'imported', written: 1, removed: target.records.length });
    expect(records()).toContainEqual(expect.objectContaining({ id: firstRecord.id, title: 'Corrected proposal title' }));
    for (const removed of target.records.slice(1)) {
      expect(records()).not.toContainEqual(expect.objectContaining({ id: removed.id }));
    }
    expect(importGazetteEdition(sqlite, at(editions, 1)).status).toBe('unchanged');
    expect(sqlite.prepare('SELECT record_count AS count FROM gazette_editions WHERE part = ? AND language = ?')
      .get(target.part, target.language)).toEqual({ count: 1 });
  });

  it('records a correction on the same publication date', () => {
    const edition = at(syntheticEditions(), 0);
    const original = at(edition.records, 0);
    importGazetteEdition(sqlite, edition);
    const corrected = { ...edition, records: [{ ...original, title: 'Corrected proposal title' }] };
    importGazetteEdition(sqlite, corrected);

    expect(sqlite.prepare(`SELECT kind, record_id AS recordId, publication_date AS publicationDate,
      before_search AS beforeSearch, after_search AS afterSearch, label, citation_url AS citationUrl
      FROM source_feed_events WHERE kind = 'corrected'`).all()).toEqual([{
      kind: 'corrected', recordId: original.id, publicationDate: edition.issueDate,
      beforeSearch: expect.any(String), afterSearch: expect.any(String), label: 'Corrected proposal title',
      citationUrl: original.citationUrl,
    }]);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM source_feed_events WHERE kind = ?').get('removed'))
      .toEqual({ count: edition.records.length - 1 });
  });

  it('records removals when an edition becomes empty', () => {
    const edition = at(syntheticEditions(), 0);
    importGazetteEdition(sqlite, edition);
    importGazetteEdition(sqlite, { ...edition, records: [] });

    expect(sqlite.prepare(`SELECT kind, COUNT(*) AS count FROM source_feed_events
      GROUP BY kind ORDER BY kind`).all()).toEqual([
      { kind: 'added', count: edition.records.length },
      { kind: 'removed', count: edition.records.length },
    ]);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM gazette_records').get()).toEqual({ count: 0 });
  });

  it('does not emit changes for reordered records or unchanged replay', () => {
    const edition = at(syntheticEditions(), 0);
    importGazetteEdition(sqlite, edition);
    const reversed = { ...edition, records: [...edition.records].reverse() };
    expect(importGazetteEdition(sqlite, reversed).status).toBe('unchanged');
    expect(importGazetteEdition(sqlite, edition).status).toBe('unchanged');
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM source_feed_events').get()).toEqual({ count: edition.records.length });
  });

  it('bootstraps feed history when an unchanged edition is replayed from a legacy database', () => {
    const edition = at(syntheticEditions(), 0);
    importGazetteEdition(sqlite, edition);
    sqlite.exec('DROP TABLE source_feed_events; DROP TABLE source_feed_editions; DROP TABLE source_feed_identity;');

    expect(importGazetteEdition(sqlite, edition).status).toBe('unchanged');
    expect(sqlite.prepare(`SELECT kind, COUNT(*) AS count FROM source_feed_events GROUP BY kind`).all())
      .toEqual([{ kind: 'added', count: edition.records.length }]);
  });

  it('records zero-row available editions and rejects mismatched or duplicate identities', () => {
    const editions = syntheticEditions();
    const first = at(editions, 0);
    const empty = { ...first, records: [] };
    expect(importGazetteEdition(sqlite, empty)).toMatchObject({ status: 'imported', written: 0, removed: 0 });
    expect(sqlite.prepare('SELECT record_count AS count FROM gazette_editions').get()).toEqual({ count: 0 });
    const record = at(first.records, 0);
    expect(() => importGazetteEdition(sqlite, { ...first, records: [{ ...record, language: 'fr' }] }))
      .toThrow('match its containing issue');
    expect(() => importGazetteEdition(sqlite, { ...first, records: [record, record] })).toThrow('Duplicate Gazette record ID');
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM gazette_editions').get()).toEqual({ count: 1 });
  });

  it('requires every configured issue edition exactly once before replay begins', () => {
    expect(parseGazetteReplayManifest(manifest)).toMatchObject({ issues: expect.any(Array) });
    const duplicate = { issues: [...manifest.issues.slice(0, 3), manifest.issues[0]] };
    expect(() => parseGazetteReplayManifest(duplicate)).toThrow('duplicate issue edition');
    const missing = { issues: manifest.issues.slice(0, 3) };
    expect(() => parseGazetteReplayManifest(missing)).toThrow();
  });

  it('rolls back the row replacement and edition metadata when a write fails', () => {
    const edition = at(syntheticEditions(), 0);
    importGazetteEdition(sqlite, edition);
    const beforeRows = records();
    sqlite.exec(`CREATE TRIGGER reject_gazette_record BEFORE INSERT ON gazette_notices
      BEGIN SELECT RAISE(ABORT, 'fixture write failed'); END`);
    const corrected = { ...edition, records: edition.records.map((item) => ({ ...item, title: `${item.title} corrected` })) };
    expect(() => importGazetteEdition(sqlite, corrected)).toThrow('fixture write failed');
    expect(records()).toEqual(beforeRows);
    expect(importGazetteEdition(sqlite, edition).status).toBe('unchanged');
  });

  it('rolls back row replacement and feed events when feed recording fails', () => {
    const edition = at(syntheticEditions(), 0);
    importGazetteEdition(sqlite, edition);
    const beforeRows = records();
    const beforeEvents = sqlite.prepare('SELECT * FROM source_feed_events ORDER BY seq').all();
    sqlite.exec(`CREATE TRIGGER reject_source_feed_event BEFORE INSERT ON source_feed_events
      BEGIN SELECT RAISE(ABORT, 'fixture feed failed'); END`);
    const corrected = { ...edition, records: edition.records.map((item) => ({ ...item, title: `${item.title} corrected` })) };
    expect(() => importGazetteEdition(sqlite, corrected)).toThrow('fixture feed failed');
    expect(records()).toEqual(beforeRows);
    expect(sqlite.prepare('SELECT * FROM source_feed_events ORDER BY seq').all()).toEqual(beforeEvents);
    expect(importGazetteEdition(sqlite, edition).status).toBe('unchanged');
  });

  it('rolls back all four rolling issue writes and feed changes if the final issue fails', () => {
    const previous = syntheticEditions();
    previous.forEach((item) => importGazetteEdition(sqlite, item));
    const beforeRows = records();
    const beforeEditions = sqlite.prepare('SELECT * FROM gazette_editions ORDER BY part, language, issue_date').all();
    const beforeEvents = sqlite.prepare('SELECT * FROM source_feed_events ORDER BY seq').all();
    const rolling = previous.map((item) => {
      const issueDate = item.part === 'I' ? '2026-11-21' : '2026-11-18';
      const issueNumber = item.part === 'I' ? 47 : 23;
      const { records: _records, ...baseKey } = item;
      const key = { ...baseKey, issueDate, issueNumber };
      const records = item.records.map((record) => {
        const token = record.id.split(':').at(-1) ?? '';
        return { ...record, ...key, id: gazetteRecordId(key, token),
          citationUrl: `https://gazette.gc.ca/rp-pr/p${item.part === 'I' ? '1' : '2'}/2026/${issueDate}/html/${token}-${item.language === 'en' ? 'eng' : 'fra'}.html${item.part === 'I' ? '#section-1' : ''}` };
      });
      return { ...key, records };
    });
    sqlite.exec(`CREATE TRIGGER reject_last_current_issue BEFORE INSERT ON gazette_instruments
      WHEN NEW.language = 'fr' AND NEW.issue_date = '2026-11-18'
      BEGIN SELECT RAISE(ABORT, 'last current issue failed'); END`);

    expect(() => importGazetteEditions(sqlite, rolling)).toThrow('last current issue failed');
    expect(records()).toEqual(beforeRows);
    expect(sqlite.prepare('SELECT * FROM gazette_editions ORDER BY part, language, issue_date').all()).toEqual(beforeEditions);
    expect(sqlite.prepare('SELECT * FROM source_feed_events ORDER BY seq').all()).toEqual(beforeEvents);
    expect(importGazetteEdition(sqlite, previous[0]).status).toBe('unchanged');
  });
});
