import type { ChangeFeedEntry, CorpusBatch, RemovedRow } from './pipeline';

/** Identifies a row change independently of invocation or batch boundaries. */
export function mutationId(batch: Pick<CorpusBatch, 'corpusId' | 'revision'>, rowId: string, hash: string): string {
  return JSON.stringify([batch.corpusId, batch.revision, rowId, hash]);
}

export function removalFeedEntry(batch: Pick<CorpusBatch, 'corpusId' | 'occurredAt'>, row: RemovedRow): ChangeFeedEntry {
  return {
    corpusId: batch.corpusId, change: 'removed', rowId: row.id,
    instrument: row.instrument, citation: row.citation, section: row.section,
    heading: row.heading, status: row.status, summary: row.heading,
    sourceUrl: row.sourceUrl, occurredAt: batch.occurredAt,
  };
}
