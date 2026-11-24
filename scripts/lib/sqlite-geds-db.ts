import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GedsDatabase, GedsSqlValue, GedsStatement } from '../../src/geds/db';

/**
 * `bun:sqlite` wearing D1's coat.
 *
 * The import script and the API tests run the same SQL against the same
 * migrations as the Worker; only the transport differs. This adapter is the
 * transport. It is deliberately outside `src/` so the Worker bundle never sees
 * a runtime-only import.
 */

type BunDatabase = InstanceType<typeof Database>;

class SqliteStatement implements GedsStatement {
  constructor(
    private db: BunDatabase,
    private sql: string,
    private params: GedsSqlValue[] = [],
  ) {}

  bind(...values: GedsSqlValue[]): GedsStatement {
    this.params = values;
    return this;
  }

  private sqliteParams(): (string | number | null | Uint8Array)[] {
    return this.params.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value));
  }

  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.sqliteParams());
    return (row as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.sqliteParams()) as T[] };
  }

  async run(): Promise<{ meta?: { changes?: number; last_row_id?: number } }> {
    const result = this.db.prepare(this.sql).run(...this.sqliteParams());
    return {
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

export class SqliteGedsDatabase implements GedsDatabase {
  constructor(private db: BunDatabase) {}

  prepare(sql: string): GedsStatement {
    return new SqliteStatement(this.db, sql);
  }

  async batch(statements: GedsStatement[]): Promise<unknown[]> {
    this.db.exec('BEGIN');
    try {
      const out: unknown[] = [];
      for (const statement of statements) out.push(await statement.run());
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }
}

export function openSqliteGedsDatabase(path: string): {
  db: SqliteGedsDatabase;
  raw: BunDatabase;
} {
  const raw = new Database(path, { create: true });
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA synchronous = NORMAL');
  raw.exec('PRAGMA foreign_keys = OFF');
  return { db: new SqliteGedsDatabase(raw), raw };
}

export function applyGedsMigrations(raw: BunDatabase, migrationsDir: string): string[] {
  raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (raw.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name),
  );
  const file = '0010_geds.sql';
  raw.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  const fresh: string[] = [];
  if (!applied.has(file)) {
    raw.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
      file,
      new Date().toISOString(),
    );
    fresh.push(file);
  }
  return fresh;
}
