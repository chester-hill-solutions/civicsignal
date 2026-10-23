import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

/** Local-only SQLite boundary for exercising the same bound D1 statements. */
export function localD1(sqlite: DatabaseSync): D1Database {
  const meta = { changed_db: false, changes: 0, duration: 0, last_row_id: 0,
    rows_read: 0, rows_written: 0, size_after: 0 };
  class Statement {
    constructor(readonly query: string, readonly params: SQLInputValue[] = []) {}
    bind(...params: SQLInputValue[]) { return new Statement(this.query, params); }
    async all() { return { success: true, results: sqlite.prepare(this.query).all(...this.params), meta }; }
    async raw() { return (await this.all()).results.map((row) => Object.values(row)); }
    async first(column?: string) {
      const row = sqlite.prepare(this.query).get(...this.params);
      return row ? column ? row[column] : row : null;
    }
    async run() {
      const result = sqlite.prepare(this.query).run(...this.params);
      return { success: true, results: [], meta: { ...meta, changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
  }
  const adapter = {
    prepare(query: string) { return new Statement(query); },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    async exec(query: string) { sqlite.exec(query); return { count: 1, duration: 0 }; },
  };
  // D1's session/dump APIs are not used by the local corpus/billing callers.
  return adapter as unknown as D1Database;
}
