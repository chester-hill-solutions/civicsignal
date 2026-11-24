CREATE TABLE IF NOT EXISTS source_feed_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  journal_id TEXT NOT NULL
);
INSERT OR IGNORE INTO source_feed_identity VALUES (1, lower(hex(randomblob(16))));

CREATE TABLE IF NOT EXISTS source_feed_editions (
  source TEXT NOT NULL CHECK (source IN ('gazette', 'house', 'senate')),
  language TEXT NOT NULL CHECK (language IN ('en', 'fr')),
  edition_id TEXT NOT NULL,
  part TEXT,
  publication_date TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  CHECK ((source = 'gazette' AND part IS NOT NULL AND part IN ('I', 'II'))
    OR (source IN ('house', 'senate') AND part IS NULL)),
  PRIMARY KEY (source, language, edition_id)
);

CREATE TABLE IF NOT EXISTS source_feed_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  language TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  part TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('added', 'corrected', 'removed')),
  record_id TEXT NOT NULL,
  publication_date TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  citation_url TEXT NOT NULL,
  label TEXT NOT NULL,
  before_search TEXT,
  after_search TEXT,
  FOREIGN KEY (source, language, edition_id)
    REFERENCES source_feed_editions(source, language, edition_id)
);
CREATE INDEX IF NOT EXISTS source_feed_scope_sequence ON source_feed_events(source, language, seq);
