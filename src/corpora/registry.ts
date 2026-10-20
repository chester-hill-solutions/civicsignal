import {
  billsCorpus,
  gdeltCorpus,
  hansardCorpus,
  newsCorpus,
  statutesCorpus,
} from './adapters';
import type { Corpus } from './types';

/**
 * The corpus registry.
 *
 * One place that knows which corpora exist and which section of a brief each one
 * answers. Routes, the MCP surface and the ingest jobs all read from here, so a new
 * corpus is added in one place rather than three.
 */
export const CORPUSES: Corpus[] = [
  statutesCorpus,
  hansardCorpus,
  newsCorpus,
  gdeltCorpus,
  billsCorpus,
];

export const CORPUSES_BY_ID: Map<string, Corpus> = new Map(CORPUSES.map((c) => [c.id, c]));

/** Which corpora answer which part of a brief. */
export const BRIEF_SECTIONS: { key: string; corpusIds: string[] }[] = [
  { key: 'news', corpusIds: [newsCorpus.id, gdeltCorpus.id] },
  { key: 'debate', corpusIds: [hansardCorpus.id] },
  { key: 'legislation', corpusIds: [statutesCorpus.id] },
  { key: 'bills', corpusIds: [billsCorpus.id] },
];
