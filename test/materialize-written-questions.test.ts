import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite, splitWrittenQuestionText } from '../scripts/materialize-written-questions';

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

  it('keeps every character in bounded display chunks and overlaps search boundaries', () => {
    const source = `${'alpha 😀 '.repeat(1400)}Unique token at late page. ${'omega 😀 '.repeat(1600)}`;
    const chunks = [...splitWrittenQuestionText(source)];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => [...chunk.text].length <= 8192 && [...chunk.searchText].length <= 8256)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(source);
    expect(chunks.some((chunk) => chunk.searchText.includes('Unique token at late page.'))).toBe(true);
  });
});
