-- Searchable documents named by a reciprocal publisher language alternate,
-- even when the department index has not published the opposite edition.
-- These rows never alter raw index membership or dp_editions.
CREATE TABLE IF NOT EXISTS dp_alternate_documents (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  series TEXT NOT NULL,
  source_language TEXT NOT NULL,
  source_fiscal_year TEXT NOT NULL,
  language TEXT NOT NULL,
  kind TEXT NOT NULL,
  origin_label TEXT NOT NULL,
  origin_url TEXT NOT NULL,
  origin_sha256 TEXT NOT NULL,
  hreflang TEXT NOT NULL,
  url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  media TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  html_lang TEXT NOT NULL,
  title TEXT NOT NULL,
  heading TEXT NOT NULL,
  identity_method TEXT NOT NULL,
  status TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(work_id, language, url)
);
CREATE INDEX IF NOT EXISTS dp_alternate_documents_work
  ON dp_alternate_documents(work_id, language, status);
