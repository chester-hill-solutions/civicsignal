CREATE TABLE IF NOT EXISTS wq_sessions (
  session TEXT PRIMARY KEY,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json))
);

CREATE TABLE IF NOT EXISTS questions (
  session TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number > 0),
  language TEXT NOT NULL CHECK (language IN ('en', 'fr')),
  url TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  member_id TEXT,
  member_name TEXT,
  asked_on TEXT,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  content_hash TEXT CHECK (content_hash IS NULL OR length(content_hash) = 64),
  acquisition TEXT NOT NULL DEFAULT 'pending' CHECK (acquisition IN ('pending', 'complete', 'gap')),
  error TEXT,
  last_checked TEXT,
  PRIMARY KEY (session, number, language)
);
CREATE INDEX IF NOT EXISTS idx_wq_questions_member ON questions(language, member_id, session, number);

CREATE TABLE IF NOT EXISTS documents (
  session TEXT NOT NULL,
  number INTEGER NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en', 'fr')),
  doc_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'cover_page', 'attachment')),
  respondent TEXT,
  title TEXT,
  url TEXT NOT NULL,
  text TEXT NOT NULL,
  text_chars INTEGER NOT NULL CHECK (text_chars >= 0),
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
  object_sha256 TEXT CHECK (object_sha256 IS NULL OR length(object_sha256) = 64),
  availability TEXT NOT NULL CHECK (availability IN ('searchable', 'stored', 'gap')),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  PRIMARY KEY (session, number, language, doc_key),
  FOREIGN KEY (session, number, language) REFERENCES questions(session, number, language) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_wq_documents_respondent ON documents(language, respondent, session, number);

CREATE TABLE IF NOT EXISTS document_chunks (
  session TEXT NOT NULL,
  number INTEGER NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en', 'fr')),
  doc_key TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  text TEXT NOT NULL CHECK (length(text) <= 8192),
  search_text TEXT NOT NULL CHECK (length(search_text) <= 8256),
  PRIMARY KEY (session, number, language, doc_key, chunk_index),
  FOREIGN KEY (session, number, language, doc_key) REFERENCES documents(session, number, language, doc_key) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS wq_fts USING fts5(
  session UNINDEXED,
  number UNINDEXED,
  language UNINDEXED,
  doc_key UNINDEXED,
  chunk_index UNINDEXED,
  text
);

CREATE TABLE IF NOT EXISTS wq_materialization_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  question_count INTEGER NOT NULL CHECK (question_count >= 0),
  document_count INTEGER NOT NULL CHECK (document_count >= 0),
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
  indexed_passage_count INTEGER NOT NULL CHECK (indexed_passage_count >= 0),
  completed_at TEXT NOT NULL
);
