import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256File } from '../scripts/lib/file-integrity';
import { createStage, openSqlite, rollbackPreservingError, splitWrittenQuestionText, swapCandidate } from '../scripts/materialize-written-questions';

describe('local written-question D1 materialization SQL', () => {
  it('opens read-write and read-only databases through the runtime-native SQLite module', () => {
    const directory = mkdtempSync(join(tmpdir(), 'written-question-sqlite-'));
    const path = join(directory, 'source.sqlite');
    try {
      const writable = openSqlite(path);
      writable.exec('CREATE TABLE sample (value TEXT NOT NULL); INSERT INTO sample VALUES (\'ready\');');
      writable.close();

      const readonly = openSqlite(path, true);
      try {
        expect(readonly.prepare('SELECT value FROM sample').get()).toEqual({ value: 'ready' });
        expect(() => readonly.exec('INSERT INTO sample VALUES (\'blocked\')')).toThrow();
      } finally { readonly.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('hashes a file across bounded chunks without relying on async stream iteration', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'written-question-hash-'));
    const path = join(directory, 'source.bin');
    const content = Buffer.alloc(2 * 1024 * 1024 + 37, 0x5a);
    try {
      writeFileSync(path, content);
      const expected = createHash('sha256').update(readFileSync(path)).digest('hex');
      await expect(sha256File(path)).resolves.toBe(expected);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps the previous FTS-served generation when a post-swap validation rejects the candidate', () => {
    const directory = mkdtempSync(join(tmpdir(), 'written-question-swap-'));
    const databasePath = join(directory, 'serving.sqlite');
    const sqlite = openSqlite(databasePath);
    try {
      sqlite.exec(readFileSync(new URL('../preview/written-questions/migrations/0001_written_questions.sql', import.meta.url), 'utf8'));
      sqlite.prepare('INSERT INTO wq_sessions VALUES (?, ?)').run('45-1', '{}');
      sqlite.prepare(`INSERT INTO questions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        '45-1', 1, 'en', 'https://www.ourcommons.ca/previous', 'previous generation', 'answered', null, null,
        null, '{}', 'a'.repeat(64), null, 'complete', null, null);
      sqlite.prepare('INSERT INTO wq_fts VALUES (?,?,?,?,?,?)').run('45-1', '1', 'en', '', 0, 'previous generation');
      sqlite.prepare('INSERT INTO wq_materialization_state VALUES (1,?,?,?,?,?,?)')
        .run('a'.repeat(64), 1, 0, 0, 1, 'previous');
      createStage(sqlite);
      sqlite.prepare('INSERT INTO wq_stage_sessions VALUES (?, ?)').run('45-1', '{}');
      sqlite.prepare(`INSERT INTO wq_stage_questions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        '45-1', 2, 'en', 'https://www.ourcommons.ca/candidate', 'candidate generation', 'answered', null, null,
        null, '{}', 'b'.repeat(64), null, 'complete', null, null);
      sqlite.prepare('INSERT INTO wq_stage_fts VALUES (?,?,?,?,?,?)').run('45-1', '2', 'en', '', 0, 'candidate generation');
      sqlite.prepare('INSERT INTO wq_stage_materialization_state VALUES (1,?,?,?,?,?,?)')
        .run('b'.repeat(64), 1, 0, 0, 1, 'candidate');

      swapCandidate(sqlite);
      expect(sqlite.prepare('SELECT number FROM questions').all()).toEqual([{ number: 2 }]);
      const rejected = new Error('injected post-swap verification failure');
      let observed: unknown;
      try { rollbackPreservingError(sqlite, rejected); } catch (error) { observed = error; }
      expect(observed).toBe(rejected);
      expect(sqlite.prepare('SELECT number,text FROM questions').all()).toEqual([{ number: 1, text: 'previous generation' }]);
      expect(sqlite.prepare('SELECT text FROM wq_fts').all()).toEqual([{ text: 'previous generation' }]);
      expect(sqlite.prepare('SELECT source_sha256 FROM wq_materialization_state').get()).toEqual({ source_sha256: 'a'.repeat(64) });
    } finally { sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('preserves the original SQLITE_FULL when SQLite has already rolled back', () => {
    const directory = mkdtempSync(join(tmpdir(), 'written-question-full-'));
    const databasePath = join(directory, 'serving.sqlite');
    const sqlite = openSqlite(databasePath);
    try {
      sqlite.exec("CREATE TABLE served (value TEXT NOT NULL); INSERT INTO served VALUES ('previous'); PRAGMA max_page_count=2;");
      sqlite.exec('BEGIN IMMEDIATE');
      let original: unknown;
      try { sqlite.exec('INSERT INTO served VALUES (randomblob(2000000))'); }
      catch (error) { original = error; }
      expect(original).toBeDefined();
      let observed: unknown;
      try { rollbackPreservingError(sqlite, original); } catch (error) { observed = error; }
      expect(observed).toBe(original);
      expect(sqlite.prepare('SELECT value FROM served').all()).toEqual([{ value: 'previous' }]);
    } finally { sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('rolls back the exact staged FTS swap after verification rejects it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'written-question-swap-'));
    const sqlite = openSqlite(join(directory, 'serving.sqlite'));
    try {
      sqlite.exec(readFileSync(new URL('../preview/written-questions/migrations/0001_written_questions.sql', import.meta.url), 'utf8'));
      sqlite.prepare('INSERT INTO wq_sessions VALUES (?, ?)').run('45-1', '{}');
      sqlite.prepare('INSERT INTO questions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        '45-1', 1, 'en', 'https://www.ourcommons.ca/previous', 'previous generation', 'answered', null, null,
        null, '{}', 'a'.repeat(64), null, 'complete', null, null);
      sqlite.prepare('INSERT INTO wq_fts VALUES (?,?,?,?,?,?)').run('45-1', '1', 'en', '', 0, 'previous generation');
      sqlite.prepare('INSERT INTO wq_materialization_state VALUES (1,?,?,?,?,?,?)')
        .run('a'.repeat(64), 1, 0, 0, 1, 'previous');
      createStage(sqlite);
      sqlite.prepare('INSERT INTO wq_stage_sessions VALUES (?, ?)').run('45-1', '{}');
      sqlite.prepare('INSERT INTO wq_stage_questions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        '45-1', 2, 'en', 'https://www.ourcommons.ca/candidate', 'candidate generation', 'answered', null, null,
        null, '{}', 'b'.repeat(64), null, 'complete', null, null);
      sqlite.prepare('INSERT INTO wq_stage_fts VALUES (?,?,?,?,?,?)').run('45-1', '2', 'en', '', 0, 'candidate generation');
      sqlite.prepare('INSERT INTO wq_stage_materialization_state VALUES (1,?,?,?,?,?,?)')
        .run('b'.repeat(64), 1, 0, 0, 1, 'candidate');

      swapCandidate(sqlite);
      expect(sqlite.prepare('SELECT number FROM questions').all()).toEqual([{ number: 2 }]);
      const rejected = new Error('injected post-swap verification failure');
      let observed: unknown;
      try { rollbackPreservingError(sqlite, rejected); } catch (error) { observed = error; }
      expect(observed).toBe(rejected);
      expect(sqlite.prepare('SELECT number,text FROM questions').all()).toEqual([{ number: 1, text: 'previous generation' }]);
      expect(sqlite.prepare('SELECT text FROM wq_fts').all()).toEqual([{ text: 'previous generation' }]);
      expect(sqlite.prepare('SELECT source_sha256 FROM wq_materialization_state').get())
        .toEqual({ source_sha256: 'a'.repeat(64) });
    } finally { sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('preserves the original SQLITE_FULL when SQLite already rolled back its transaction', () => {
    const directory = mkdtempSync(join(tmpdir(), 'written-question-full-'));
    const sqlite = openSqlite(join(directory, 'serving.sqlite'));
    try {
      sqlite.exec("CREATE TABLE served (value TEXT NOT NULL); INSERT INTO served VALUES ('previous'); PRAGMA max_page_count=2;");
      sqlite.exec('BEGIN IMMEDIATE');
      let original: unknown;
      try { sqlite.exec('INSERT INTO served VALUES (randomblob(2000000))'); } catch (error) { original = error; }
      expect(original).toBeDefined();
      let observed: unknown;
      try { rollbackPreservingError(sqlite, original); } catch (error) { observed = error; }
      expect(observed).toBe(original);
      expect(sqlite.prepare('SELECT value FROM served').all()).toEqual([{ value: 'previous' }]);
    } finally { sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps every character in bounded display chunks and overlaps search boundaries', () => {
    const source = `${'alpha 😀 '.repeat(1400)}Unique token at late page. ${'omega 😀 '.repeat(1600)}`;
    const chunks = [...splitWrittenQuestionText(source)];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => [...chunk.text].length <= 8192 && [...chunk.searchText].length <= 8256)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(source);
    expect(chunks.some((chunk) => chunk.searchText.includes('Unique token at late page.'))).toBe(true);
  });
});
