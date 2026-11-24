-- Inventory and originals for the departmental publications preview.
-- Slice 1: the four ECCC indexes, the works and editions they list, and the
-- archived component documents. Passage extraction and search arrive in 0002.

CREATE TABLE IF NOT EXISTS dp_indexes (
  url TEXT PRIMARY KEY,
  series TEXT NOT NULL,
  language TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dp_works (
  id TEXT PRIMARY KEY,
  series TEXT NOT NULL,
  title_en TEXT,
  title_fr TEXT,
  lead_en TEXT,
  lead_fr TEXT,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  revision INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dp_editions (
  work_id TEXT NOT NULL,
  language TEXT NOT NULL,
  fiscal_year TEXT NOT NULL,
  title TEXT NOT NULL,
  lead TEXT,
  index_url TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  PRIMARY KEY (work_id, language)
);

CREATE TABLE IF NOT EXISTS dp_documents (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  language TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  final_url TEXT,
  sha256 TEXT,
  content_sha256 TEXT,
  media TEXT,
  bytes INTEGER,
  status TEXT NOT NULL,
  fetched_at TEXT,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dp_documents_work ON dp_documents(work_id, language, kind);

-- `sha256` identifies the archived bytes; `content_sha256` ignores volatile
-- publisher decoration (analytics scripts, styles) and drives version history.
CREATE TABLE IF NOT EXISTS dp_document_versions (
  document_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  media TEXT,
  bytes INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (document_id, content_sha256)
);

CREATE TABLE IF NOT EXISTS dp_changes (
  seq INTEGER PRIMARY KEY,
  work_id TEXT,
  document_id TEXT,
  change TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dp_gaps (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  series TEXT,
  language TEXT,
  url TEXT,
  reason TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dp_inventory (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  cutoff TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  revision TEXT NOT NULL,
  counts_json TEXT NOT NULL
);
