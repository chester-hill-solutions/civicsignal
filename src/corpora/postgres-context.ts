/**
 * The corpus context, on Postgres.
 *
 * The Worker builds its context from bindings — D1 for the rows, a Vectorize
 * binding for the vectors, a service binding for the encoder. The Bun service
 * builds the same context from a pool, a pgvector table, and the encoder's
 * address. The adapters above do not know the difference, because the context is
 * the only thing that names a store.
 *
 * That is the whole point of the seam: the corpus package's interfaces are
 * small, and the port is the wiring, not the retrieval.
 */
import postgres from 'postgres';
import type { CorpusContext } from './types';
import type { SqlRunner } from '@chester-hill-solutions/api-billing/postgres';
import { postgresCorpusDatabase } from './postgres-driver';
import { postgresVectorIndex } from './postgres-vector';

/**
 * postgres.js's `sql` is a thenable query builder, not a `Promise`.
 *
 * The house's `SqlRunner` wants a promise, so this is the one place the two
 * shapes meet.
 */
export function sqlRunner(sql: postgres.Sql | postgres.TransactionSql): SqlRunner {
  return {
    unsafe(query: string, params?: unknown[]): Promise<unknown[]> {
      return Promise.resolve(sql.unsafe(query, params as postgres.SerializableParameter[]));
    },
    ...('begin' in sql ? { async transaction<T>(work: (transaction: SqlRunner) => Promise<T>): Promise<T> {
      return await sql.begin((transaction) => work(sqlRunner(transaction))) as T;
    } } : {}),
  };
}

export interface PostgresCorpusContextOptions {
  /** The connection string for the corpus database. */
  databaseUrl: string;
  /** The encoder's address, e.g. `http://encoder:8080`. */
  encoderUrl?: string;
  /** The encoder's bearer token. */
  encoderToken?: string;
  /** How many connections the pool holds. */
  max?: number;
}

/**
 * The embedder for a question, in the corpus's vector space.
 *
 * The corpus is embedded with **EmbeddingGemma 2**, served from the `.litertlm`
 * artefact — the same file the browser runs — so a question is embedded by that
 * same service, and the two are in the same space by construction rather than
 * approximately.
 */
function queryEmbedder(url: string, token: string): (text: string) => Promise<number[]> {
  return async (text: string) => {
    const response = await fetch(`${url.replace(/\/$/, '')}/embed-query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ texts: [text] }),
    });
    if (!response.ok) {
      throw new Error(`the encoder refused ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const body = (await response.json()) as { vectors?: number[][] };
    const vector = body.vectors?.[0];
    if (!vector) throw new Error('the encoder returned no vector');
    return vector;
  };
}

/**
 * The context, and the pool behind it.
 *
 * The pool is returned because the service owns its lifecycle: one pool for the
 * life of the process, closed on the way out.
 */
export function postgresCorpusContext(
  options: PostgresCorpusContextOptions,
): { context: CorpusContext; sql: postgres.Sql } {
  const sql = postgres(options.databaseUrl, {
    max: options.max ?? 4,
    // The vectors are large; a transaction that carries a few of them is fine,
    // but the idle timeout has to outlast a slow embedding round trip.
    idle_timeout: 30,
    connect_timeout: 15,
  });
  const runner = sqlRunner(sql);

  return {
    sql,
    context: {
      db: postgresCorpusDatabase(runner),
      vector: postgresVectorIndex(runner),
      fetch,
      now: () => new Date(),
      ...(options.encoderUrl && options.encoderToken
        ? { embedQuery: queryEmbedder(options.encoderUrl, options.encoderToken) }
        : {}),
    },
  };
}
