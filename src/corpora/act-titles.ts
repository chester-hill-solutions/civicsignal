import type { Env } from '../types';

// Cache only within a database binding and a known published revision. A second
// binding or revision must never inherit titles from another corpus.
const cached = new WeakMap<D1Database, { revision: string; titles: string[] }>();

export async function loadActTitles(env: Env): Promise<string[]> {
  const db = env.CIVIC_DB;
  if (!db) return [];
  const state = await db.prepare('SELECT commit_sha, parser_version FROM corpus_state WHERE corpus_id = ?')
    .bind('statutes-canada').first<{ commit_sha: string; parser_version: string | null }>();
  const revision = state?.commit_sha ? `${state.commit_sha}:${state.parser_version ?? 'legacy'}` : undefined;
  const known = Boolean(revision && revision !== 'unknown');
  const previous = cached.get(db);
  if (known && previous && previous.revision === revision) return previous.titles;
  const result = await db.prepare('SELECT DISTINCT act FROM statute_sections WHERE corpus_id = ? ORDER BY act')
    .bind('statutes-canada').all<{ act: string }>();
  const titles = (result.results ?? []).map((row) => row.act).filter((title) => typeof title === 'string' && title.length > 0);
  if (known) cached.set(db, { revision: revision!, titles });
  return titles;
}
