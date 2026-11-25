-- Observations stage edition deltas privately, then publish all four serving tables in one D1 batch.
CREATE TABLE funding_pending_editions (
  source TEXT NOT NULL,
  candidate TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  id TEXT NOT NULL,
  language TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('added','changed','removed')),
  revision TEXT NOT NULL,
  edition_json TEXT,
  search_text TEXT,
  normalized_sections_json TEXT,
  PRIMARY KEY (source,candidate,id,language)
);
CREATE INDEX funding_pending_observation ON funding_pending_editions(source,observed_at);
CREATE TABLE funding_commit_guard (valid INTEGER NOT NULL CHECK(valid=1));
