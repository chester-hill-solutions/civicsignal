/**
 * The query a request describes.
 *
 * The surfaces parse the same way, so the parsing lives here rather than in
 * the request handler: a lens that one surface honours and another ignores is
 * a lens that behaves differently depending on who asked.
 */
import type { CorpusQuery } from '../corpora/types';
import { parseScope } from '../corpora/scope';
import { languageFor } from '../language';
import { RequestInputError } from '../http';

/**
 * Read a request's query parameters into a corpus query.
 *
 * The language is a lens, exactly like the jurisdiction: the corpus holds two
 * official versions of every provision, they are separate rows with separate
 * identifiers, and the caller chooses which one they are asking about. A
 * caller that names a language gets it; a caller that does not gets the one
 * their question is written in.
 */
export function parseQuery(url: URL): CorpusQuery {
  if (url.search.length > 16_384) throw new RequestInputError('The query is too long.');
  const known = new Set(['topic', 'keyword', 'jurisdiction', 'riding', 'since', 'until', 'limit', 'scope', 'language', 'act', 'section']);
  for (const name of url.searchParams.keys()) {
    if (!known.has(name)) throw new RequestInputError(`Unsupported query parameter: ${name}.`);
    if (name !== 'keyword' && url.searchParams.getAll(name).length > 1) throw new RequestInputError(`Supply ${name} once.`);
  }
  const bounded = (name: string, max: number): string | undefined => {
    const value = url.searchParams.get(name);
    if (value === null) return undefined;
    if (!value.trim() || value.length > max) throw new RequestInputError(`${name} must contain 1 to ${max} characters.`);
    return value.trim();
  };
  const topic = bounded('topic', 4_000);
  const keywords = url.searchParams.getAll('keyword').map((value) => value.trim());
  if (keywords.length > 8 || keywords.some((value) => !value || value.length > 80)) {
    throw new RequestInputError('Supply at most 8 keywords of 1 to 80 characters.');
  }
  const jurisdiction = url.searchParams.get('jurisdiction') ?? undefined;
  const riding = url.searchParams.get('riding') ?? undefined;
  const since = url.searchParams.get('since') ?? undefined;
  const until = url.searchParams.get('until') ?? undefined;
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (limit !== undefined && (!/^\d+$/.test(limitRaw!) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)) {
    throw new RequestInputError('limit must be an integer between 1 and 50.');
  }
  const requestedLanguage = bounded('language', 20);
  if (requestedLanguage && !/^(?:en|fr)(?:-[a-z]{2})?$/i.test(requestedLanguage)) {
    throw new RequestInputError('language must be en or fr, optionally with a regional suffix.');
  }
  const act = bounded('act', 200);
  const section = bounded('section', 60);
  if (Boolean(act) !== Boolean(section)) throw new RequestInputError('Supply act and section together.');
  const scope = parseScope(url.searchParams.get('scope'));
  const language = languageFor(requestedLanguage, act, topic, keywords.join(' '));
  return { topic, keywords, jurisdiction, riding, since, until, limit, scope, language, act, section };
}
