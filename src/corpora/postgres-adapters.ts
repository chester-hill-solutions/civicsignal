/**
 * The statutes corpus, on Postgres.
 *
 * This is the same corpus as the D1 adapter in `adapters.ts`, against the
 * other schema — and it is a separate file rather than a parameterisation of
 * that one, because the D1 adapter is **temporary**: it goes when the Worker
 * does (step 6 of the port), and a file that is on its way out is not worth
 * bending into a shared abstraction.
 *
 * The two schemas differ in more than names:
 *
 * | | D1 | Postgres |
 * |---|---|---|
 * | the table | `statute_sections` | `statute_provisions` |
 * | the instrument | `act` | `instrument` |
 * | in force | an integer | a boolean |
 * | topics | a column | a column — the corpus has none to write yet |
 *
 * The lexical path is the same shape on both: a `LIKE` over the folded
 * `search_text`, with the query folded the same way. Postgres has a full-text
 * index as well (`to_tsvector('english', search_text)`), which is better, but
 * it is stemmed with the *English* configuration and the corpus is bilingual —
 * so the `LIKE` is the path that behaves identically in both languages, and it
 * is the one this uses.
 */
import type { RawCorpusItem } from '@chester-hill-solutions/corpus';
import { STATUTES_CANADA } from './policies';
import { splitTopics } from './adapters';
import { likePatterns, resolveLimit, type Corpus, type CorpusContext, type CorpusQuery } from './types';

/** Runs a LIKE match against a normalised token column. */
const TOKEN_MATCH = "search_text LIKE ? ESCAPE '\\'";

/**
 * The token clause, as the D1 adapter builds it.
 *
 * It is here rather than imported because the D1 adapter is on its way out —
 * but the *shape* of the lexical path is identical on both planes, so the two
 * must not drift apart. It is a disjunction, not a conjunction: a query that
 * matches any of its terms matches, and the pattern carries the wildcards
 * already folded the same way the corpus was folded.
 */
function tokenClause(patterns: string[]): { sql: string; binds: string[] } {
  if (patterns.length === 0) return { sql: '', binds: [] };
  return {
    sql: ` AND (${patterns.map(() => TOKEN_MATCH).join(' OR ')})`,
    binds: patterns,
  };
}

/** The query, in the shape the adapter needs. */
async function queryRows<T>(
  ctx: CorpusContext,
  sql: string,
  binds: unknown[],
): Promise<T[]> {
  if (!ctx.db) return [];
  const stmt = ctx.db.prepare(sql);
  const result = await stmt.bind(...binds).all<T>();
  return result.results ?? [];
}

/**
 * The citation path: one provision, resolved exactly.
 *
 * The language filter matters most here, because this is the path that returns
 * a *definitive* answer. An exact lookup that matched both official versions
 * of a provision would hand the caller two rows and let it choose — which is
 * exactly the ambiguity a citation is supposed to remove.
 */
async function retrieveProvision(
  query: CorpusQuery,
  ctx: CorpusContext,
): Promise<RawCorpusItem[]> {
  const lang = query.language
    ? { sql: ' AND language = ?', binds: [query.language.toLowerCase()] }
    : { sql: '', binds: [] as string[] };

  const rows = await queryRows<Record<string, unknown>>(
    ctx,
    `SELECT id, corpus_id, instrument, citation, section, status, heading, text, source_url, jurisdiction, in_force, topics, language
       FROM statute_provisions
      WHERE instrument = ? AND section = ?${lang.sql}
      ORDER BY in_force DESC, id
      LIMIT ?`,
    [query.act!, query.section!, ...lang.binds, String(resolveLimit(query.limit))],
  );

  return rows.map((row) => ({
    corpusId: String(row['corpus_id'] ?? STATUTES_CANADA.id),
    kind: 'statute' as const,
    id: String(row['id']),
    title: `${String(row['instrument'])} s. ${String(row['section'])}${row['heading'] ? ` — ${String(row['heading'])}` : ''}`,
    body: row['text'] === null || row['text'] === undefined ? undefined : String(row['text']),
    citationUrl: String(row['source_url']),
    source: STATUTES_CANADA.publisher,
    jurisdiction: row['jurisdiction'] === null ? undefined : String(row['jurisdiction']),
    language: row['language'] === null || row['language'] === undefined ? undefined : String(row['language']),
    topics: splitTopics(row['topics']),
    extra: {
      act: String(row['instrument']),
      citation: row['citation'] === null || row['citation'] === undefined ? undefined : String(row['citation']),
      section: String(row['section']),
      status: row['status'] === null || row['status'] === undefined ? undefined : String(row['status']),
      inForce: row['in_force'] === true || row['in_force'] === 1,
    },
  }));
}

export const postgresStatutesCorpus: Corpus = {
  id: STATUTES_CANADA.id,
  policy: STATUTES_CANADA,
  supports(query: CorpusQuery): boolean {
    return Boolean(query.topic || (query.keywords && query.keywords.length > 0));
  },
  async retrieve(query: CorpusQuery, ctx: CorpusContext): Promise<RawCorpusItem[]> {
    // A citation is an exact lookup, and it takes its own path: the
    // text-search path needs keywords or a topic and returns nothing without
    // them — which is right for a search and wrong for a citation, because a
    // citation carries neither. It also does not filter on in force, because
    // "it was repealed in 2010" is a better answer than nothing.
    if (query.act && query.section) {
      return retrieveProvision(query, ctx);
    }

    const patterns = likePatterns(query);
    if (patterns.length === 0) return [];
    const { sql: tok, binds: tokBinds } = tokenClause(patterns);
    const jur = query.jurisdiction
      ? { sql: ' AND jurisdiction = ?', binds: [query.jurisdiction.toUpperCase()] }
      : { sql: '', binds: [] as string[] };
    // The language is a lens the caller chooses, exactly like the jurisdiction:
    // the two official versions of a provision are separate rows, and without
    // the filter one provision is two answers.
    const lang = query.language
      ? { sql: ' AND language = ?', binds: [query.language.toLowerCase()] }
      : { sql: '', binds: [] as string[] };
    const act = query.act ? { sql: ' AND instrument = ?', binds: [query.act] } : { sql: '', binds: [] as string[] };
    // A citation lookup is not a topic search: it has to find the provision
    // whether or not it is in force, because "it was repealed in 2010" is a
    // better answer than nothing.
    const liveOnly = query.act ? '' : ' AND in_force';

    const rows = await queryRows<Record<string, unknown>>(
      ctx,
      `SELECT id, corpus_id, instrument, citation, section, status, heading, text, source_url, jurisdiction, in_force, topics, language
         FROM statute_provisions
        WHERE 1 = 1${liveOnly}${tok}${jur.sql}${lang.sql}${act.sql}
        ORDER BY in_force DESC, instrument, section
        LIMIT ?`,
      [...tokBinds, ...jur.binds, ...lang.binds, ...act.binds, String(resolveLimit(query.limit))],
    );

    return rows.map((row) => ({
      corpusId: String(row['corpus_id'] ?? STATUTES_CANADA.id),
      kind: 'statute' as const,
      id: String(row['id']),
      title: `${String(row['instrument'])} s. ${String(row['section'])}${row['heading'] ? ` — ${String(row['heading'])}` : ''}`,
      body: row['text'] === null || row['text'] === undefined ? undefined : String(row['text']),
      citationUrl: String(row['source_url']),
      source: STATUTES_CANADA.publisher,
      jurisdiction: row['jurisdiction'] === null ? undefined : String(row['jurisdiction']),
      language: row['language'] === null || row['language'] === undefined ? undefined : String(row['language']),
      // The column exists on both planes and holds the same thing on both: the
      // corpus has no topic classifier yet, so a topic is a promise. The brief's
      // distribution over topics is therefore empty on both planes, which is a
      // behaviour and not a port's gap.
      topics: splitTopics(row['topics']),
      extra: {
        act: String(row['instrument']),
        citation: row['citation'] === null || row['citation'] === undefined ? undefined : String(row['citation']),
        section: String(row['section']),
        status: row['status'] === null || row['status'] === undefined ? undefined : String(row['status']),
        inForce: row['in_force'] === true || row['in_force'] === 1,
      },
    }));
  },
};
