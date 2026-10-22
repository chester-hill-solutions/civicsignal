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

/**
 * How similar the best match has to be before the product answers.
 *
 * A vector search over a quarter of a million provisions never returns
 * *nothing*: ask for fifty and it returns fifty, ranked. So the honest way to
 * say "I don't have information on that" is not an empty result — it is a
 * floor on the score, below which the product says so.
 *
 * The number comes from `scripts/eval-floor.ts`, measured over the 36 labelled
 * questions on a 19,021-section corpus. It is a **trade**, and the measurement
 * states both sides:
 *
 * | floor | kept | kept and right | kept and **wrong** | refused but answerable |
 * |---|---|---|---|---|
 * | 0.8102 | 21 | 19 | 2 | 3 |
 * | 0.8318 | 18 | 17 | 1 | 5 |
 * | 0.8421 | 15 | 14 | 1 | 8 |
 * | 0.8561 | 12 | 12 | **0** | 10 |
 *
 * 0.84 is the knee. It refuses a fair number of questions the corpus *could*
 * answer — which is the price, and it is a product decision rather than a
 * fact. What the measurement cannot say is where the true optimum is, because
 * every question in the eval set has an answer: it measures the cost of the
 * floor and not the benefit. Calibrating it properly needs a set of questions
 * the corpus *cannot* answer, and the scores they get.
 */
export const VECTOR_FLOOR = 0.84;

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

    // **The vector arm, and nothing after it.**
    //
    // This used to fall back to a lexical `search_text LIKE ?` scan when the
    // vector arm returned *nothing* — and that condition is unreachable: a
    // vector search over a quarter of a million provisions returns the k it
    // was asked for, however little they have to do with the question. The
    // fallback was dead code, and the product's answer to a question the
    // corpus cannot answer was fifty provisions about something else.
    //
    // Measured, it was not worth resurrecting either: of the fourteen
    // questions the vector arm misses at rank 5, the keyword arm finds one in
    // its top 5 — and that one is an *exact* question the vector arm already
    // does at 94%. On the concept half, where the vector arm is the only arm
    // that works at all, the keyword arm rescues none of them.
    //
    // So the lexical path is gone with the column it searched, and the honest
    // refusal is the floor inside the vector arm.
    //
    // A deployment with no index and no embedder cannot answer a text search
    // at all, and says so by returning nothing rather than by scanning a
    // quarter of a million provisions one LIKE at a time.
    return (await retrieveByVector(query, ctx)) ?? [];
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

  // **The floor.** A vector search always returns the k it was asked for, so
  // "nothing found" is not something it can say — the product's answer to a
  // question the corpus cannot answer used to be fifty provisions about
  // something else. What it *can* say is that the best match is not close
  // enough to answer with.
  //
  // This is the refusal, and the caller turns it into "I don't have
  // information on that". It is deliberately before the rows are fetched: a
  // question the corpus cannot answer should cost one index query and no
  // database reads.
  const best = matches[0]!.score;
  if (best < VECTOR_FLOOR) return [];

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
