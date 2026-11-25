import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256File } from '../scripts/lib/file-integrity';
import { localD1 } from '../scripts/lib/local-d1';
import { runWrittenQuestionRequest } from '../src/routes/written-questions';
import { createStage, ftsTablesEqual, openSqlite, rollbackPreservingError, splitWrittenQuestionText,
  StagedFtsWriter, swapCandidate } from '../scripts/materialize-written-questions';

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

      expect(swapCandidate(sqlite)).toBe(false);
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

  it('retains an exactly equal FTS index, checks its integrity and serves a real search', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'written-question-fts-reuse-'));
    const sqlite = openSqlite(join(directory, 'serving.sqlite'));
    try {
      sqlite.exec(readFileSync(new URL('../preview/written-questions/migrations/0001_written_questions.sql', import.meta.url), 'utf8'));
      sqlite.prepare('INSERT INTO wq_sessions VALUES (?, ?)').run('45-1', '{}');
      sqlite.prepare('INSERT INTO questions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        '45-1', 1, 'en', 'https://www.ourcommons.ca/question/1', 'drinking water advisories', 'answered', null, null,
        null, '{}', 'a'.repeat(64), null, 'complete', null, null);
      sqlite.prepare('INSERT INTO wq_fts VALUES (?,?,?,?,?,?)').run('45-1', '1', 'en', '', 0, 'drinking water advisories');
      sqlite.prepare('INSERT INTO wq_materialization_state VALUES (1,?,?,?,?,?,?)')
        .run('a'.repeat(64), 1, 0, 0, 1, 'previous');
      createStage(sqlite);
      sqlite.prepare('INSERT INTO wq_stage_sessions VALUES (?, ?)').run('45-1', '{}');
      sqlite.prepare('INSERT INTO wq_stage_questions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        '45-1', 1, 'en', 'https://www.ourcommons.ca/question/1', 'drinking water advisories', 'answered', null, 'Updated member',
        null, '{}', 'b'.repeat(64), null, 'complete', null, null);
      sqlite.prepare('INSERT INTO wq_stage_fts VALUES (?,?,?,?,?,?)').run('45-1', '1', 'en', '', 0, 'drinking water advisories');
      sqlite.prepare('INSERT INTO wq_stage_materialization_state VALUES (1,?,?,?,?,?,?)')
        .run('b'.repeat(64), 1, 0, 0, 1, 'candidate');

      const before = sqlite.prepare('SELECT rowid,session,number,language,doc_key,chunk_index,text FROM wq_fts ORDER BY rowid').all();
      expect(ftsTablesEqual(sqlite)).toBe(true);
      expect(swapCandidate(sqlite)).toBe(true);
      const after = sqlite.prepare('SELECT rowid,session,number,language,doc_key,chunk_index,text FROM wq_fts ORDER BY rowid').all();
      expect(after).toEqual(before);
      sqlite.exec('COMMIT');

      const result = await runWrittenQuestionRequest(localD1(sqlite), {
        operation: 'search', query: { query: 'drinking water advisories', language: 'en', session: '45-1', limit: 10 },
      });
      expect('items' in result && result.items.some((item) => item.number === 1 && item.kind === 'question')).toBe(true);
      expect(sqlite.prepare('SELECT source_sha256 FROM wq_materialization_state').get())
        .toEqual({ source_sha256: 'b'.repeat(64) });
    } finally { sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('fills a cold stage and retains identical deterministic FTS rowids without rewriting them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'written-question-stage-fts-'));
    const sqlite = openSqlite(join(directory, 'stage.sqlite'));
    const rows = [
      ['45-1', '1', 'en', '', 0, 'first question text'],
      ['45-1', '1', 'en', 'reply-1', 0, 'first reply text'],
      ['45-1', '2', 'fr', '', 0, 'deuxième question'],
    ] as const;
    try {
      sqlite.exec('CREATE VIRTUAL TABLE wq_stage_fts USING fts5(session UNINDEXED,number UNINDEXED,language UNINDEXED,doc_key UNINDEXED,chunk_index UNINDEXED,text)');
      sqlite.exec('BEGIN IMMEDIATE');
      const cold = new StagedFtsWriter(sqlite);
      for (const row of rows) cold.add(row);
      expect(cold.finish()).toEqual({ retained: 0, inserted: 3, replaced: 0, removed: 0 });
      sqlite.exec('COMMIT');
      const baseline = sqlite.prepare('SELECT rowid,session,number,language,doc_key,chunk_index,text FROM wq_stage_fts ORDER BY rowid').all();

      sqlite.exec('BEGIN IMMEDIATE');
      const repeat = new StagedFtsWriter(sqlite);
      for (const row of rows) repeat.add(row);
      expect(repeat.finish()).toEqual({ retained: 3, inserted: 0, replaced: 0, removed: 0 });
      sqlite.exec("INSERT INTO wq_stage_fts(wq_stage_fts) VALUES ('integrity-check')");
      sqlite.exec('COMMIT');
      expect(sqlite.prepare('SELECT rowid,session,number,language,doc_key,chunk_index,text FROM wq_stage_fts ORDER BY rowid').all())
        .toEqual(baseline);
    } finally { sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('replaces changed or reordered staged FTS rows and removes the surplus tail', () => {
    const directory = mkdtempSync(join(tmpdir(), 'written-question-stage-fts-'));
    const sqlite = openSqlite(join(directory, 'stage.sqlite'));
    try {
      sqlite.exec('CREATE VIRTUAL TABLE wq_stage_fts USING fts5(session UNINDEXED,number UNINDEXED,language UNINDEXED,doc_key UNINDEXED,chunk_index UNINDEXED,text)');
      sqlite.exec("INSERT INTO wq_stage_fts VALUES ('45-1','1','en','','0','alpha old'); INSERT INTO wq_stage_fts VALUES ('45-1','2','en','','0','beta old'); INSERT INTO wq_stage_fts VALUES ('45-1','3','fr','','0','gamma old')");
      sqlite.exec('BEGIN IMMEDIATE');
      const writer = new StagedFtsWriter(sqlite);
      writer.add(['45-1', '2', 'en', '', 0, 'beta new']);
      writer.add(['45-1', '1', 'en', '', 0, 'alpha old']);
      expect(writer.finish()).toEqual({ retained: 0, inserted: 0, replaced: 2, removed: 1 });
      sqlite.exec("INSERT INTO wq_stage_fts(wq_stage_fts) VALUES ('integrity-check')");
      expect(sqlite.prepare('SELECT rowid,number,text FROM wq_stage_fts ORDER BY rowid').all()).toEqual([
        { rowid: 1, number: '2', text: 'beta new' }, { rowid: 2, number: '1', text: 'alpha old' },
      ]);
      expect(sqlite.prepare("SELECT number FROM wq_stage_fts WHERE wq_stage_fts MATCH 'beta new'").all())
        .toEqual([{ number: '2' }]);
      expect(sqlite.prepare('SELECT typeof(chunk_index) AS type FROM wq_stage_fts WHERE rowid=1').get())
        .toEqual({ type: 'real' });
      sqlite.exec('COMMIT');
    } finally { sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('rolls back staged FTS row changes atomically after a rejected import', () => {
    const directory = mkdtempSync(join(tmpdir(), 'written-question-stage-fts-'));
    const sqlite = openSqlite(join(directory, 'stage.sqlite'));
    try {
      sqlite.exec("CREATE VIRTUAL TABLE wq_stage_fts USING fts5(session UNINDEXED,number UNINDEXED,language UNINDEXED,doc_key UNINDEXED,chunk_index UNINDEXED,text); INSERT INTO wq_stage_fts VALUES ('45-1','1','en','','0','previous text')");
      sqlite.exec('BEGIN IMMEDIATE');
      const writer = new StagedFtsWriter(sqlite);
      writer.add(['45-1', '1', 'en', '', 0, 'candidate text']);
      writer.finish();
      const rejected = new Error('injected staged import rejection');
      let observed: unknown;
      try { rollbackPreservingError(sqlite, rejected); } catch (error) { observed = error; }
      expect(observed).toBe(rejected);
      expect(sqlite.prepare('SELECT rowid,number,text FROM wq_stage_fts').all())
        .toEqual([{ rowid: 1, number: '1', text: 'previous text' }]);
    } finally { sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('repairs text-typed staged chunk indexes before serving document search results', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'written-question-stage-types-'));
    const sqlite = openSqlite(join(directory, 'serving.sqlite'));
    try {
      sqlite.exec(readFileSync(new URL('../preview/written-questions/migrations/0001_written_questions.sql', import.meta.url), 'utf8'));
      sqlite.prepare('INSERT INTO wq_sessions VALUES (?, ?)').run('45-1', '{}');
      createStage(sqlite);
      sqlite.prepare(`INSERT INTO wq_stage_sessions VALUES (?, ?)`).run('45-1', '{}');
      sqlite.prepare(`INSERT INTO wq_stage_questions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        '45-1', 1010, 'en', 'https://www.ourcommons.ca/question/1010', 'question text', 'answered', null, null,
        null, '{}', 'a'.repeat(64), null, 'complete', null, null);
      sqlite.prepare(`INSERT INTO wq_stage_documents
        (session,number,language,doc_key,kind,respondent,title,url,text,text_chars,chunk_count,object_sha256,availability,metadata_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        '45-1', 1010, 'en', 'reply-1010', 'reply', 'Minister', 'Reply',
        'https://www.ourcommons.ca/reply/1010', 'harbor drinking water advisories', 32, 1, null, 'searchable', '{}');
      sqlite.prepare(`INSERT INTO wq_stage_document_chunks
        (session,number,language,doc_key,chunk_index,text,search_text) VALUES (?,?,?,?,?,?,?)`).run(
        '45-1', 1010, 'en', 'reply-1010', 0, 'harbor drinking water advisories', 'harbor drinking water advisories');
      sqlite.prepare('INSERT INTO wq_stage_materialization_state VALUES (1,?,?,?,?,?,?)')
        .run('b'.repeat(64), 1, 1, 1, 2, 'candidate');
      sqlite.prepare(`INSERT INTO wq_stage_fts VALUES (?,?,?,?,?,?)`).run('45-1', '1010', 'en', '', 0, 'question text');
      sqlite.prepare(`INSERT INTO wq_stage_fts VALUES (?,?,?,?,?,?)`).run('45-1', '1010', 'en', 'reply-1010', '0', 'harbor drinking water advisories');

      sqlite.exec('BEGIN IMMEDIATE');
      const writer = new StagedFtsWriter(sqlite);
      writer.add(['45-1', '1010', 'en', '', 0, 'question text']);
      writer.add(['45-1', '1010', 'en', 'reply-1010', 0, 'harbor drinking water advisories']);
      expect(writer.finish()).toEqual({ retained: 1, inserted: 0, replaced: 1, removed: 0 });
      expect(sqlite.prepare("SELECT typeof(chunk_index) AS type FROM wq_stage_fts WHERE doc_key='reply-1010'").get())
        .toEqual({ type: 'real' });
      sqlite.exec('COMMIT');

      swapCandidate(sqlite);
      sqlite.exec('COMMIT');
      const result = await runWrittenQuestionRequest(localD1(sqlite), {
        operation: 'search', query: { query: 'harbor drinking', language: 'en', session: '45-1', kind: 'reply', limit: 10 },
      });
      expect('items' in result).toBe(true);
      if ('items' in result) {
        expect(result.items).toHaveLength(1);
        expect(result.items[0]?.chunkIndex).toBe(0);
      }
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

  it('keeps every character in bounded display chunks and overlaps search boundaries', () => {
    const source = `${'alpha 😀 '.repeat(1400)}Unique token at late page. ${'omega 😀 '.repeat(1600)}`;
    const chunks = [...splitWrittenQuestionText(source)];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => [...chunk.text].length <= 8192 && [...chunk.searchText].length <= 8256)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(source);
    expect(chunks.some((chunk) => chunk.searchText.includes('Unique token at late page.'))).toBe(true);
  });
});
