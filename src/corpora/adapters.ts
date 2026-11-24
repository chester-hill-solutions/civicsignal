import { truncate, type RawCorpusItem } from "@chester-hill-solutions/corpus";
import {
  BILLS_CANADA,
  GDELT,
  NEWS_CANADA,
  STATUTES_CANADA,
  STATUTES_ONTARIO,
} from './policies';
import { hash128 } from '../ingest/reconcile';
import { ATOMIC_QUESTIONS, CANDIDATE_COUNT, decide, EXCERPT_CHARS, JEV_CONTRACT_VERSION, JEV_MODEL, rankWithJev, RELEVANCE_FLOOR, reorder } from '../jev';
import { ENCODER_CONTRACT } from '../encoder';
import { normalizeForSearch } from '../text';
import { retrievalPolicyVersion, retrievalTrace, type RetrievalBackend } from './retrieval-observation';
import { loadExactProvisionRows } from './provision-lookup';
import { retrieveHybrid } from './hybrid';
import { hansardCitation, hansardLanguagePrefix, hansardPolicy, hansardSpeechIdentity, type HansardChamber } from './hansard';
import {
  escapeLike,
  likePatterns,
  normalizedSearchTerms,
  resolveLimit,
  MAX_LIMIT,
  type Corpus,
  type CachedRetrieval,
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

function dateClause(query: CorpusQuery, column: 'published_at' | 'sitting_date' = 'published_at'): { sql: string; binds: string[] } {
  const binds: string[] = [];
  const parts: string[] = [];
  if (query.since) {
    parts.push(`${column} >= ?`);
    binds.push(query.since);
  }
  if (query.until) {
    parts.push(`${column} <= ?`);
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
 * Existing Vectorize acceptance floor for vector-only retrieval and reranker
 * failure fallback. Successful reranking uses its own authority decision.
 *
 * Historical probes selected this value; they do not validate it for a new
 * encoder, corpus revision or held-out question set. Do not rescale this value
 * into a Postgres cosine threshold. Measure each backend through the serving
 * route and retain the calibration/holdout evidence in docs/V1-EVALUATION.md.
 * Changing the floor also changes the retrieval cache identity below.
 */
export const VECTOR_FLOOR = 0.62;

/** How long a cached retrieval lives. The corpus moves every three to eight days. */
export const CACHE_SECONDS = 6 * 60 * 60;

/** Every input that can change either the authority decision or the returned rows. */
export function retrievalCacheKey(query: CorpusQuery, revision: string, useJev: boolean,
  backend: { id: string; floor: number } = { id: 'vectorize', floor: VECTOR_FLOOR }): string {
  const topic = (query.topic ?? '').trim();
  const keywords = (query.keywords ?? []).map((keyword) => keyword.trim()).filter(Boolean);
  const contract = {
    corpus: STATUTES_CANADA.id,
    revision,
    question: topic || keywords.join(' '),
    keywords,
    language: query.language?.trim().toLowerCase() ?? null,
    jurisdiction: query.jurisdiction ?? null,
    riding: query.riding ?? null,
    since: query.since ?? null,
    until: query.until ?? null,
    scope: query.scope ?? null,
    limit: resolveLimit(query.limit),
    encoder: ENCODER_CONTRACT,
    policy: retrievalPolicyVersion(backend.id),
    backend: backend.id,
    floor: backend.floor,
    reranker: useJev ? { contract: JEV_CONTRACT_VERSION, model: JEV_MODEL, questions: ATOMIC_QUESTIONS, excerptChars: EXCERPT_CHARS, candidates: CANDIDATE_COUNT, relevanceFloor: RELEVANCE_FLOOR } : null,
  };
  return `retrieval:v2:${hash128(JSON.stringify(contract))}`;
}

function cachedRetrieval(value: unknown): CachedRetrieval | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const entry = value as Partial<CachedRetrieval>;
  if (!['answer', 'web', 'refuse'].includes(entry.decision ?? '') ||
      typeof entry.anyRelevant !== 'number' || !Number.isFinite(entry.anyRelevant) ||
      !Array.isArray(entry.order) || entry.order.length > CANDIDATE_COUNT ||
      !entry.order.every((id) => typeof id === 'string' && id.length > 0)) return undefined;
  return entry as CachedRetrieval;
}

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
      const trace = await retrievalTrace(ctx, query, 'vectorize', 'exact', null);
      try { return trace.result(await trace.provider('rows', () => retrieveProvision(query, ctx))); }
      catch (error) { trace.observation.decision = 'error'; throw error; }
      finally { trace.emit(); }
    }

    if (ctx.hybrid) {
      const rows = await retrieveHybrid(query, ctx, ctx.hybrid, VECTOR_FLOOR, rowsById,
        (items) => new Set(statuteItems(items, { ...query, limit: MAX_LIMIT }).map((item) => item.id)));
      return statuteItems(rows, query);
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
    return (await retrieveStatutesByVector(query, ctx)) ?? [];
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
export async function retrieveStatutesByVector(
  query: CorpusQuery,
  ctx: CorpusContext,
  backend: { id: RetrievalBackend; floor: number; loadRows: typeof rowsById } = { id: 'vectorize', floor: VECTOR_FLOOR, loadRows: rowsById },
): Promise<RawCorpusItem[] | null> {
  const trace = await retrievalTrace(ctx, query, backend.id, 'vector-floor', backend.floor);
  const observation = trace.observation;
  try {
    if (!ctx.vector || !ctx.embedQuery) {
      observation.mode = 'unavailable';
      return null;
    }
    const topic = (query.topic ?? '').trim();
    const keywords = (query.keywords ?? []).map((k) => k.trim()).filter(Boolean);
    const question = topic || keywords.join(' ');
    if (!question) { observation.mode = 'unavailable'; return null; }
    const limit = resolveLimit(query.limit);
    const constrained = topic !== '' && keywords.length > 0;

    // Cache reuse happens before embedding. Store the original safe observation
    // so a warm response never pretends that its raw score was computed now.
    let cacheKey: string | undefined;
    if (ctx.cache && ctx.retrievalCacheMode !== 'bypass') {
      if (trace.revisionKey) cacheKey = retrievalCacheKey(query, trace.revisionKey, Boolean(ctx.jev?.key), backend);
      else observation.cache = 'bypass';
      let cached: CachedRetrieval | undefined;
      if (cacheKey) {
        try {
          cached = cachedRetrieval(await ctx.cache.get(cacheKey));
        } catch {
          observation.cacheFailure = 'read';
          cacheKey = undefined;
        }
      }
      if (cached && cached.decision !== 'answer') {
        trace.cached(cached.observation);
        return trace.result([], cached.decision);
      }
      if (cached?.order.length) {
        // A hit records selection of this cached order, even if D1/R2 loading
        // fails. Cached scores are copied only after all rows hydrate; missing
        // rows still mark the entry stale and run the existing fresh search.
        observation.cache = 'hit';
        const rows = await trace.provider('rows', () => backend.loadRows(ctx, cached.order));
        const byId = new Map(rows.map((row) => [String(row['id']), row]));
        if (cached.order.every((id) => byId.has(id))) {
          trace.cached(cached.observation);
          return trace.result(statuteItems(cached.order.map((id) => byId.get(id)!), query));
        }
        observation.cache = 'stale';
      }
    }

    const vector = await trace.provider('encoder', () => ctx.embedQuery!(question));
    const filter = query.language ? { language: query.language.toLowerCase() } : undefined;
    const depth = ctx.jev?.key ? CANDIDATE_COUNT : constrained ? Math.min(limit * 4, MAX_LIMIT) : limit;
    const matches = await trace.provider('vector', () => ctx.vector!.query(vector, depth, filter));
    observation.candidateCount = matches.length;
    observation.preRefusalTopScore = matches[0]?.score ?? null;
    observation.scoreSource = matches.length ? 'computed' : 'none';
    observation.scoredAt = matches.length ? new Date().toISOString() : null;
    if (observation.preRefusalTopScore !== null && !Number.isFinite(observation.preRefusalTopScore)) throw new Error('The vector backend returned an invalid score.');
    if (!matches.length) return trace.result([]);

    // The score is captured after the actual language-filtered query and before
    // any acceptance decision, including a floor that refuses the response.
    if (!ctx.jev?.key && matches[0]!.score < backend.floor) return trace.result([]);
    const rows = await trace.provider('rows', () => backend.loadRows(ctx, matches.map((m) => m.id)));
    const byId = new Map(rows.map((row) => [String(row['id']), row]));
    const ordered = matches.map((match) => byId.get(match.id)).filter((row): row is Record<string, unknown> => row !== undefined);
    if (!ordered.length) return trace.result([]);

    if (ctx.jev?.key) {
      const ranked = await trace.provider('reranker', () => rankWithJev(question, ordered.map((row) => ({
        id: String(row['id']), title: `${String(row['act'])} s. ${String(row['section'])}${row['heading'] ? ` — ${String(row['heading'])}` : ''}`,
        text: String(row['text'] ?? ''),
      })), { key: ctx.jev!.key, onFailure: (failure) => { observation.rerankerFailure = failure; } }));
      if (ranked) {
        observation.mode = 'rerank';
        const decision = decide(ranked.flags, ranked.anyRelevant);
        const rankedRows = decision === 'answer' ? reorder(ordered, ranked.relevance) : [];
        const items = decision === 'answer' ? trace.result(statuteItems(rankedRows, query)) : trace.result([], decision);
        if (ctx.cache && cacheKey) {
          const entry: CachedRetrieval = {
            decision,
            anyRelevant: ranked.anyRelevant,
            order: rankedRows.map((row) => String(row['id'])).slice(0, CANDIDATE_COUNT),
            observation: { ...observation },
          };
          try {
            await ctx.cache.put(cacheKey, entry, CACHE_SECONDS);
          } catch {
            observation.cacheFailure = 'write';
          }
        }
        return items;
      }
      observation.providers.reranker = 'error';
      observation.fallback = true;
    }
    // The floor applies to the response as a whole, after filtering and limiting.
    const items = statuteItems(ordered, query);
    const qualifies = (results: RawCorpusItem[]) => {
      const returnedIds = new Set(results.map((item) => item.id));
      return matches.some(({ id, score }) => returnedIds.has(id) && Number.isFinite(score) && score >= backend.floor);
    };
    if (!qualifies(items)) return trace.result([]);
    if (backend.id !== 'vectorize' || !topic) return trace.result(items);

    const prioritized = prioritizeNamedInstrument(ordered, topic);
    if (prioritized === ordered) return trace.result(items);
    const namedItems = statuteItems(prioritized, query);
    return trace.result(qualifies(namedItems) ? namedItems : items);
  } catch (error) {
    observation.decision = 'error';
    throw error;
  } finally { trace.emit(); }
}

function titleWords(text: string): string {
  return normalizeForSearch(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Promote a uniquely named instrument among the existing vector candidates. */
function prioritizeNamedInstrument(rows: Record<string, unknown>[], topic: string): Record<string, unknown>[] {
  const question = ` ${titleWords(topic)} `;
  let namedCitation: string | undefined;
  for (const row of rows) {
    const title = typeof row['act'] === 'string' ? titleWords(row['act']) : '';
    const citation = row['citation'];
    if (typeof citation !== 'string' || !citation || !title.includes(' ') || !question.includes(` ${title} `)) continue;
    if (namedCitation && namedCitation !== citation) return rows;
    namedCitation = citation;
  }
  if (!namedCitation) return rows;

  const named: Record<string, unknown>[] = [];
  const other: Record<string, unknown>[] = [];
  for (const row of rows) (row['citation'] === namedCitation ? named : other).push(row);
  return other.length ? [...named, ...other] : rows;
}

/** Apply the same constraints to both fresh candidates and cached order. */
export function statuteItems(ordered: Record<string, unknown>[], query: CorpusQuery): RawCorpusItem[] {
  const keywords = (query.keywords ?? []).map((keyword) => keyword.trim()).filter(Boolean);
  if ((query.topic ?? '').trim() && keywords.length > 0) {
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
  }
  ordered = ordered.slice(0, resolveLimit(query.limit));

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
      `SELECT id, corpus_id, act, citation, section, status, schedule, part, heading, text, text_hash, source_url, jurisdiction, in_force, topics, language
         FROM statute_sections
        WHERE id IN (${placeholders})`,
      chunk,
    );
    found.push(...rows);
  }
  return ctx.provisionTexts ? ctx.provisionTexts.hydrate(found) : found;
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

  const stored = await loadExactProvisionRows(query.section!, (canonical) => queryRows(
    ctx,
    `SELECT id, corpus_id, act, citation, section, status, schedule, part, heading, text, text_hash, source_url, jurisdiction, in_force, topics, language
       FROM statute_sections
      WHERE act = ? AND section = ?${lang.sql}${canonical}
      ORDER BY in_force DESC, id
      LIMIT ?`,
    [query.act!, query.section!, ...lang.binds, String(resolveLimit(query.limit))],
  ));
  const rows = ctx.provisionTexts ? await ctx.provisionTexts.hydrate(stored) : stored;

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

const HANSARD_COLUMNS = 'id, speaker, party, sitting_date, excerpt, source_url, topics';

function speechFromRow(row: Record<string, unknown>, chamber: HansardChamber): (RawCorpusItem & { excerpt: string }) | undefined {
  const policy = hansardPolicy(chamber);
  const id = String(row['id']);
  const speaker = String(row['speaker']);
  const sittingDate = String(row['sitting_date']);
  const citationUrl = String(row['source_url']);
  const stored = String(row['excerpt']);
  const citation = hansardCitation(citationUrl, chamber);
  if (!id.trim() || !speaker.trim() || !sittingDate.trim() || !stored.trim() || !citation) return undefined;
  const identity = hansardSpeechIdentity(id);
  if (identity ? identity.chamber !== chamber || !citation.hash : chamber === 'senate') return undefined;
  if (chamber === 'senate' && !/^#[0-9]+$/u.test(citation.hash)) return undefined;
  const place = chamber === 'senate'
    ? (identity?.language === 'fr' ? 'au Sénat' : 'in the Senate')
    : (identity?.language === 'fr' ? 'à la Chambre des communes' : 'in the House of Commons');
  return {
    corpusId: policy.id,
    kind: 'debate',
    id,
    title: `${speaker} ${place}`,
    excerpt: truncate(stored, policy.excerptMaxChars),
    citationUrl,
    publishedAt: sittingDate,
    source: policy.publisher,
    language: identity?.language,
    topics: splitTopics(row['topics']),
    extra: {
      speaker, sittingDate, party: row['party'] ? String(row['party']) : undefined,
      ...(identity && { sittingId: identity.sittingId, interventionId: identity.interventionId }),
      ...(chamber === 'senate' && { chamber, citationGranularity: 'section' }),
    },
  };
}

export async function getHansardSpeech(id: string, ctx: CorpusContext): Promise<RawCorpusItem | undefined> {
  const chamber = hansardSpeechIdentity(id)?.chamber ?? 'house';
  const [row] = await queryRows(ctx,
    `SELECT ${HANSARD_COLUMNS} FROM hansard_speeches WHERE corpus_id = ? AND id = ?`,
    [hansardPolicy(chamber).id, id]);
  return row && speechFromRow(row, chamber);
}

function debateCorpus(chamber: HansardChamber): Corpus {
  const policy = hansardPolicy(chamber);
  return {
    id: policy.id,
    policy,
    supports(query) {
      return Boolean(query.topic || (query.keywords && query.keywords.length > 0));
    },
    async retrieve(query: CorpusQuery, ctx: CorpusContext): Promise<RawCorpusItem[]> {
      const terms = normalizedSearchTerms(query).filter(Boolean);
      if (terms.length === 0) return [];
      const { sql: tok, binds: tokBinds } = tokenClause(terms.map((term) => `%${escapeLike(term)}%`));
      const { sql: dates, binds: dateBinds } = dateClause(query, 'sitting_date');
      const language = query.language?.trim().toLowerCase() || undefined;
      if (language !== undefined && language !== 'en' && language !== 'fr') return [];
      const languagePattern = language ? [`${hansardLanguagePrefix(language, chamber)}%`] : [];
      const limit = resolveLimit(query.limit);
      const results: RawCorpusItem[] = [];
      let cursor: string[] = [];

      // The index can match outside the permitted excerpt. Page through those
      // candidates so unusable hits do not consume the caller's result limit.
      while (results.length < limit) {
        const rows = await queryRows(ctx,
          `SELECT ${HANSARD_COLUMNS}
             FROM hansard_speeches
            WHERE corpus_id = ?${tok}${dates}${language ? ' AND id LIKE ?' : ''}${cursor.length ? ' AND (sitting_date, id) < (?, ?)' : ''}
            ORDER BY sitting_date DESC, id DESC
            LIMIT ?`,
          [policy.id, ...tokBinds, ...dateBinds, ...languagePattern, ...cursor, String(limit)],
        );
        for (const row of rows) {
          const speech = speechFromRow(row, chamber);
          if (!speech || (language && speech.language !== language)) continue;
          const stored = String(row['excerpt']);
          const excerpt = speech.excerpt;
          const quoted = normalizeForSearch(excerpt === stored ? excerpt : excerpt.slice(0, -1));
          if (!terms.some((term) => quoted.includes(term))) continue;
          results.push(speech);
          if (results.length === limit) return results;
        }
        if (rows.length < limit) break;
        const last = rows[rows.length - 1]!;
        cursor = [String(last['sitting_date']), String(last['id'])];
      }
      return results;
    },
  };
}

export const hansardCorpus = debateCorpus('house');
export const senateHansardCorpus = debateCorpus('senate');

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
