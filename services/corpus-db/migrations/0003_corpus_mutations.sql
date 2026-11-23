-- PostgreSQL commits row, vector, event and idempotency identity together.
CREATE TABLE IF NOT EXISTS corpus_mutations (
  id TEXT PRIMARY KEY,
  corpus_id TEXT NOT NULL,
  payload JSONB,
  completed_at TIMESTAMPTZ
);
