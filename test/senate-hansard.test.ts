import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixtures = fileURLToPath(new URL('./fixtures/senate-hansard', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/hansard-local.ts', import.meta.url));
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof SqliteDatabase };

function run(command: string, database: string, ...args: string[]) {
  const result = spawnSync('bun', ['--no-env-file', cli, command, database, ...args],
    { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  if (!result.stdout.trim()) throw new Error(result.stderr.trim() || 'Hansard CLI produced no result.');
  return { status: result.status, output: JSON.parse(result.stdout) };
}

function workspace(action: (directory: string, database: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'civicsignal-senate-test-'));
  try {
    cpSync(fixtures, directory, { recursive: true });
    action(directory, join(directory, 'hansard.sqlite'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function feedRows(database: string, sql: string) {
  const sqlite = new DatabaseSync(database, { readOnly: true });
  try { return sqlite.prepare(sql).all(); } finally { sqlite.close(); }
}

describe('local Senate Hansard replay', () => {
  it('imports both editions, searches and cites the Senate, and skips an identical replay', () => {
    workspace((directory, db) => {
      const manifest = join(directory, 'week.json');
      expect(run('replay-senate-week', db, manifest)).toMatchObject({
        status: 0, output: { counts: { imported: 2 }, editions: [{ written: 2 }, { written: 2 }] },
      });
      expect(feedRows(db, `SELECT kind, record_id FROM source_feed_events WHERE source = 'senate'
        ORDER BY language, record_id`)).toEqual([
        { kind: 'added', record_id: 'senate-hansard:en:45-1-67:8-1' },
        { kind: 'added', record_id: 'senate-hansard:en:45-1-67:8-2' },
        { kind: 'added', record_id: 'senate-hansard:fr:45-1-67:8-1' },
        { kind: 'added', record_id: 'senate-hansard:fr:45-1-67:8-2' },
      ]);
      expect(run('replay-senate-week', db, manifest)).toMatchObject({
        status: 0, output: { counts: { imported: 0, unchanged: 2 } },
      });
      const first = run('search-senate', db, 'fr', 'reseau').output;
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        id: 'senate-hansard:fr:45-1-67:8-1',
        corpusId: 'hansard-senate',
        source: 'Senate of Canada',
        excerpt: 'Le réseau ferroviaire relierait les deux villes.',
        extra: { chamber: 'senate', citationGranularity: 'section', speaker: 'La sénatrice Exemple' },
        citationUrl: 'https://sencanada.ca/fr/content/sen/chamber/451/debates/067db_2026-04-23-f#8',
      });
      expect(first[0].body).toBeUndefined();
      expect(first[0].redistribution).toBe('cite-only');
      expect(run('show', db, first[0].id).output).toEqual(first[0]);
      expect(run('search-senate', db, 'en', 'rail').output).toHaveLength(1);
      expect(run('search', db, 'en', 'rail').output).toEqual([]);
      expect(run('search-senate', db, 'en', 'has no speaker').output).toEqual([]);
    });
  });

  it('applies corrections under the same ID and keeps a previous edition when a new one mismatches', () => {
    workspace((directory, db) => {
      const manifest = join(directory, 'week.json');
      expect(run('replay-senate-week', db, manifest).status).toBe(0);
      const english = join(directory, 'issue-en.html');
      writeFileSync(english, readFileSync(english, 'utf8').replace('two towns', 'three towns'));
      const french = join(directory, 'issue-fr.html');
      writeFileSync(french, readFileSync(french, 'utf8').replace('23 avril', '22 avril'));

      expect(run('replay-senate-week', db, manifest)).toMatchObject({
        status: 1,
        output: { counts: { imported: 1, failed: 1 }, editions: [{ edition: 'en' }, { edition: 'fr', status: 'failed' }] },
      });
      expect(run('show', db, 'senate-hansard:en:45-1-67:8-1').output.excerpt).toContain('three towns');
      expect(run('show', db, 'senate-hansard:fr:45-1-67:8-1').output.excerpt).toContain('les deux villes');
      expect(feedRows(db, `SELECT kind, record_id FROM source_feed_events WHERE source = 'senate'
        AND kind = 'corrected'`)).toEqual([
        { kind: 'corrected', record_id: 'senate-hansard:en:45-1-67:8-1' },
      ]);
    });
  });

  it('does not create a Senate feed edition for a missing language import', () => {
    workspace((directory, db) => {
      const manifest = join(directory, 'missing-week.json');
      writeFileSync(manifest, JSON.stringify({ weekOf: '2026-04-20', sittings: [{
        sittingId: '45-1-67', sittingDate: '2026-04-23', en: null, fr: 'issue-fr.html',
      }] }));
      expect(run('replay-senate-week', db, manifest)).toMatchObject({
        status: 1, output: { counts: { imported: 1, missing: 1 } },
      });
      expect(feedRows(db, `SELECT language, edition_id FROM source_feed_editions WHERE source = 'senate'`)).toEqual([
        { language: 'fr', edition_id: '45-1-67' },
      ]);
      expect(feedRows(db, `SELECT DISTINCT language FROM source_feed_events WHERE source = 'senate'`)).toEqual([
        { language: 'fr' },
      ]);
    });
  });

  it('preserves the citation and publication date on a removed-turn tombstone', () => {
    workspace((directory, db) => {
      const manifest = join(directory, 'english-week.json');
      writeFileSync(manifest, JSON.stringify({ weekOf: '2026-04-20', sittings: [{
        sittingId: '45-1-67', sittingDate: '2026-04-23', en: 'issue-en.html', fr: null,
      }] }));
      expect(run('replay-senate-week', db, manifest)).toMatchObject({
        status: 1, output: { counts: { imported: 1, missing: 1 } },
      });

      const english = join(directory, 'issue-en.html');
      writeFileSync(english, readFileSync(english, 'utf8')
        .replace('<p><strong>Senator Fixture:</strong> The planned timetable includes weekends.</p>', ''));
      expect(run('replay-senate-week', db, manifest)).toMatchObject({
        status: 1, output: { counts: { imported: 1, missing: 1 }, editions: [{ removed: 1 }, { status: 'missing' }] },
      });
      expect(feedRows(db, `SELECT kind, record_id, publication_date, citation_url, before_search, after_search
        FROM source_feed_events WHERE source = 'senate' AND kind = 'removed'`)).toEqual([{
        kind: 'removed',
        record_id: 'senate-hansard:en:45-1-67:8-2',
        publication_date: '2026-04-23',
        citation_url: 'https://sencanada.ca/en/content/sen/chamber/451/debates/067db_2026-04-23-e#8',
        before_search: 'the planned timetable includes weekends.',
        after_search: null,
      }]);
    });
  });
});
