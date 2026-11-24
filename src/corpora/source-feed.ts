export type FeedSource = 'gazette' | 'house' | 'senate';
export type FeedChangeKind = 'added' | 'corrected' | 'removed';

export interface FeedScope {
  source: FeedSource;
  language: 'en' | 'fr';
  editionId: string;
  publicationDate: string;
  part?: 'I' | 'II';
}

/** Edition stores project only searchable metadata and permitted Hansard excerpts. */
export interface FeedRecord {
  id: string;
  citationUrl: string;
  publicationDate: string;
  label: string;
  searchText: string;
  fingerprint: string;
}
