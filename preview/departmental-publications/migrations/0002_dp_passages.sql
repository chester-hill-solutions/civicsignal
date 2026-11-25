-- Searchable extracted text for the local departmental-publications serving DB.
CREATE TABLE IF NOT EXISTS dp_passages (
  passage_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  language TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  section TEXT,
  page INTEGER,
  table_number INTEGER,
  table_caption TEXT,
  row_number INTEGER,
  column_number INTEGER,
  attribution TEXT,
  citation_url TEXT NOT NULL,
  text TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  UNIQUE(document_id, content_sha256, ordinal)
);
CREATE INDEX IF NOT EXISTS dp_passages_work_language ON dp_passages(work_id, language, document_id);
CREATE INDEX IF NOT EXISTS dp_passages_document ON dp_passages(document_id, ordinal);
CREATE VIRTUAL TABLE IF NOT EXISTS dp_passages_fts USING fts5(
  text, section, table_caption, attribution, content='dp_passages', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS dp_extraction_runs (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  built_at TEXT NOT NULL,
  catalogue_cutoff TEXT,
  documents_seen INTEGER NOT NULL,
  documents_extracted INTEGER NOT NULL,
  passages INTEGER NOT NULL,
  gaps_json TEXT NOT NULL
);
