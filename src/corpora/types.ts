import type {
  Corpus,
  CorpusContext,
  CorpusQuery as BaseCorpusQuery,
} from "@chester-hill-solutions/corpus";

export type { Corpus, CorpusContext };

/**
 * How the question is framed geographically.
 *
 * Geography is not a mode the product switches on or off — it is a lens the caller
 * chooses, and it depends on the issue and on how they want to frame it. A
 * topic-only brief still reports where the topic is live, so the caller can see the
 * distribution before deciding how to narrow it.
 */
export type Scope =
  | { type: "topic" }
  | { type: "riding"; code: string; name?: string }
  | { type: "municipality"; name: string; province?: string }
  | { type: "jurisdiction"; code: string; name?: string }
  | { type: "region"; name: string };

/** The shared query shape, plus this product's framing. */
export interface CorpusQuery extends BaseCorpusQuery {
  scope?: Scope;
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
    (t): t is string => typeof t === "string" && t.trim().length > 0,
  );
  return terms.map((t) => `%${escapeLike(t.trim().toLowerCase())}%`);
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
