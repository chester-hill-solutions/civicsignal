/**
 * The vector index, on Postgres.
 *
 * The other half of the port's corpus side: the driver made the *rows* portable,
 * and this makes the *vectors* portable. The interface is the same one the
 * Vectorize index implements — `query(vector, topK, filter)` — so the adapter
 * that calls it does not know which store it is talking to.
 *
 * ## The score
 *
 * pgvector's `<=>` is the **cosine distance**, so the similarity is
 * `1 - distance`. The Vectorize arm's score is the cosine similarity itself, so
 * this has to be converted rather than passed through: a score of 0.17 means
 * "0.83 similar" in one store and "0.17 similar" in the other, and the adapter
 * that ranks on it would silently prefer the *worst* matches.
 *
 * ## The filter
 *
 * The metadata equality constraints become equality constraints on the row's
 * columns. The language lens is the one that matters — the two official
 * versions of a provision are separate rows, and a French question must not have
 * to compete with the English rows for a place in the top k.
 *
 * ## One runner
 *
 * The runner is the house's `SqlRunner` — the same one the billing package's
 * Postgres ledger takes — so one pool serves the rows, the vectors and the
 * usage counters, and the port does not grow a second shape for the same
 * database.
 */
import type { SqlRunner } from '@chester-hill-solutions/api-billing/postgres';
import type { VectorIndex, VectorMatch } from '@chester-hill-solutions/corpus';

/**
 * The metadata a filter may constrain.
 *
 * Every one of these is a column on the row, so the filter is an equality
 * constraint on the same row the vector belongs to — which is the point of
 * having the vectors and the rows in one table.
 *
 * The set is fixed rather than taken from the caller, because the metadata is
 * caller-controlled in principle and a key that is not a column is not a
 * predicate. An unknown key is ignored rather than interpolated into the SQL.
 */
const FILTERABLE = new Set(['language', 'jurisdiction', 'status']);

export interface PostgresVectorIndexOptions {
  /** The table the vectors live in. */
  table?: string;
  /** The column the vectors live in. */
  column?: string;
}

/** The vector as pgvector takes it: a bracketed list of numbers. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

export function postgresVectorIndex(
  sql: SqlRunner,
  options: PostgresVectorIndexOptions = {},
): VectorIndex {
  const table = options.table ?? 'statute_provisions';
  const column = options.column ?? 'embedding';

  return {
    async query(
      vector: number[],
      topK: number,
      filter?: Record<string, string>,
    ): Promise<VectorMatch[]> {
      const clauses: string[] = [];
      const binds: unknown[] = [toVectorLiteral(vector)];

      for (const [key, value] of Object.entries(filter ?? {})) {
        if (!FILTERABLE.has(key)) continue;
        binds.push(value);
        clauses.push(`${key} = $${binds.length}`);
      }

      binds.push(topK);
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = `$${binds.length}`;

      const rows = (await sql.unsafe(
        `SELECT id, 1 - (${column} <=> $1) AS score
           FROM ${table}
           ${where}
          ORDER BY ${column} <=> $1
          LIMIT ${limit}`,
        binds,
      )) as { id: string; score: number }[];

      return rows.map((row) => ({
        id: String(row.id),
        score: Number(row.score),
        metadata: { ...(filter ?? {}) },
      }));
    },
  };
}
