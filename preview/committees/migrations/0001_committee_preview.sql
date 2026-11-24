-- Isolated local/preview committee corpus. Keep this separate from bounded
-- production D1 tables until the committee APIs and delivery policies land.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cc_records (
  session TEXT NOT NULL,
  id TEXT NOT NULL,
  language TEXT NOT NULL,
  kind TEXT NOT NULL,
  chamber TEXT,
  committee_id TEXT,
  title TEXT,
  url TEXT,
  status TEXT,
  metadata_json TEXT NOT NULL,
  object_sha256 TEXT,
  PRIMARY KEY (session, id, language)
);
CREATE INDEX IF NOT EXISTS cc_records_session_language_committee_kind
  ON cc_records(session, language, committee_id, kind);
CREATE INDEX IF NOT EXISTS cc_records_session_language_chamber_kind
  ON cc_records(session, language, chamber, kind);

CREATE TABLE IF NOT EXISTS cc_links (
  session TEXT NOT NULL,
  language TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (session, language, parent_id, child_id, relation)
);
CREATE INDEX IF NOT EXISTS cc_links_session_language_child
  ON cc_links(session, language, child_id);

CREATE TABLE IF NOT EXISTS cc_passages (
  session TEXT NOT NULL,
  language TEXT NOT NULL,
  document_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  location TEXT,
  text TEXT NOT NULL,
  speaker TEXT,
  affiliation TEXT,
  PRIMARY KEY (session, language, document_id, position)
);

CREATE VIRTUAL TABLE IF NOT EXISTS cc_fts USING fts5(
  session UNINDEXED,
  language UNINDEXED,
  document_id UNINDEXED,
  position UNINDEXED,
  text,
  content='cc_passages', content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS cc_snapshot (
  session TEXT PRIMARY KEY,
  cutoff TEXT NOT NULL
);

-- Record signatures and change events belong to the store, not to a full rebuild:
-- an incremental intake (calls, refreshed records) must run on a fresh database.
CREATE TABLE IF NOT EXISTS cc_revision (
  session TEXT, id TEXT, language TEXT, signature TEXT,
  PRIMARY KEY (session, id, language)
);
CREATE TABLE IF NOT EXISTS cc_changes (
  seq INTEGER PRIMARY KEY, session TEXT, id TEXT, language TEXT, signature TEXT
);
CREATE TABLE IF NOT EXISTS cc_link_changes (
  seq INTEGER PRIMARY KEY, session TEXT, language TEXT, parent_id TEXT, child_id TEXT,
  relation TEXT, change TEXT
);
CREATE TABLE IF NOT EXISTS cc_extracted (
  session TEXT, id TEXT, language TEXT, digest TEXT, version TEXT, status TEXT, reason TEXT,
  PRIMARY KEY (session, id, language)
);
