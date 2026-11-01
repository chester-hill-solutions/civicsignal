import { createRequire } from 'node:module';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof SqliteDatabase };
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { localD1 } from '../../scripts/lib/local-d1';

/** Execute production SQL against SQLite; D1's wire methods form the adapter. */
export function testD1(options: { schema?: string } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  if (options.schema !== undefined) sqlite.exec(options.schema);
  else {
    const migrations = resolve('migrations');
    for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
      sqlite.exec(readFileSync(resolve(migrations, file), 'utf8'));
    }
  }
  return { db: localD1(sqlite), sqlite, close: () => sqlite.close() };
}
