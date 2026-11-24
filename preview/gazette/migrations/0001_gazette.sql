PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS gazette_editions (
  part TEXT NOT NULL CHECK (part IN ('I', 'II')),
  language TEXT NOT NULL CHECK (language IN ('en', 'fr')),
  issue_date TEXT NOT NULL,
  volume INTEGER NOT NULL CHECK (volume > 0),
  issue_number INTEGER NOT NULL CHECK (issue_number > 0),
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  content_sha256 TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (part, language, issue_date, volume, issue_number)
);

CREATE TABLE IF NOT EXISTS gazette_notices (
  id TEXT PRIMARY KEY,
  part TEXT NOT NULL CHECK (part = 'I'),
  language TEXT NOT NULL CHECK (language IN ('en', 'fr')),
  issue_date TEXT NOT NULL,
  volume INTEGER NOT NULL CHECK (volume > 0),
  issue_number INTEGER NOT NULL CHECK (issue_number > 0),
  kind TEXT NOT NULL CHECK (kind IN ('notice', 'proposal')),
  title TEXT NOT NULL,
  citation_url TEXT NOT NULL,
  registration_number TEXT,
  registration_date TEXT,
  consultation_deadline TEXT,
  effective_date TEXT,
  search_text TEXT NOT NULL,
  FOREIGN KEY (part, language, issue_date, volume, issue_number)
    REFERENCES gazette_editions (part, language, issue_date, volume, issue_number)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gazette_instruments (
  id TEXT PRIMARY KEY,
  part TEXT NOT NULL CHECK (part = 'II'),
  language TEXT NOT NULL CHECK (language IN ('en', 'fr')),
  issue_date TEXT NOT NULL,
  volume INTEGER NOT NULL CHECK (volume > 0),
  issue_number INTEGER NOT NULL CHECK (issue_number > 0),
  kind TEXT NOT NULL CHECK (kind = 'instrument'),
  title TEXT NOT NULL,
  citation_url TEXT NOT NULL,
  registration_number TEXT,
  registration_date TEXT,
  consultation_deadline TEXT,
  effective_date TEXT,
  search_text TEXT NOT NULL,
  FOREIGN KEY (part, language, issue_date, volume, issue_number)
    REFERENCES gazette_editions (part, language, issue_date, volume, issue_number)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS gazette_notices_issue_idx
  ON gazette_notices (part, language, issue_date, volume, issue_number);
CREATE INDEX IF NOT EXISTS gazette_notices_search_idx ON gazette_notices (language, search_text);
CREATE INDEX IF NOT EXISTS gazette_instruments_issue_idx
  ON gazette_instruments (part, language, issue_date, volume, issue_number);
CREATE INDEX IF NOT EXISTS gazette_instruments_search_idx ON gazette_instruments (language, search_text);

CREATE VIEW IF NOT EXISTS gazette_records AS
  SELECT * FROM gazette_notices
  UNION ALL
  SELECT * FROM gazette_instruments;
