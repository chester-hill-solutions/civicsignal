import {
  billsCorpus,
  gdeltCorpus,
  hansardCorpus,
  newsCorpus,
  statutesCorpus,
} from './adapters';
import type { Corpus, CorpusAvailabilityMap, CorpusContext, CorpusQuery } from './types';

/**
 * The corpus registry.
 *
 * One place that knows which corpora exist and which section of a brief each one
 * answers. Routes, the MCP surface and the ingest jobs all read from here, so a new
 * corpus is added in one place rather than three.
 */
export const ALL_CORPUSES: Corpus[] = [
  statutesCorpus,
  hansardCorpus,
  newsCorpus,
  gdeltCorpus,
  billsCorpus,
];

/** Only federal statutes have an implemented v1 ingestion path. */
export const CORPUSES: Corpus[] = [statutesCorpus];

export const CORPUSES_BY_ID: Map<string, Corpus> = new Map(CORPUSES.map((c) => [c.id, c]));

export class UnsupportedCoverageError extends Error {
  readonly code = 'UNSUPPORTED_COVERAGE';
  readonly status = 501;
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedCoverageError';
  }
}

export function assertV1Geography(query: CorpusQuery): void {
  if (query.riding || (query.scope && query.scope.type !== 'topic' &&
      !(query.scope.type === 'jurisdiction' && query.scope.code.toUpperCase() === 'CA')) ||
      (query.jurisdiction && query.jurisdiction.toUpperCase() !== 'CA')) {
    throw new UnsupportedCoverageError('v1 covers Canadian federal statutes. Provincial, riding, municipality and region filters are unavailable.');
  }
}

export function assertV1StatuteQuery(query: CorpusQuery): void {
  assertV1Geography(query);
  if (query.since || query.until) {
    throw new UnsupportedCoverageError('Statute retrieval searches the current published corpus. Use /api/changes for a dated change feed.');
  }
}

/** Read publication metadata, rather than treating an empty adapter result as readiness. */
export async function loadCorpusAvailability(ctx: CorpusContext): Promise<CorpusAvailabilityMap> {
  if (ctx.corpusAvailability) return await ctx.corpusAvailability;
  const unavailable: CorpusAvailabilityMap = Object.fromEntries(ALL_CORPUSES.map((corpus) => [corpus.id, {
    available: false,
    reason: corpus.id === statutesCorpus.id ? 'The corpus database is not configured.' : 'No production ingestion is available for this corpus in v1.',
  }]));
  if (!ctx.db) return unavailable;
  try {
    const result = await ctx.db.prepare(
      'SELECT corpus_id, row_count, commit_sha, parser_version, as_of, last_run_at FROM corpus_state WHERE corpus_id = ?',
    ).bind(statutesCorpus.id).all<Record<string, unknown>>();
    const row = result.results?.find((value) => value['corpus_id'] === statutesCorpus.id);
    const rowCount = Number(row?.['row_count']);
    unavailable[statutesCorpus.id] = row && Number.isSafeInteger(rowCount) && rowCount > 0
      ? { available: true, reason: 'A non-empty federal statute revision is published.', rowCount,
          revision: String(row['commit_sha']), parserVersion: row['parser_version'] == null ? 'legacy' : String(row['parser_version']),
          asOf: String(row['as_of']), lastRunAt: String(row['last_run_at']) }
      : { available: false, reason: 'No non-empty federal statute revision is published.', rowCount: 0 };
  } catch {
    unavailable[statutesCorpus.id] = { available: false, reason: 'Corpus publication metadata could not be read.' };
  }
  return unavailable;
}

/** Which corpora answer which part of a brief. */
export const BRIEF_SECTIONS: { key: string; corpusIds: string[] }[] = [
  { key: 'news', corpusIds: [newsCorpus.id, gdeltCorpus.id] },
  { key: 'debate', corpusIds: [hansardCorpus.id] },
  { key: 'legislation', corpusIds: [statutesCorpus.id] },
  { key: 'bills', corpusIds: [billsCorpus.id] },
];
