import { emitCorpusItem } from '@chester-hill-solutions/corpus';
import { CORPUSES_BY_ID } from '../corpora/registry';
import { policyFor } from '../corpora/policies';
import type { CorpusContext } from '../corpora/types';
import { languageFor } from '../language';

/**
 * A citation, resolved exactly.
 *
 * A citation is a key, not a similarity. "Section 210 of the Canada Labour
 * Code" names one provision, and a text search over the same Act puts the
 * right answer at rank five — because a bare section number has almost no IDF
 * across a corpus of a quarter of a million provisions.
 *
 * So this is an exact lookup, and it says whether the provision is in force.
 *
 * It answers the repealed case too. The useful answer to "what does section 9
 * say" is sometimes "it was repealed in 2010", and a corpus that cannot say so
 * has thrown the answer away.
 *
 * The instrument title is the instrument's own title in the language asked for,
 * so a French citation names a French Act — and the two official versions of a
 * provision are separate rows with separate identifiers, so the language has to
 * be settled or the lookup returns the wrong one.
 */

export interface CiteArgs {
  /** The instrument title, as it appears in the corpus. */
  act: string;
  /** The provision label — "210", "1.1", "Schedule 1". */
  section: string;
  /** The language of the provision. Inferred from the instrument title if absent. */
  language?: 'en' | 'fr';
  limit?: number;
}

/** One resolved provision. */
export interface ResolvedProvision {
  id: string;
  title: string;
  language?: string;
  status?: string;
  inForce?: boolean;
  citation?: string;
  citationUrl: string;
  text?: string;
}

export interface CiteResult {
  /** A sentence saying what was found. */
  summary: string;
  /** The provisions, in the order the corpus returned them. */
  items: ResolvedProvision[];
  /** The language the lookup was made in. */
  language: 'en' | 'fr';
}

/**
 * Resolve a citation against the statute corpus.
 *
 * The language is settled before the lookup: an explicit request wins, and
 * otherwise the instrument title decides, because a French title names a French
 * Act.
 */
export async function citeProvision(args: CiteArgs, ctx: CorpusContext): Promise<CiteResult> {
  const corpus = CORPUSES_BY_ID.get('statutes-canada');
  if (!corpus) {
    return { summary: 'The statute corpus is unavailable.', items: [], language: 'en' };
  }

  const language = args.language ?? languageFor(undefined, args.act);
  const raw = await corpus.retrieve(
    {
      act: args.act,
      section: args.section,
      language,
      limit: args.limit,
    },
    ctx,
  );

  const policy = policyFor(corpus.id);
  const items: ResolvedProvision[] = policy
    ? raw.map((item) => emitCorpusItem(policy, item)).map((item) => ({
        id: item.id,
        title: item.title,
        language: item.language,
        status: item.extra?.['status'] as string | undefined,
        inForce: item.extra?.['inForce'] as boolean | undefined,
        citation: item.extra?.['citation'] as string | undefined,
        citationUrl: item.citationUrl,
        text: item.body,
      }))
    : [];

  const summary = items.length
    ? items.map((r) => `${r.citation ?? r.title}${r.inForce ? '' : ' (not in force)'}`).join('; ')
    : `no provision matches "${args.act}" s. ${args.section} in ${language}`;

  return { summary, items, language };
}
