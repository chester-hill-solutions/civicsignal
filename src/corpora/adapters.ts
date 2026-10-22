import type { RawCorpusItem } from "@chester-hill-solutions/corpus";
import {
  BILLS_CANADA,
  GDELT,
  HANSARD_FEDERAL,
  NEWS_CANADA,
  STATUTES_CANADA,
  STATUTES_ONTARIO,
} from './policies';
import { normalizeForSearch } from '../text';
import {
  escapeLike,
  likePatterns,
  resolveLimit,
  MAX_LIMIT,
  type Corpus,
  type CorpusContext,
  type CorpusQuery,
} from './types';

/**
 * Corpus adapters.
 *
 * Each adapter reads from a D1 table populated by an ingest job. They deliberately
 * return raw items — the licence policy is applied afterwards, by `emitCorpusItem`,
 * so no adapter can widen its own permissions.
 */

/** Runs a LIKE match against a normalised token column. */
const TOKEN_MATCH = "search_text LIKE ? ESCAPE '\\'";

function tokenClause(patterns: string[]): { sql: string; binds: string[] } {
  if (patterns.length === 0) return { sql: '', binds: [] };
  return {
    sql: ` AND (${patterns.map(() => TOKEN_MATCH).join(' OR ')})`,
    binds: patterns,
  };
}

function dateClause(query: CorpusQuery): { sql: string; binds: string[] } {
  const binds: string[] = [];
  const parts: string[] = [];
  if (query.since) {
    parts.push('published_at >= ?');
    binds.push(query.since);
  }
  if (query.until) {
    parts.push('published_at <= ?');
    binds.push(query.until);
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', binds };
}

async function queryRows(
  ctx: CorpusContext,
  sql: string,
  binds: string[],
): Promise<Record<string, unknown>[]> {
  if (!ctx.db) return [];
  const stmt = ctx.db.prepare(sql);
  const result = await stmt.bind(...binds).all<Record<string, unknown>>();
  return result.results ?? [];
}

/* -------------------------------------------------------------------------- */
/* Statutes — Open Government Licence Canada. Full text may be emitted.        */
/* -------------------------------------------------------------------------- */

export const statutesCorpus: Corpus = {
  id: STATUTES_CANADA.id,
  policy: STATUTES_CANADA,
  supports(query) {
    // A citation is answerable even though it carries no topic and no keywords:
    // it names the provision exactly.
    if (query.act && query.section) return true;
    return Boolean(query.topic || (query.keywords && query.keywords.length > 0));
  },
  async retrieve(query: CorpusQuery, ctx: CorpusContext): Promise<RawCorpusItem[]> {
    // A citation is an exact lookup, and it has to take its own path.
    //
    // The text-search path below needs keywords or a topic and returns nothing
    // without them — which is right for a search and wrong for a citation,
    // because a citation carries neither. It names one provision, and the query
    // that resolves it is `act = ? AND section = ?`.
    //
    // It also does not filter on in-force. The useful answer to "what does
    // section 9 say" is sometimes "it was repealed in 2010", and a corpus that
    // cannot say so has thrown the answer away.
    if (query.act && query.section) {
      return retrieveProvision(query, ctx);
    }

    // The vector arm, when the deployment has one.
    //
    // This is the arm the product was measured on and the one it should use:
    // over 36 questions, vector search found 14 of 18 ordinary-language
    // questions against the keyword baseline's 3, and its MRR was 0.617 against
    // 0.310. The lexical path below is the fallback — right for a small
    // corpus, and a poor answer for a quarter of a million provisions.
    //
    // A citation never comes through here, and that is deliberate: a citation
    // is a key, not a similarity, and resolving it structurally is exact where
    // a ranking can only be close.
    const vectorItems = await retrieveByVector(query, ctx);
    if (vectorItems && vectorItems.length > 0) return vectorItems;
    // The vector arm ran and found nothing, or could not run. Either way the
    // lexical path is tried, because a product that answers "nothing here"
    // when a keyword search would have found the provision is worse than one
    // that answers with the weaker of two searches.

    const patterns = likePatterns(query);
    if (patterns.length === 0) return [];
    const { sql: tok, binds: tokBinds } = tokenClause(patterns);
    const jur = query.jurisdiction
      ? { sql: ' AND jurisdiction = ?', binds: [query.jurisdiction.toUpperCase()] }
      : { sql: '', binds: [] as string[] };
    // The language is a lens the caller chooses, exactly like the jurisdiction.
    //
    // It has to be a filter and not a detail because the corpus holds both
    // official languages, and the two versions of a provision are *different
    // rows with different identifiers*. Without the filter, one provision is
    // two answers and the caller cannot say which one they meant — and a
    // French row crowds out the English one out of the top k for an English
    // question.
    const lang = query.language
      ? { sql: ' AND language = ?', binds: [query.language.toLowerCase()] }
      : { sql: '', binds: [] as string[] };
    // An exact instrument filter, used when a citation names the Act.
    const act = query.act ? { sql: ' AND act = ?', binds: [query.act] } : { sql: '', binds: [] as string[] };

    // A citation lookup is not a topic search. It has to find the provision whether
    // or not it is in force, because the useful answer to "what does section 9
    // say" is sometimes "it was repealed in 2010" rather than nothing at all. A
    // topic search still only sees live law.
    const liveOnly = query.act ? '' : ' AND in_force = 1';

    const rows = await queryRows(
      ctx,
      `SELECT id, corpus_id, act, citation, section, status, heading, text, source_url, jurisdiction, in_force, topics, language
         FROM statute_sections
        WHERE 1 = 1${liveOnly}${tok}${jur.sql}${lang.sql}${act.sql}
        ORDER BY in_force DESC, act, section
        LIMIT ?`,
      [...tokBinds, ...jur.binds, ...lang.binds, ...act.binds, String(resolveLimit(query.limit))],
    );

    return rows.map((row) => ({
      corpusId: String(row['corpus_id'] ?? STATUTES_CANADA.id),
      kind: 'statute' as const,
      id: String(row['id']),
      title: `${String(row['act'])} s. ${String(row['section'])}${row['heading'] ? ` — ${String(row['heading'])}` : ''}`,
      body: row['text'] === null || row['text'] === undefined ? undefined : String(row['text']),
      citationUrl: String(row['source_url']),
      source: STATUTES_CANADA.publisher,
      jurisdiction: row['jurisdiction'] === null ? undefined : String(row['jurisdiction']),
      language: row['language'] === null || row['language'] === undefined ? undefined : String(row['language']),
      topics: splitTopics(row['topics']),
      extra: {
        act: String(row['act']),
        citation: row['citation'] === null || row['citation'] === undefined ? undefined : String(row['citation']),
        section: String(row['section']),
        status: row['status'] === null || row['status'] === undefined ? undefined : String(row['status']),
        inForce: Number(row['in_force']) === 1,
      },
    }));
  },
};


/* -------------------------------------------------------------------------- */
/* The vector arm.                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Search by meaning, when the deployment has an index and a way to embed.
 *
 * Returns `null` when the deployment has neither an index nor an embedder,
 * which is the signal to fall back to the lexical path. It returns an empty
 * array when the search ran and found nothing, and the caller falls back
 * anyway: "the corpus has nothing about that" is a strong claim, and it
 * should be a claim about both searches rather than one.
 *
 * The language is a filter on the index, not a filter afterwards. The two
 * official versions of a provision are separate rows, so a French question
 * that competes with the English rows for a place in the top k gets half the
 * top k back in the wrong language.
 *
 * ## The keywords are a constraint, not a question
 *
 * A topic and keywords are two different things a caller can say, and they
 * used to be glued together into the text that gets embedded. That makes the
 * model rank by *both* at once, and the keywords — which are usually the
 * caller's own words rather than the statute's — dominate: the question
 * becomes the words the caller happened to type.
 *
 * So the **topic** is embedded, and the keywords **filter the result**: every
 * keyword has to appear in the provision, folded the way the corpus's own
 * text is folded (so an unaccented `reglement` finds `règlement`). A few
 * dozen rows are filtered in memory, with no index and no second search.
 *
 * When there is no topic, the keywords *are* the question — there is nothing
 * else to embed — and they are not also a filter, because filtering a search
 * by the words it searches for is a no-op that costs a scan.
 */
async function retrieveByVector(
  query: CorpusQuery,
  ctx: CorpusContext,
): Promise<RawCorpusItem[] | null> {
  if (!ctx.vector || !ctx.embedQuery) return null;

  const topic = (query.topic ?? '').trim();
  const keywords = (query.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  const question = topic || keywords.join(' ');
  if (!question) return null;

  const limit = resolveLimit(query.limit);
  const constrained = topic !== '' && keywords.length > 0;

  const vector = await ctx.embedQuery(question);
  const filter = query.language ? { language: query.language.toLowerCase() } : undefined;
  // Over-fetch when the result is going to be filtered: the provisions that
  // match the keywords may not be the ones the embedding ranked first, and a
  // filter applied to exactly `limit` rows can empty a result the corpus can
  // answer.
  const matches = await ctx.vector.query(
    vector,
    constrained ? Math.min(limit * 4, MAX_LIMIT) : limit,
    filter,
  );
  if (matches.length === 0) return [];

  // The index holds no text. The rows come from the database, in the order the
  // index ranked them, and a row the index names but the database does not have
  // is a row that has been removed since the index was written.
  const rows = await rowsById(
    ctx,
    matches.map((m) => m.id),
  );
  const byId = new Map(rows.map((row) => [String(row['id']), row]));
  let ordered = matches
    .map((match) => byId.get(match.id))
    .filter((row): row is Record<string, unknown> => row !== undefined);

  if (constrained) {
    const wanted = keywords.map((keyword) => normalizeForSearch(keyword));
    ordered = ordered
      .filter((row) => {
        const folded = normalizeForSearch(
          [row['act'], row['section'], row['heading'], row['text']]
            .filter((part) => part !== null && part !== undefined)
            .join(' '),
        );
        return wanted.every((keyword) => folded.includes(keyword));
      })
      .slice(0, limit);
  }

  return ordered.map((row) => ({
    corpusId: String(row['corpus_id'] ?? STATUTES_CANADA.id),
    kind: 'statute' as const,
    id: String(row['id']),
    title: `${String(row['act'])} s. ${String(row['section'])}${row['heading'] ? ` — ${String(row['heading'])}` : ''}`,
    body: row['text'] === null || row['text'] === undefined ? undefined : String(row['text']),
    citationUrl: String(row['source_url']),
    source: STATUTES_CANADA.publisher,
    jurisdiction: row['jurisdiction'] === null ? undefined : String(row['jurisdiction']),
    language: row['language'] === null || row['language'] === undefined ? undefined : String(row['language']),
    topics: splitTopics(row['topics']),
    extra: {
      act: String(row['act']),
      citation: row['citation'] === null || row['citation'] === undefined ? undefined : String(row['citation']),
      section: String(row['section']),
      status: row['status'] === null || row['status'] === undefined ? undefined : String(row['status']),
      inForce: Number(row['in_force']) === 1,
    },
  }));
}

/**
 * Fetch rows by id, keeping the order they were asked for.
 *
 * D1 takes a hundred bound parameters per query, so the ids are fetched in
 * chunks and put back together here.
 */
async function rowsById(ctx: CorpusContext, ids: string[]): Promise<Record<string, unknown>[]> {
  if (!ctx.db) return [];
  const found: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await queryRows(
      ctx,
      `SELECT id, corpus_id, act, citation, section, status, heading, text, source_url, jurisdiction, in_force, topics, language
         FROM statute_sections
        WHERE id IN (${placeholders})`,
      chunk,
    );
    found.push(...rows);
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* Hansard — Crown copyright. Cite-only: excerpt + citation, never the corpus.  */
/* -------------------------------------------------------------------------- */

/**
 * Resolve one provision by its instrument and its label.
 *
 * This is the citation path: an exact lookup, not a search. It deliberately does
 * not filter on `in_force`, because a repealed provision is still a provision the
 * caller asked about, and the answer to a repealed citation is "repealed", not
 * silence.
 */
async function retrieveProvision(
  query: CorpusQuery,
  ctx: CorpusContext,
): Promise<RawCorpusItem[]> {
  // The language filter, for the same reason as in the search path.
  //
  // Here it matters most, because this is the path that returns a *definitive*
  // answer. An exact lookup that matched both official versions of a provision
  // would hand the caller two rows and let it pick — which is exactly the
  // ambiguity a citation is supposed to remove. The instrument titles differ
  // between the languages, so in practice the `act` filter usually separates
  // them; but "usually" is not a property a citation lookup should rely on,
  // because some instrument titles are the same in both languages.
  const lang = query.language
    ? { sql: ' AND language = ?', binds: [query.language.toLowerCase()] }
    : { sql: '', binds: [] as string[] };

  const rows = await queryRows(
    ctx,
    `SELECT id, corpus_id, act, citation, section, status, heading, text, source_url, jurisdiction, in_force, topics, language
       FROM statute_sections
      WHERE act = ? AND section = ?${lang.sql}
      ORDER BY in_force DESC, id
      LIMIT ?`,
    [query.act!, query.section!, ...lang.binds, String(resolveLimit(query.limit))],
  );

  return rows.map((row) => ({
    corpusId: String(row['corpus_id'] ?? STATUTES_CANADA.id),
    kind: 'statute' as const,
    id: String(row['id']),
    title: `${String(row['act'])} s. ${String(row['section'])}${row['heading'] ? ` — ${String(row['heading'])}` : ''}`,
    body: row['text'] === null || row['text'] === undefined ? undefined : String(row['text']),
    citationUrl: String(row['source_url']),
    source: STATUTES_CANADA.publisher,
    jurisdiction: row['jurisdiction'] === null ? undefined : String(row['jurisdiction']),
    language: row['language'] === null || row['language'] === undefined ? undefined : String(row['language']),
    topics: splitTopics(row['topics']),
    extra: {
      act: String(row['act']),
      citation: row['citation'] === null || row['citation'] === undefined ? undefined : String(row['citation']),
      section: String(row['section']),
      status: row['status'] === null || row['status'] === undefined ? undefined : String(row['status']),
      inForce: Number(row['in_force']) === 1,
    },
  }));
}

export const hansardCorpus: Corpus = {
  id: HANSARD_FEDERAL.id,
  policy: HANSARD_FEDERAL,
  supports(query) {
    return Boolean(query.topic || (query.keywords && query.keywords.length > 0));
  },
  async retrieve(query: CorpusQuery, ctx: CorpusContext): Promise<RawCorpusItem[]> {
    const patterns = likePatterns(query);
    if (patterns.length === 0) return [];
    const { sql: tok, binds: tokBinds } = tokenClause(patterns);
    const { sql: dates, binds: dateBinds } = dateClause(query);

    const rows = await queryRows(
      ctx,
      `SELECT id, corpus_id, speaker, party, sitting_date, excerpt, source_url, topics
         FROM hansard_speeches
        WHERE 1 = 1${tok}${dates}
        ORDER BY sitting_date DESC
        LIMIT ?`,
      [...tokBinds, ...dateBinds, String(resolveLimit(query.limit))],
    );

    return rows.map((row) => ({
      corpusId: String(row['corpus_id'] ?? HANSARD_FEDERAL.id),
      kind: 'debate' as const,
      id: String(row['id']),
      title: `${String(row['speaker'])} in the House of Commons`,
      // The full speech never reaches this adapter; the ingest job stores only a
      // short excerpt, and the policy caps what may be emitted.
      excerpt: row['excerpt'] === null ? undefined : String(row['excerpt']),
      citationUrl: String(row['source_url']),
      publishedAt: row['sitting_date'] === null ? undefined : String(row['sitting_date']),
      source: HANSARD_FEDERAL.publisher,
      topics: splitTopics(row['topics']),
      extra: { speaker: String(row['speaker']), party: row['party'] ? String(row['party']) : undefined },
    }));
  },
};

/* -------------------------------------------------------------------------- */
/* News — per-publisher terms. Metadata only: headline, outlet, timestamp, link. */
/* -------------------------------------------------------------------------- */

export const newsCorpus: Corpus = {
  id: NEWS_CANADA.id,
  policy: NEWS_CANADA,
  supports(query) {
    return Boolean(query.topic || (query.keywords && query.keywords.length > 0));
  },
  async retrieve(query: CorpusQuery, ctx: CorpusContext): Promise<RawCorpusItem[]> {
    const patterns = likePatterns(query);
    if (patterns.length === 0) return [];
    const { sql: tok, binds: tokBinds } = tokenClause(patterns);
    const { sql: dates, binds: dateBinds } = dateClause(query);
    const jur = query.jurisdiction
      ? { sql: ' AND jurisdiction = ?', binds: [query.jurisdiction.toUpperCase()] }
      : { sql: '', binds: [] as string[] };

    const rows = await queryRows(
      ctx,
      `SELECT id, corpus_id, title, outlet, published_at, url, jurisdiction, riding, topics
         FROM news_items
        WHERE 1 = 1${tok}${dates}${jur.sql}
        ORDER BY published_at DESC
        LIMIT ?`,
      [...tokBinds, ...dateBinds, ...jur.binds, String(resolveLimit(query.limit))],
    );

    return rows.map((row) => ({
      corpusId: String(row['corpus_id'] ?? NEWS_CANADA.id),
      kind: 'news' as const,
      id: String(row['id']),
      title: String(row['title']),
      citationUrl: String(row['url']),
      publishedAt: row['published_at'] === null ? undefined : String(row['published_at']),
      source: String(row['outlet']),
      jurisdiction: row['jurisdiction'] === null ? undefined : String(row['jurisdiction']),
      topics: splitTopics(row['topics']),
      extra: row['riding'] === null ? undefined : { riding: String(row['riding']) },
    }));
  },
};

/* -------------------------------------------------------------------------- */
/* GDELT — global press monitor. Metadata only; carries tone for sentiment.     */
/* -------------------------------------------------------------------------- */

export const gdeltCorpus: Corpus = {
  id: GDELT.id,
  policy: GDELT,
  supports(query) {
    return Boolean(query.topic || (query.keywords && query.keywords.length > 0));
  },
  async retrieve(query: CorpusQuery, ctx: CorpusContext): Promise<RawCorpusItem[]> {
    const patterns = likePatterns(query);
    if (patterns.length === 0) return [];
    const { sql: tok, binds: tokBinds } = tokenClause(patterns);
    const { sql: dates, binds: dateBinds } = dateClause(query);

    const rows = await queryRows(
      ctx,
      `SELECT id, corpus_id, title, url, published_at, tone, country, topics
         FROM gdelt_events
        WHERE 1 = 1${tok}${dates}
        ORDER BY published_at DESC
        LIMIT ?`,
      [...tokBinds, ...dateBinds, String(resolveLimit(query.limit))],
    );

    return rows.map((row) => ({
      corpusId: String(row['corpus_id'] ?? GDELT.id),
      kind: 'event' as const,
      id: String(row['id']),
      title: String(row['title']),
      citationUrl: String(row['url']),
      publishedAt: row['published_at'] === null ? undefined : String(row['published_at']),
      source: 'GDELT Project',
      jurisdiction: row['country'] === null ? undefined : String(row['country']),
      topics: splitTopics(row['topics']),
      sentiment:
        row['tone'] === null || row['tone'] === undefined
          ? undefined
          : { score: Number(row['tone']) },
    }));
  },
};

/* -------------------------------------------------------------------------- */
/* Bills — status and identifiers are facts; bill text is not republished.      */
/* -------------------------------------------------------------------------- */

export const billsCorpus: Corpus = {
  id: BILLS_CANADA.id,
  policy: BILLS_CANADA,
  supports(query) {
    return Boolean(query.topic || (query.keywords && query.keywords.length > 0));
  },
  async retrieve(query: CorpusQuery, ctx: CorpusContext): Promise<RawCorpusItem[]> {
    const patterns = likePatterns(query);
    if (patterns.length === 0) return [];
    const { sql: tok, binds: tokBinds } = tokenClause(patterns);

    const rows = await queryRows(
      ctx,
      `SELECT id, corpus_id, number, title, sponsor, stage, introduced_at, source_url, jurisdiction, topics
         FROM bills
        WHERE 1 = 1${tok}
        ORDER BY introduced_at DESC
        LIMIT ?`,
      [...tokBinds, String(resolveLimit(query.limit))],
    );

    return rows.map((row) => ({
      corpusId: String(row['corpus_id'] ?? BILLS_CANADA.id),
      kind: 'bill' as const,
      id: String(row['id']),
      title: `${String(row['number'])} — ${String(row['title'])}`,
      citationUrl: String(row['source_url']),
      publishedAt: row['introduced_at'] === null ? undefined : String(row['introduced_at']),
      source: BILLS_CANADA.publisher,
      jurisdiction: row['jurisdiction'] === null ? undefined : String(row['jurisdiction']),
      topics: splitTopics(row['topics']),
      extra: {
        number: String(row['number']),
        sponsor: row['sponsor'] ? String(row['sponsor']) : undefined,
        stage: row['stage'] ? String(row['stage']) : undefined,
      },
    }));
  },
};

/* -------------------------------------------------------------------------- */

export function splitTopics(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parts = value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return parts.length ? parts : undefined;
}

export { escapeLike };
