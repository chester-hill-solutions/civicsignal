-- Dedicated staging D1. The API reads the catalogue, record view and revision history.
CREATE TABLE consultations_catalogues (
  source TEXT PRIMARY KEY CHECK (source='canada'),
  observed_at TEXT NOT NULL,
  revision TEXT NOT NULL,
  csv_sha256 TEXT NOT NULL,
  schema_sha256 TEXT NOT NULL,
  csv_source_json TEXT NOT NULL,
  schema_source_json TEXT NOT NULL,
  record_count INTEGER NOT NULL
);

CREATE TABLE consultation_items (
  id TEXT PRIMARY KEY,
  published_hash TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  search_en TEXT NOT NULL,
  search_fr TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  removed_at TEXT,
  last_seen_before_removal TEXT,
  owner_org TEXT GENERATED ALWAYS AS (json_extract(facts_json,'$.ownerOrg')) VIRTUAL,
  start_date TEXT GENERATED ALWAYS AS (json_extract(facts_json,'$.dates.start')) VIRTUAL,
  end_date TEXT GENERATED ALWAYS AS (json_extract(facts_json,'$.dates.end')) VIRTUAL
);
CREATE INDEX consultation_items_by_owner ON consultation_items(owner_org,start_date,id);

-- Observing identical source bytes advances lastObservedAt and date-derived state
-- for the entire active catalogue with a single metadata write.
CREATE VIEW consultations_records AS
WITH dated AS (
  SELECT i.*, COALESCE(i.last_seen_before_removal,c.observed_at) AS observed_at
  FROM consultation_items i CROSS JOIN consultations_catalogues c
), states AS (
  SELECT *, CASE
    WHEN start_date IS NULL OR end_date IS NULL THEN 'unknown'
    WHEN substr(observed_at,1,10)<start_date THEN 'planned'
    WHEN substr(observed_at,1,10)>end_date THEN 'closed'
    ELSE 'open' END AS state_at_observation,
    json_extract(facts_json,'$.statusCode') AS status_code
  FROM dated
)
SELECT id,owner_org,json_extract(facts_json,'$.registrationNumber') AS registration_number,
  status_code,start_date,end_date,state_at_observation,
  json_extract(facts_json,'$.reportAvailableOnline') AS report_available,
  observed_at,first_observed_at,revision,
  json_set(facts_json,'$.stateAtObservation',state_at_observation,'$.statusAgreesWithDates',
    json(CASE WHEN status_code NOT IN ('O','P','C') THEN 'null'
      WHEN (status_code='O' AND state_at_observation='open') OR
           (status_code='P' AND state_at_observation='planned') OR
           (status_code='C' AND state_at_observation='closed') THEN 'true'
      ELSE 'false' END)) AS facts_json,
  search_en,search_fr,removed_at
FROM states;

CREATE TABLE consultations_revisions (
  id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  event TEXT NOT NULL,
  changed_fields_json TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  PRIMARY KEY(id,observed_at)
);

-- Staged deltas are invisible to all serving queries until the final D1 batch commits.
CREATE TABLE consultation_pending (
  candidate TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  id TEXT NOT NULL,
  event TEXT NOT NULL,
  published_hash TEXT,
  facts_json TEXT,
  search_en TEXT,
  search_fr TEXT,
  changed_fields_json TEXT NOT NULL,
  PRIMARY KEY(candidate,id)
);
CREATE INDEX consultation_pending_by_time ON consultation_pending(observed_at);
CREATE TABLE consultation_commit_guard (valid INTEGER NOT NULL CHECK(valid=1));
