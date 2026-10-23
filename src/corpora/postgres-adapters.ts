/**
 * Postgres remains a portability implementation. Storage mapping differs; the
 * candidate, authority, keyword and cache decision pipeline is shared with the
 * production Worker. pgvector returns cosine similarity while Vectorize uses
 * its measured compressed scale, so their fallback thresholds differ.
 */
import type { RawCorpusItem } from '@chester-hill-solutions/corpus';
import { STATUTES_CANADA } from './policies';
import { retrieveStatutesByVector, statuteItems } from './adapters';
import { resolveLimit, type Corpus, type CorpusContext, type CorpusQuery } from './types';
import { retrievalTrace } from './retrieval-observation';

/** Historical local-cosine calibration; fresh held-out calibration is still required. */
export const POSTGRES_VECTOR_FLOOR = 0.81;

function normalizedRow(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, act: row['instrument'], in_force: row['in_force'] === true || row['in_force'] === 1 ? 1 : 0 };
}

const COLUMNS = 'id, corpus_id, instrument, citation, section, status, heading, text, source_url, jurisdiction, in_force, topics, language';

async function queryRows(ctx: CorpusContext, sql: string, binds: unknown[]): Promise<Record<string, unknown>[]> {
  if (!ctx.db) return [];
  const result = await ctx.db.prepare(sql).bind(...binds).all<Record<string, unknown>>();
  return (result.results ?? []).map(normalizedRow);
}

async function rowsById(ctx: CorpusContext, ids: string[]): Promise<Record<string, unknown>[]> {
  if (!ids.length) return [];
  return queryRows(ctx, `SELECT ${COLUMNS} FROM statute_provisions WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
}

async function retrieveProvision(query: CorpusQuery, ctx: CorpusContext): Promise<RawCorpusItem[]> {
  const language = query.language ? ' AND language = ?' : '';
  const rows = await queryRows(ctx, `SELECT ${COLUMNS} FROM statute_provisions
    WHERE instrument = ? AND section = ?${language} ORDER BY in_force DESC, id LIMIT ?`,
    [query.act!, query.section!, ...(query.language ? [query.language.toLowerCase()] : []), resolveLimit(query.limit)]);
  return statuteItems(rows, { limit: query.limit });
}

export const postgresStatutesCorpus: Corpus = {
  id: STATUTES_CANADA.id,
  policy: STATUTES_CANADA,
  supports(query) {
    return Boolean((query.act && query.section) || query.topic || query.keywords?.length);
  },
  async retrieve(query: CorpusQuery, ctx: CorpusContext) {
    if (query.act && query.section) {
      const trace = await retrievalTrace(ctx, query, 'postgres-cosine', 'exact', null);
      try { return trace.result(await trace.provider('rows', () => retrieveProvision(query, ctx))); }
      catch (error) { trace.observation.decision = 'error'; throw error; }
      finally { trace.emit(); }
    }
    // An authority refusal or a weak nearest neighbour must not be turned into
    // an answer by a second lexical search. A missing backend is unavailable.
    return (await retrieveStatutesByVector(query, ctx, {
      id: 'postgres-cosine', floor: POSTGRES_VECTOR_FLOOR, loadRows: rowsById,
    })) ?? [];
  },
};
