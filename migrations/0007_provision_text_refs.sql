-- Prepare R2 text hydration while the existing D1 text remains the rollback.
-- No corpus text or lexical column is removed by this additive migration.
CREATE TABLE IF NOT EXISTS statute_text_refs (
  row_id TEXT PRIMARY KEY NOT NULL,
  corpus_id TEXT NOT NULL,
  row_fingerprint TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  object_key TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes >= 0),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS statute_text_refs_corpus_row ON statute_text_refs(corpus_id,row_id);
