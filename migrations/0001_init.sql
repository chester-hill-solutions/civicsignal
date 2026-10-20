-- CivicSignal corpus store.
--
-- One table per corpus. Each carries `search_text`, a lowercased token bag used for
-- topic matching, and `corpus_id`, so a query can fan out across corpora without
-- knowing which table a row came from.

CREATE TABLE IF NOT EXISTS statute_sections (
  id           TEXT PRIMARY KEY,
  corpus_id    TEXT NOT NULL,
  act          TEXT NOT NULL,
  section      TEXT NOT NULL,
  heading      TEXT,
  text         TEXT NOT NULL,
  source_url   TEXT NOT NULL,
  jurisdiction TEXT,
  in_force     INTEGER NOT NULL DEFAULT 1,
  topics       TEXT,
  search_text  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_statute_sections_search ON statute_sections (search_text);
CREATE INDEX IF NOT EXISTS idx_statute_sections_jur ON statute_sections (jurisdiction);

CREATE TABLE IF NOT EXISTS hansard_speeches (
  id          TEXT PRIMARY KEY,
  corpus_id   TEXT NOT NULL,
  speaker     TEXT NOT NULL,
  party       TEXT,
  sitting_date TEXT NOT NULL,
  -- Only a short excerpt is ever stored. The full speech is not ingested, because
  -- Crown copyright permits citation, not republication.
  excerpt     TEXT NOT NULL,
  source_url  TEXT NOT NULL,
  topics      TEXT,
  search_text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hansard_search ON hansard_speeches (search_text);
CREATE INDEX IF NOT EXISTS idx_hansard_date ON hansard_speeches (sitting_date);

CREATE TABLE IF NOT EXISTS news_items (
  id           TEXT PRIMARY KEY,
  corpus_id    TEXT NOT NULL,
  title        TEXT NOT NULL,
  outlet       TEXT NOT NULL,
  published_at TEXT NOT NULL,
  url          TEXT NOT NULL,
  jurisdiction TEXT,
  -- Riding code, when the wire can attribute the item geographically. Null until the
  -- geography join lands; the spread section reports its own coverage.
  riding       TEXT,
  topics       TEXT,
  search_text  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_search ON news_items (search_text);
CREATE INDEX IF NOT EXISTS idx_news_published ON news_items (published_at);
CREATE INDEX IF NOT EXISTS idx_news_riding ON news_items (riding);
CREATE INDEX IF NOT EXISTS idx_news_jur ON news_items (jurisdiction);

CREATE TABLE IF NOT EXISTS gdelt_events (
  id           TEXT PRIMARY KEY,
  corpus_id    TEXT NOT NULL,
  title        TEXT NOT NULL,
  url          TEXT NOT NULL,
  published_at TEXT NOT NULL,
  tone         REAL,
  country      TEXT,
  topics       TEXT,
  search_text  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gdelt_search ON gdelt_events (search_text);
CREATE INDEX IF NOT EXISTS idx_gdelt_published ON gdelt_events (published_at);

CREATE TABLE IF NOT EXISTS bills (
  id           TEXT PRIMARY KEY,
  corpus_id    TEXT NOT NULL,
  number       TEXT NOT NULL,
  title        TEXT NOT NULL,
  sponsor      TEXT,
  stage        TEXT,
  introduced_at TEXT,
  source_url   TEXT NOT NULL,
  jurisdiction TEXT,
  topics       TEXT,
  search_text  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bills_search ON bills (search_text);
