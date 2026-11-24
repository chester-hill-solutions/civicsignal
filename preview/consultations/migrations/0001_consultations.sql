CREATE TABLE IF NOT EXISTS consultations_catalogues (
  source TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL,
  revision TEXT NOT NULL,
  csv_sha256 TEXT NOT NULL,
  schema_sha256 TEXT NOT NULL,
  csv_source_json TEXT NOT NULL,
  schema_source_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS consultations_records (
  id TEXT PRIMARY KEY,
  owner_org TEXT NOT NULL,
  registration_number TEXT NOT NULL,
  status_code TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  state_at_observation TEXT NOT NULL,
  report_available INTEGER,
  observed_at TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  facts_json TEXT NOT NULL,
  search_en TEXT NOT NULL,
  search_fr TEXT NOT NULL,
  removed_at TEXT
);
CREATE INDEX IF NOT EXISTS consultations_by_state ON consultations_records(state_at_observation, start_date, id);
CREATE INDEX IF NOT EXISTS consultations_by_institution ON consultations_records(owner_org, start_date, id);
CREATE TABLE IF NOT EXISTS consultations_revisions (
  id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  event TEXT NOT NULL,
  changed_fields_json TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  PRIMARY KEY (id, observed_at)
);
