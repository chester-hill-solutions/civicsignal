-- A committed row and its change event always have a durable vector operation.
-- Keep completed identities: retries of the same revision must not duplicate feed.
CREATE TABLE corpus_mutations (
  id TEXT PRIMARY KEY,
  corpus_id TEXT NOT NULL,
  payload TEXT,
  completed_at TEXT
);
CREATE INDEX idx_corpus_mutations_pending ON corpus_mutations(corpus_id, id)
  WHERE payload IS NOT NULL;
