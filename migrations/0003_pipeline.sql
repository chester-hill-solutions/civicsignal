-- The pipeline's tables, on D1.
--
-- The continuous ingest needs four things the corpus tables did not have:
--
-- - **A fingerprint per row.** The reconciliation is by provision: a provision
--   whose fingerprint has not changed has not changed. Without a stored
--   fingerprint the pipeline would have to re-read every row's text to work out
--   whether it moved, which is the one thing it must not do at this size.
-- - **The revision the corpus is at**, so a run that finds nothing to do knows
--   that it has nothing to do.
-- - **The run log**, so "when did the corpus last change and what did it cost"
--   is a question with an answer.
-- - **The change feed**, so "this provision was amended" is a thing the
--   product can say rather than infer.
--
-- The fingerprint and the revision are the two the pipeline cannot work
-- without; the other two are the two a reader would ask for.

-- The fingerprint of a row's text, and the date the revision that last changed
-- it carried. Both are nullable, so the migration costs nothing on the
-- 277,857 rows that are already there, and the first run after it fills them
-- in as it rewrites what changed.
ALTER TABLE statute_sections ADD COLUMN text_hash TEXT;
ALTER TABLE statute_sections ADD COLUMN last_changed TEXT;

-- The revision the corpus is at. One row per corpus.
CREATE TABLE IF NOT EXISTS corpus_state (
  corpus_id   TEXT PRIMARY KEY,
  commit_sha  TEXT NOT NULL,
  commit_date TEXT NOT NULL,
  as_of       TEXT NOT NULL,
  row_count   INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT NOT NULL
);

-- The run log. One row per cycle.
CREATE TABLE IF NOT EXISTS corpus_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  corpus_id   TEXT NOT NULL,
  commit_sha  TEXT NOT NULL,
  commit_date TEXT NOT NULL,
  ran_at      TEXT NOT NULL,
  added       INTEGER NOT NULL DEFAULT 0,
  changed     INTEGER NOT NULL DEFAULT 0,
  removed     INTEGER NOT NULL DEFAULT 0,
  unchanged   INTEGER NOT NULL DEFAULT 0,
  embedded    INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  ok          INTEGER NOT NULL DEFAULT 1,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_corpus_runs_corpus ON corpus_runs (corpus_id);

-- The change feed: what the pipeline did, one row per change.
--
-- "This provision was amended" is only useful if the feed says *which*
-- provision, and a removed provision is only useful if the feed says what it
-- said before it went.
CREATE TABLE IF NOT EXISTS corpus_changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  corpus_id   TEXT NOT NULL,
  change      TEXT NOT NULL CHECK (change IN ('added', 'changed', 'removed')),
  row_id      TEXT NOT NULL,
  instrument  TEXT NOT NULL,
  citation    TEXT NOT NULL,
  section     TEXT NOT NULL,
  heading     TEXT,
  status      TEXT,
  summary     TEXT,
  source_url  TEXT,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corpus_changes_corpus ON corpus_changes (corpus_id);
CREATE INDEX IF NOT EXISTS idx_corpus_changes_row ON corpus_changes (row_id);
