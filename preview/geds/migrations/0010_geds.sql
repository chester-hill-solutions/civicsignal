-- GEDS: the Government Electronic Directory Services directory.
--
-- The official export is a flat CSV: one row per published listing. It carries no
-- employee identifier, so the directory's identifiers are derived from the facts
-- the publisher does publish (see docs/GEDS.md). The tables here preserve the
-- **published** record, not a cleaned-up version of it:
--
--   * `geds_organizations` is versioned, because a unit can be renamed or moved
--     without becoming a different unit;
--   * `geds_roles` is versioned, because a person can change title or telephone
--     without becoming a different listing;
--   * `geds_persons` is the identity map that survives a move between units;
--   * `geds_snapshots` is the publication boundary. A snapshot is built with a
--     sequence that readers cannot see until the row's status flips to
--     `published`, so an interrupted refresh leaves the previous snapshot
--     readable and a resume can continue from `last_row_no`.
--
-- `valid_from_seq`/`valid_to_seq` are snapshot sequences, not dates. A reader
-- resolves `asOf` to one published snapshot and then asks for the versions that
-- were current at that snapshot. That is what makes an earlier role remain
-- recoverable after the person moves.

CREATE TABLE IF NOT EXISTS geds_snapshots (
  seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id         TEXT NOT NULL UNIQUE,
  observation_id      TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'building'
                        CHECK (status IN ('building', 'published', 'failed', 'discarded')),
  effective_at        TEXT NOT NULL,
  published_at        TEXT,
  source_date         TEXT,
  source_url          TEXT NOT NULL,
  dataset_id          TEXT NOT NULL,
  resource_id         TEXT,
  zip_sha256          TEXT NOT NULL,
  csv_sha256          TEXT NOT NULL DEFAULT '',
  archive_key         TEXT,
  previous_seq        INTEGER,
  row_count           INTEGER NOT NULL DEFAULT 0,
  person_count        INTEGER NOT NULL DEFAULT 0,
  organization_count  INTEGER NOT NULL DEFAULT 0,
  role_count          INTEGER NOT NULL DEFAULT 0,
  language_en_count   INTEGER NOT NULL DEFAULT 0,
  language_fr_count   INTEGER NOT NULL DEFAULT 0,
  missing_contact_count INTEGER NOT NULL DEFAULT 0,
  unresolved_count    INTEGER NOT NULL DEFAULT 0,
  manifest_key        TEXT,
  last_row_no         INTEGER NOT NULL DEFAULT 0,
  error               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_geds_snapshots_status ON geds_snapshots (status, seq);
CREATE INDEX IF NOT EXISTS idx_geds_snapshots_effective ON geds_snapshots (effective_at);

-- One observation is one trip to the official URL. It is recorded even when the
-- bytes are unchanged: "we looked and it had not moved" is a fact the receipt
-- needs. The archive key is content-addressed, so the same bytes are archived
-- once.
CREATE TABLE IF NOT EXISTS geds_observations (
  observation_id   TEXT PRIMARY KEY,
  dataset_id       TEXT NOT NULL,
  resource_id      TEXT,
  source_url       TEXT NOT NULL,
  fetched_at       TEXT NOT NULL,
  source_date      TEXT,
  etag             TEXT,
  content_length   INTEGER,
  original_format  TEXT NOT NULL DEFAULT 'zip',
  original_name    TEXT,
  zip_sha256       TEXT NOT NULL,
  csv_sha256       TEXT NOT NULL DEFAULT '',
  archive_key      TEXT,
  archive_url      TEXT,
  changed          INTEGER NOT NULL DEFAULT 0,
  snapshot_id      TEXT,
  note             TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_geds_observations_fetched ON geds_observations (fetched_at);
CREATE INDEX IF NOT EXISTS idx_geds_observations_hash ON geds_observations (zip_sha256);

-- The identity map. A person is a natural key (an email, or a direct line, or a
-- name plus the unit that publishes it), not a row number. `first_seen_seq` and
-- `last_seen_seq` are diagnostic: the role versions carry the published name so
-- a historical read does not relabel an old role with today's spelling.
CREATE TABLE IF NOT EXISTS geds_persons (
  person_id       TEXT PRIMARY KEY,
  person_key      TEXT NOT NULL UNIQUE,
  first_seen_seq  INTEGER NOT NULL,
  last_seen_seq   INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_geds_persons_last_seen ON geds_persons (last_seen_seq);

-- An organization node. `org_id` is the structural identity: the department
-- acronym plus the chain of DN tokens from the root. The display names and the
-- parent are versioned because a renaming is not a new unit.
CREATE TABLE IF NOT EXISTS geds_organizations (
  org_id              TEXT NOT NULL,
  org_key             TEXT NOT NULL,
  valid_from_seq      INTEGER NOT NULL,
  valid_to_seq        INTEGER,
  last_seen_seq       INTEGER NOT NULL DEFAULT 0,
  department_acronym  TEXT NOT NULL,
  department_name_en  TEXT,
  department_name_fr  TEXT,
  name_en             TEXT NOT NULL,
  name_fr             TEXT NOT NULL,
  acronym             TEXT,
  parent_org_id       TEXT,
  level               INTEGER NOT NULL,
  node_path           TEXT NOT NULL,
  name_key_en         TEXT NOT NULL,
  name_key_fr         TEXT NOT NULL,
  search_en           TEXT NOT NULL,
  search_fr           TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  PRIMARY KEY (org_id, valid_from_seq)
);
CREATE INDEX IF NOT EXISTS idx_geds_orgs_key ON geds_organizations (org_key);
CREATE INDEX IF NOT EXISTS idx_geds_orgs_open ON geds_organizations (valid_to_seq, valid_from_seq);
CREATE INDEX IF NOT EXISTS idx_geds_orgs_parent ON geds_organizations (parent_org_id);
CREATE INDEX IF NOT EXISTS idx_geds_orgs_search_en ON geds_organizations (search_en);
CREATE INDEX IF NOT EXISTS idx_geds_orgs_search_fr ON geds_organizations (search_fr);

-- A published role. The role's identity is the person, the unit, the published
-- title in both languages, the contact anchor, and a listing discriminator for
-- the rare case where the publisher has two listings with all of those equal.
-- The whole published contact card is versioned; a changed telephone number
-- closes the old version and opens a new one at the next snapshot.
CREATE TABLE IF NOT EXISTS geds_roles (
  role_id              TEXT NOT NULL,
  role_key             TEXT NOT NULL,
  valid_from_seq       INTEGER NOT NULL,
  valid_to_seq         INTEGER,
  last_seen_seq        INTEGER NOT NULL DEFAULT 0,
  person_id            TEXT NOT NULL,
  org_id               TEXT NOT NULL,
  department_acronym   TEXT NOT NULL,
  title_en             TEXT,
  title_fr             TEXT,
  surname              TEXT NOT NULL,
  given_name           TEXT NOT NULL,
  initials             TEXT,
  prefixes_en          TEXT,
  prefixes_fr          TEXT,
  suffixes_en          TEXT,
  suffixes_fr          TEXT,
  full_name            TEXT NOT NULL,
  search_name          TEXT NOT NULL,
  search_title_en      TEXT NOT NULL,
  search_title_fr      TEXT NOT NULL,
  search_en            TEXT NOT NULL,
  search_fr            TEXT NOT NULL,
  email                TEXT,
  telephone            TEXT,
  fax                  TEXT,
  tdd                  TEXT,
  secure_telephone     TEXT,
  secure_fax           TEXT,
  alternate_telephone  TEXT,
  is_general_office    INTEGER NOT NULL DEFAULT 0,
  contact_json         TEXT NOT NULL,
  content_hash         TEXT NOT NULL,
  source_row           INTEGER NOT NULL,
  PRIMARY KEY (role_id, valid_from_seq)
);
CREATE INDEX IF NOT EXISTS idx_geds_roles_key ON geds_roles (role_key);
CREATE INDEX IF NOT EXISTS idx_geds_roles_open ON geds_roles (valid_to_seq, valid_from_seq);
CREATE INDEX IF NOT EXISTS idx_geds_roles_person ON geds_roles (person_id, valid_from_seq);
CREATE INDEX IF NOT EXISTS idx_geds_roles_org ON geds_roles (org_id, valid_from_seq);
CREATE INDEX IF NOT EXISTS idx_geds_roles_search_en ON geds_roles (search_en);
CREATE INDEX IF NOT EXISTS idx_geds_roles_search_fr ON geds_roles (search_fr);
CREATE INDEX IF NOT EXISTS idx_geds_roles_email ON geds_roles (email);
CREATE INDEX IF NOT EXISTS idx_geds_roles_phone ON geds_roles (telephone);

-- The change feed. Every event has a deterministic id, so a resumed snapshot
-- cannot record the same change twice. Replaying an identical export records
-- none at all.
CREATE TABLE IF NOT EXISTS geds_changes (
  id           TEXT PRIMARY KEY,
  seq          INTEGER NOT NULL,
  snapshot_id  TEXT NOT NULL,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('person', 'organization', 'role')),
  entity_id    TEXT NOT NULL,
  change       TEXT NOT NULL CHECK (change IN ('added', 'changed', 'removed')),
  summary      TEXT,
  occurred_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_geds_changes_seq ON geds_changes (seq);
CREATE INDEX IF NOT EXISTS idx_geds_changes_entity ON geds_changes (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_geds_changes_snapshot ON geds_changes (snapshot_id);

-- The refresh log. The coverage receipt is built from this and the snapshot row.
CREATE TABLE IF NOT EXISTS geds_refresh_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  observation_id  TEXT,
  snapshot_id     TEXT,
  ok              INTEGER NOT NULL DEFAULT 0,
  rows_read       INTEGER NOT NULL DEFAULT 0,
  rows_written    INTEGER NOT NULL DEFAULT 0,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_geds_runs_started ON geds_refresh_runs (started_at);
