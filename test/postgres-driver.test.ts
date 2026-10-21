import { describe, expect, it } from 'vitest';
import { toPostgresPlaceholders, postgresCorpusDatabase } from '../src/corpora/postgres-driver';

/**
 * The placeholders.
 *
 * D1's statements are written with `?` and Postgres's with `$1`. The driver
 * translates, so the adapters keep one dialect — and the translation is the
 * kind of thing that is trivial to get right and easy to get wrong.
 */
describe('the placeholders', () => {
  it('numbers them in order', () => {
    expect(toPostgresPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2',
    );
  });

  it('leaves a statement with no placeholders alone', () => {
    expect(toPostgresPlaceholders('SELECT 1')).toBe('SELECT 1');
  });

  /**
   * A `?` inside a string is not a placeholder. A law that quotes a question
   * mark is not unusual, and the search text is full of punctuation.
   */
  it('does not count a question mark inside a string', () => {
    expect(toPostgresPlaceholders("SELECT * FROM t WHERE a = 'who?' AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = 'who?' AND b = $1",
    );
  });

  it('does not count a question mark inside a quoted identifier', () => {
    expect(toPostgresPlaceholders('SELECT "a?" FROM t WHERE b = ?')).toBe(
      'SELECT "a?" FROM t WHERE b = $1',
    );
  });

  it('handles a doubled quote inside a string', () => {
    expect(toPostgresPlaceholders("SELECT * FROM t WHERE a = 'it''s?' AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = 'it''s?' AND b = $1",
    );
  });
});

describe('the driver', () => {
  it('runs the statement with its values and returns the rows', async () => {
    const calls: { query: string; values: unknown[] }[] = [];
    const db = postgresCorpusDatabase({
      unsafe(query: string, values?: unknown[]) {
        calls.push({ query, values: values ?? [] });
        return async () => [{ id: 'acts-en-1' }];
      },
    });

    const result = await db
      .prepare('SELECT id FROM statute_provisions WHERE language = ? AND id = ?')
      .bind('fr', 'acts-fr-1')
      .all<{ id: string }>();

    expect(result.results).toEqual([{ id: 'acts-en-1' }]);
    expect(calls[0]?.query).toBe(
      'SELECT id FROM statute_provisions WHERE language = $1 AND id = $2',
    );
    expect(calls[0]?.values).toEqual(['fr', 'acts-fr-1']);
  });
});
