/**
 * The corpus database's schema.
 *
 * The pipeline applies it on start, because the pipeline is the thing that owns
 * the corpus database and a service that cannot reach its own schema is a
 * service that cannot run.
 *
 * Two statements come first, and both are things only the database's owner can
 * do:
 *
 * - **`CREATE EXTENSION IF NOT EXISTS vector`.** The pgvector image ships the
 *   library, but the extension has to be created in the database, and without
 *   it the `vector` column type does not exist.
 * The extension is a privilege operation, and the pipeline's connection is the
 * database's owner, so it can do it. Where it cannot, the statement fails and
 * the schema does not apply — and the failure says so, rather than leaving a
 * half-created table behind.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

/**
 * Apply the corpus schema.
 *
 * Idempotent: every statement in it is `IF NOT EXISTS`, so running it on every
 * start is free and means a deployment that changed the schema does not need a
 * human to remember to migrate.
 */
export async function ensureCorpusSchema(
  connectionString: string,
  options: { migrationsDir?: string } = {},
): Promise<void> {
  const sql = postgres(connectionString, { max: 1, connect_timeout: 15, idle_timeout: 10 });
  try {
    // The extension first: the schema's `vector(768)` column needs it to exist.
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');

    const dir = options.migrationsDir ?? join(import.meta.dirname, 'migrations');
    const file = join(dir, '0001_corpus.sql');
    const statements = readFileSync(file, 'utf8');
    // postgres.js can run a whole script with `unsafe` when it has no
    // parameters, and the schema is a script of `CREATE ... IF NOT EXISTS`.
    await sql.unsafe(statements);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
