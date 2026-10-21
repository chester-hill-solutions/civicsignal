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
 *   written with `$1`. Rather than rewrite every query, the `?` are
 *   translated on the way out. The translation is the kind of thing that is
 *   trivial to get right and easy to get wrong — a `?` inside a string
 *   literal, say — so it is a function with a test of its own.
 * - **The booleans.** D1's `in_force` is an integer and Postgres's is a
 *   boolean, and the adapters read `in_force` as a number. The driver does not
 *   paper over that: it is the adapter's business, because the adapter knows
 *   which store it is reading.
 */
import type { CorpusDatabase, CorpusStatement } from '@chester-hill-solutions/corpus';

/**
 * Rewrite `?` placeholders as Postgres's `$1`, `$2`, ….
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

/** The subset of postgres.js this driver uses. */
export interface PostgresLike {
  unsafe(query: string, parameters?: unknown[]): {
    (): Promise<unknown[]>;
  };
}

/**
 * A `CorpusDatabase` over a Postgres connection.
 *
 * The pool is passed in rather than created here, so the caller owns its
 * lifecycle — a Worker owns nothing, and a Bun service owns exactly one pool
 * for the life of the process.
 */
export function postgresCorpusDatabase(sql: PostgresLike): CorpusDatabase {
  return {
    prepare(statement: string): CorpusStatement {
      const query = toPostgresPlaceholders(statement);
      return {
        bind(...values: unknown[]) {
          return {
            async all<T = unknown>(): Promise<{ results?: T[] }> {
              const rows = await sql.unsafe(query, values)();
              return { results: rows as T[] };
            },
          };
        },
      };
    },
  };
}
