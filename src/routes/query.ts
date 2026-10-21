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
  const topic = url.searchParams.get('topic') ?? undefined;
  const keywords = url.searchParams.getAll('keyword').filter(Boolean);
  const jurisdiction = url.searchParams.get('jurisdiction') ?? undefined;
  const riding = url.searchParams.get('riding') ?? undefined;
  const since = url.searchParams.get('since') ?? undefined;
  const until = url.searchParams.get('until') ?? undefined;
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  const scope = parseScope(url.searchParams.get('scope'));
  const language = languageFor(url.searchParams.get('language'), topic, keywords.join(' '));
  return { topic, keywords, jurisdiction, riding, since, until, limit, scope, language };
}
