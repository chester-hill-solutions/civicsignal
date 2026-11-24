import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/hansard/sitting-en.xml', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/hansard-local.ts', import.meta.url));
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof SqliteDatabase };

function run(database: string, xml: string) {
  const result = spawnSync('bun', ['--no-env-file', cli, 'import-xml', database, xml],
    { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(result.stderr.trim() || 'Hansard CLI import failed.');
  return JSON.parse(result.stdout) as {
    written: number; ids: string[]; publicationId: string; edition: string; status: string; removed: number;
  };
}

function databaseRows(database: string, sql: string) {
  const sqlite = new DatabaseSync(database, { readOnly: true });
  try { return sqlite.prepare(sql).all(); } finally { sqlite.close(); }
}

describe('local Hansard XML CLI import', () => {
  it('journals additions, corrections and removals from complete XML editions and skips unchanged bytes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'civicsignal-house-cli-test-'));
    try {
      const database = join(directory, 'hansard.sqlite');
      const xml = join(directory, 'sitting.xml');
      const original = readFileSync(fixture, 'utf8');
      writeFileSync(xml, original);

      expect(run(database, xml)).toEqual({
        written: 1,
        ids: ['hansard:en:45-1-999:99002'],
        publicationId: '99001',
        edition: 'en',
        status: 'imported',
        removed: 0,
      });

      const expanded = original.replace('</OrderOfBusiness>', `<Intervention id="99003">
        <PersonSpeaking><Affiliation>Another synthetic speaker</Affiliation></PersonSpeaking>
        <Content><ParaText>Debate on the budget.</ParaText></Content>
      </Intervention></OrderOfBusiness>`);
      writeFileSync(xml, expanded);
      expect(run(database, xml)).toMatchObject({ status: 'imported', removed: 0, written: 2 });

      const corrected = original.replace('housing regulation', 'revised housing policy');
      writeFileSync(xml, corrected);
      expect(run(database, xml)).toMatchObject({ status: 'imported', removed: 1, written: 1 });
      expect(run(database, xml)).toMatchObject({ status: 'unchanged', removed: 0, written: 0 });
      expect(databaseRows(database, `SELECT kind, record_id, before_search, after_search FROM source_feed_events
        WHERE source = 'house' ORDER BY seq`)).toEqual([
        { kind: 'added', record_id: 'hansard:en:45-1-999:99002', before_search: null, after_search: expect.any(String) },
        { kind: 'added', record_id: 'hansard:en:45-1-999:99003', before_search: null, after_search: expect.any(String) },
        { kind: 'corrected', record_id: 'hansard:en:45-1-999:99002', before_search: expect.any(String), after_search: expect.any(String) },
        { kind: 'removed', record_id: 'hansard:en:45-1-999:99003', before_search: expect.any(String), after_search: null },
      ]);
      expect(databaseRows(database, `SELECT id FROM hansard_speeches WHERE id = 'hansard:en:45-1-999:99003'`)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
