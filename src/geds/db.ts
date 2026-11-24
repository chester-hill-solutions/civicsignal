/**
 * The small database surface the GEDS code needs.
 *
 * It is deliberately narrower than D1 so the same refresh engine can run
 * against the real `CIVIC_DB` binding, against local D1 through `cf`, and
 * against `node:sqlite` in the import script and the tests. The SQL is SQLite
 * either way; the adapter changes, the semantics do not.
 */

export type GedsSqlValue = string | number | null | ArrayBuffer | Uint8Array;

export interface GedsStatement {
  bind(...values: GedsSqlValue[]): GedsStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { changes?: number; last_row_id?: number } }>;
}

export interface GedsDatabase {
  prepare(sql: string): GedsStatement;
  batch?(statements: GedsStatement[]): Promise<unknown[]>;
  /** Local SQLite uses this for `BEGIN`/`COMMIT`; D1 does not expose it. */
  exec?(sql: string): void;
}

/** D1 satisfies this shape already; this is the compile-time bridge. */
export type GedsD1 = GedsDatabase;

export async function firstValue<T>(
  db: GedsDatabase,
  sql: string,
  ...values: GedsSqlValue[]
): Promise<T | null> {
  return db.prepare(sql).bind(...values).first<T>();
}

export async function allValues<T>(
  db: GedsDatabase,
  sql: string,
  ...values: GedsSqlValue[]
): Promise<T[]> {
  const result = await db.prepare(sql).bind(...values).all<T>();
  return result.results ?? [];
}

export async function run(
  db: GedsDatabase,
  sql: string,
  ...values: GedsSqlValue[]
): Promise<{ changes: number; lastRowId?: number }> {
  const result = await db.prepare(sql).bind(...values).run();
  return { changes: result.meta?.changes ?? 0, lastRowId: result.meta?.last_row_id };
}
