import type { Env } from '../types';

/**
 * The instrument titles in the corpus, for citation parsing.
 *
 * A citation names an Act, and the Act has to be matched against what the corpus
 * actually contains — "Labour Code" for "Canada Labour Code", and a corpus title
 * that is longer than the citation. The list is a few thousand strings, so it is
 * cached in memory per isolate and held in KV between deployments.
 */

const KV_KEY = 'corpus:act-titles';
let cached: string[] | null = null;

export function primeActTitles(titles: string[]): void {
  cached = titles;
}

/**
 * Load the instrument titles, from memory, then KV.
 *
 * An absent list is not an error: a brief without titles still works, it just cannot
 * resolve a citation structurally and falls back to search.
 */
export async function loadActTitles(env: Env): Promise<string[]> {
  if (cached) return cached;
  if (!env.CIVIC_CACHE) return [];
  const raw = await env.CIVIC_CACHE.get(KV_KEY, 'json');
  if (!Array.isArray(raw)) return [];
  cached = raw as string[];
  return cached;
}

export async function storeActTitles(env: Env, titles: string[]): Promise<void> {
  cached = titles;
  if (!env.CIVIC_CACHE) return;
  await env.CIVIC_CACHE.put(KV_KEY, JSON.stringify(titles));
}
