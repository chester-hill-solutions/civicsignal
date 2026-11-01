import type { SQLInputValue } from 'node:sqlite';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type { CorpusContext } from '../../src/corpora/types';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** Execute read helpers against SQLite using the production schema, without a remote D1 binding. */
export function sqliteCorpus() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../migrations/0001_init.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../../migrations/0002_statute_citation_columns.sql', import.meta.url), 'utf8'));
  const migration = readFileSync(new URL('../../migrations/0003_pipeline.sql', import.meta.url), 'utf8');
  sqlite.exec(migration);
  sqlite.exec(readFileSync(new URL('../../migrations/0008_corpus_parser.sql', import.meta.url), 'utf8'));
  const statements: string[] = [];
  const db: CorpusContext['db'] = {
    prepare(sql: string) {
      statements.push(sql);
      return {
        bind(...values: unknown[]) {
          return { async all<T>() { return { results: sqlite.prepare(sql).all(...values as SQLInputValue[]) as T[] }; } };
        },
      };
    },
  };
  return { sqlite, db, statements, close: () => sqlite.close() };
}
