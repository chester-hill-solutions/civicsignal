import { createRequire } from 'node:module';
import type { SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MemoryArchive } from '../../src/geds/archive';
import { refreshGeds } from '../../src/geds/refresh';
import type { GedsRefreshSummary } from '../../src/geds/types';
import type { GedsDatabase, GedsSqlValue, GedsStatement } from '../../src/geds/db';

/**
 * The database the GEDS tests run against: the real migrations, in memory.
 *
 * The API and the importer share the SQL. If a test used a fake repository
 * instead, it would prove the handlers call a function, not that the query is
 * right.
 */

const ROOT = new URL('../..', import.meta.url).pathname;
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof import('node:sqlite').DatabaseSync };

export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected a value in the GEDS fixture.');
  return value;
}

type RawDatabase = InstanceType<typeof DatabaseSync>;
class NodeStatement implements GedsStatement {
  private values: GedsSqlValue[] = [];
  constructor(private readonly db: RawDatabase, private readonly sql: string) {}
  bind(...values: GedsSqlValue[]): GedsStatement { this.values = values; return this; }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.values as SQLInputValue[]) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.values as SQLInputValue[]) as T[] };
  }
  async run() {
    const result = this.db.prepare(this.sql).run(...this.values as SQLInputValue[]);
    return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class NodeGedsDatabase implements GedsDatabase {
  constructor(private readonly raw: RawDatabase) {}
  prepare(sql: string): GedsStatement { return new NodeStatement(this.raw, sql); }
  exec(sql: string): void { this.raw.exec(sql); }
}

export function gedsDatabase(options: { includeGedsMigration?: boolean } = {}): { db: GedsDatabase; raw: RawDatabase; archive: MemoryArchive } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = OFF');
  for (const file of readdirSync(resolve(ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(resolve(ROOT, 'migrations', file), 'utf8'));
  }
  if (options.includeGedsMigration !== false) {
    raw.exec(readFileSync(resolve(ROOT, 'preview/geds/migrations/0010_geds.sql'), 'utf8'));
  }
  return { db: new NodeGedsDatabase(raw), raw, archive: new MemoryArchive() };
}

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(ROOT, 'test/fixtures/geds', name)));
}

export async function refreshFixture(
  db: GedsDatabase,
  archive: MemoryArchive,
  name: string,
  observedAt: string,
): Promise<GedsRefreshSummary> {
  return refreshGeds({
    db,
    archive,
    now: new Date(observedAt),
    csvBytes: fixtureBytes(name),
    originalFormat: 'csv',
    originalName: name,
    sourceDate: '2026-01-01T00:00:00.000Z',
    sourceUrl: 'https://api.geds-sage.gc.ca/GEDS20/dist/opendata/gedsOpenData.zip',
    resume: true,
  });
}
