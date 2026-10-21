/**
 * The corpus database, on Postgres.
 *
 * The corpus package's interface is deliberately small — `prepare(sql)` and
 * `bind(...).all()` — and it is the *D1* shape, because D1 was the first
 * store. This is the Postgres implementation of the same interface, so the
 * adapters do not know which one they are talking to.
 *
 * Two things are different and both are here:
 *
 * - **The placeholders.** D1's statements are written with `?`; Postgres's are
 *   written with `$1`. Rather than rewrite every query, the `?` are translated on
 *   the way out. The translation is the kind of thing that is trivial to get
 *   right and easy to get wrong — a `?` inside a string literal, say — so it is a
 *   function with a test of its own.
 * - **The runner.** It is the house's `SqlRunner`, the same one the billing
 *   package's Postgres ledger takes, so one pool serves the rows, the vectors and
 *   the usage counters.
 */
import type { SqlRunner } from '@chester-hill-solutions/api-billing/postgres';
import type { CorpusDatabase, CorpusStatement } from '@chester-hill-solutions/corpus';

/**
 * Rewrite `?` placeholders as Postgres's `$1`.
 *
 * A `?` inside a single-quoted string is not a placeholder, and one inside a
 * double-quoted identifier is not either. Only a `?` that is outside a quoted
 * run is one.
 */
export function toPostgresPlaceholders(sql: string): string {
  let out = '';
  let index = 0;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!;
    if (quote) {
      out += char;
      // A doubled quote inside a quoted run is an escaped quote, not the end.
      if (char === quote) {
        if (sql[i + 1] === quote) {
          out += quote;
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      continue;
    }
    if (char === '?') {
      index++;
      out += `$${index}`;
      continue;
    }
    out += char;
  }
  return out;
}

/** A `CorpusDatabase` over a Postgres connection. */
export function postgresCorpusDatabase(sql: SqlRunner): CorpusDatabase {
  return {
    prepare(statement: string): CorpusStatement {
      const query = toPostgresPlaceholders(statement);
      return {
        bind(...values: unknown[]) {
          return {
            async all<T = unknown>(): Promise<{ results?: T[] }> {
              const rows = await sql.unsafe(query, values);
              return { results: rows as T[] };
            },
          };
        },
      };
    },
  };
}
