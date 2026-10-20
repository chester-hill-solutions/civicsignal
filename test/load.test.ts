import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRows, parseStatuteXml, toInsertStatements, type StatuteSectionRow } from '../src/ingest/statutes';

/**
 * The load path.
 *
 * This test exists because the SQL the ingest generates **did not run**. The
 * `VALUES` clause was missing its opening parenthesis, so every statement was a
 * syntax error, and the corpus had never been loaded into a database — which
 * is why nothing noticed for so long.
 *
 * The failure was invisible to every other test, because every other test
 * looked at the *shape* of the output rather than executing it. A test that
 * asserts a string contains an id proves the string mentions the id. A test
 * that runs the statement proves the corpus loads.
 *
 * So this one runs the SQL. Bun ships SQLite, the D1 plane is SQLite, and the
 * schema in `migrations/` is the schema the corpus is loaded into — so the
 * statements are executed against the real table definition rather than
 * against an assumption about it.
 */

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * SQLite, loaded at runtime.
 *
 * `node:sqlite` is a built-in, but Vite's resolver does not know it and tries
 * to load it as a package named "sqlite". A `require` at runtime sidesteps the
 * resolver entirely.
 */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
  };
};

/**
 * A database with the real D1 schema in it.
 *
 * Every migration, in order — because the load has to work against the schema
 * the database actually has, not against the first one. The citation column
 * arrives in the second migration, and a load that names it before it exists
 * fails.
 */
function corpusDatabase(): InstanceType<typeof DatabaseSync> {
  const db = new DatabaseSync(':memory:');
  const dir = join(ROOT, 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    db.exec(readFileSync(join(dir, file), 'utf8'));
  }
  return db;
}

/** One row, built the way the ingest builds it. */
function aRow(overrides: Partial<StatuteSectionRow> = {}): StatuteSectionRow {
  return {
    id: 'acts-en-c-34-36',
    corpus_id: 'statutes-canada',
    act: 'Competition Act',
    citation: 'C-34',
    section: '36',
    status: 'in-force',
    schedule: null,
    part: null,
    heading: 'Recovery of damages',
    text: "(1) Any person who has suffered loss or damage as a result of conduct contrary to Part VI…",
    source_url: 'https://laws-lois.justice.gc.ca/en/acts/C-34/section-36.html',
    jurisdiction: 'CA',
    in_force: 1,
    language: 'en',
    topics: null,
    search_text: 'competition act s. 36 recovery of damages any person who has suffered',
    ...overrides,
  } as StatuteSectionRow;
}

describe('the load path', () => {
  it('generates SQL that runs', () => {
    const db = corpusDatabase();
    const statements = toInsertStatements([aRow()]);
    expect(() => {
      for (const statement of statements) db.exec(statement);
    }).not.toThrow();
  });

  it('puts the row in the table, with its text', () => {
    const db = corpusDatabase();
    for (const statement of toInsertStatements([aRow()])) db.exec(statement);
    const row = db
      .prepare('SELECT id, act, citation, section, status, language, in_force, text FROM statute_sections')
      .get() as Record<string, unknown>;
    expect(row['id']).toBe('acts-en-c-34-36');
    expect(row['act']).toBe('Competition Act');
    expect(row['citation']).toBe('C-34');
    expect(row['language']).toBe('en');
    expect(row['in_force']).toBe(1);
    expect(String(row['text'])).toContain('suffered loss or damage');
  });

  it('loads a batch in one statement', () => {
    const db = corpusDatabase();
    const rows = [
      aRow({ id: 'acts-en-a-1' }),
      aRow({ id: 'acts-en-a-2', section: '2' }),
      aRow({ id: 'acts-fr-a-1', language: 'fr', act: 'Loi sur la concurrence' }),
    ];
    const statements = toInsertStatements(rows, 10);
    expect(statements).toHaveLength(1);
    db.exec(statements[0]!);
    const count = db.prepare('SELECT COUNT(*) AS n FROM statute_sections').get() as { n: number };
    expect(count.n).toBe(3);
  });

  /**
   * The two official versions of a provision are separate rows, and the id is
   * what keeps them apart. A load that collapsed them would leave the corpus
   * with half its content and no error.
   */
  it('keeps the two languages apart', () => {
    const db = corpusDatabase();
    const rows = [
      aRow({ id: 'acts-en-c-34-36' }),
      aRow({ id: 'acts-fr-c-34-36', language: 'fr', act: 'Loi sur la concurrence' }),
    ];
    for (const statement of toInsertStatements(rows, 10)) db.exec(statement);
    const languages = db
      .prepare('SELECT language FROM statute_sections ORDER BY language')
      .all() as { language: string }[];
    expect(languages.map((r) => r.language)).toEqual(['en', 'fr']);
  });

  /**
   * A provision's text is arbitrary text: apostrophes, quotes, newlines, and
   * the occasional semicolon. A loader that cannot escape them loses the row
   * or, worse, the statement.
   */
  it('survives the punctuation that legal text is full of', () => {
    const db = corpusDatabase();
    const nasty = aRow({
      id: 'acts-en-nasty-1',
      text: "It's O'Brien's \"law\"; and (1) a newline\nin the middle — with a — dash.",
      search_text: "it's o'brien's \"law\"; and (1) a newline in the middle — with a — dash.",
    });
    for (const statement of toInsertStatements([nasty])) db.exec(statement);
    const row = db.prepare('SELECT text FROM statute_sections WHERE id = ?').get('acts-en-nasty-1') as
      | { text: string }
      | null;
    expect(row?.text).toBe(nasty.text);
  });

  it('replaces a row rather than duplicating it', () => {
    const db = corpusDatabase();
    for (const statement of toInsertStatements([aRow()])) db.exec(statement);
    for (const statement of toInsertStatements([aRow({ heading: 'A new heading' })])) db.exec(statement);
    const rows = db.prepare('SELECT heading FROM statute_sections').all() as { heading: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.heading).toBe('A new heading');
  });
});
