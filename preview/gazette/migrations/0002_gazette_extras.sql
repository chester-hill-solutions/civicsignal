PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS gazette_extra_editions (
  part TEXT NOT NULL CHECK (part IN ('I', 'II')),
  language TEXT NOT NULL CHECK (language IN ('en', 'fr')),
  issue_date TEXT NOT NULL,
  volume INTEGER NOT NULL CHECK (volume > 0),
  extra_number INTEGER NOT NULL CHECK (extra_number > 0),
  record_count INTEGER NOT NULL CHECK (record_count > 0),
  content_sha256 TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (part, language, issue_date, volume, extra_number)
);

CREATE TABLE IF NOT EXISTS gazette_extra_records (
  id TEXT PRIMARY KEY,
  edition_type TEXT NOT NULL CHECK (edition_type = 'extra'),
  part TEXT NOT NULL CHECK (part IN ('I', 'II')),
  language TEXT NOT NULL CHECK (language IN ('en', 'fr')),
  issue_date TEXT NOT NULL,
  volume INTEGER NOT NULL CHECK (volume > 0),
  extra_number INTEGER NOT NULL CHECK (extra_number > 0),
  kind TEXT NOT NULL CHECK (kind IN ('notice', 'proposal', 'instrument')),
  title TEXT NOT NULL,
  citation_url TEXT NOT NULL,
  registration_number TEXT,
  registration_date TEXT,
  consultation_deadline TEXT,
  effective_date TEXT,
  search_text TEXT NOT NULL,
  FOREIGN KEY (part, language, issue_date, volume, extra_number)
    REFERENCES gazette_extra_editions (part, language, issue_date, volume, extra_number)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS gazette_extra_editions_date_idx
  ON gazette_extra_editions (part, language, issue_date, volume, extra_number);
CREATE INDEX IF NOT EXISTS gazette_extra_records_search_idx ON gazette_extra_records (language, search_text);
CREATE INDEX IF NOT EXISTS gazette_extra_records_issue_idx
  ON gazette_extra_records (part, language, issue_date, volume, extra_number);
