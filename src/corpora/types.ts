import type { CorpusPolicy, RawCorpusItem } from '../licensing';

/**
 * How the question is framed geographically.
 *
 * Geography is not a mode the product switches on or off — it is a lens the caller
 * chooses, and it depends on the issue and on how they want to frame it. A
 * topic-only brief still reports where the topic is live, so the caller can see the
 * distribution before deciding how to narrow it.
 */
export type Scope =
  | { type: 'topic' }
  | { type: 'riding'; code: string; name?: string }
  | { type: 'municipality'; name: string; province?: string }
  | { type: 'jurisdiction'; code: string; name?: string }
  | { type: 'region'; name: string };

/** A query, as a caller expresses it. Every corpus decides for itself whether it can answer. */
export interface CorpusQuery {
  /** Free-text topic, e.g. "housing", "pharmacare", "clean electricity". */
  topic?: string;
  /** Additional terms that must also match. */
  keywords?: string[];
  /** Two-letter or full province/territory code, e.g. "ON", "BC", "QC". */
  jurisdiction?: string;
  /** Federal or provincial riding code, where the corpus is geography-scoped. */
  riding?: string;
  /** An exact instrument title, where the corpus is instrument-scoped. */
  act?: string;
  /** ISO-8601 date, inclusive. */
  since?: string;
  /** ISO-8601 date, inclusive. */
  until?: string;
  limit?: number;
  /** How the question is framed geographically, when the caller set one. */
  scope?: Scope;
}

export interface CorpusContext {
  /** D1 binding. Absent in unit tests; adapters degrade to an empty result. */
  db?: D1Database;
  /** Injectable for tests. */
  fetch: typeof fetch;
  now: () => Date;
}

/**
 * A corpus the product can query.
 *
 * Adapters return *raw* items. Sanitisation against the corpus policy happens in
 * `emitCorpusItem`, so no adapter is trusted to enforce the licence itself.
 */
export interface Corpus {
  id: string;
  policy: CorpusPolicy;
  /** Whether this corpus can contribute to the given query at all. */
  supports(query: CorpusQuery): boolean;
  retrieve(query: CorpusQuery, ctx: CorpusContext): Promise<RawCorpusItem[]>;
}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * Build a `LIKE` pattern set for a topic and its keywords.
 *
 * Corpus search is over a normalised token column; the pattern is escaped so a topic
 * containing `%` or `_` does not turn into a wildcard.
 */
export function likePatterns(query: CorpusQuery): string[] {
  const terms = [query.topic, ...(query.keywords ?? [])].filter(
    (t): t is string => typeof t === 'string' && t.trim().length > 0,
  );
  return terms.map((t) => `%${escapeLike(t.trim().toLowerCase())}%`);
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Escape a user-supplied term for safe use inside a LIKE ... ESCAPE '\' clause. */
export function inClause(values: string[]): { sql: string; binds: string[] } {
  if (values.length === 0) return { sql: '', binds: [] };
  return { sql: `(${values.map(() => '?').join(', ')})`, binds: values };
}
