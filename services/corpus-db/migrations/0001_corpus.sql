-- The corpus store on Postgres.
--
-- The corpus rows and their vectors live in **one table**, so they are written in
-- one transaction and cannot diverge. The earlier arrangement — the rows in one
-- store and the vectors in another — had a failure mode that was invisible: a
-- successful embedding and a failed row write left the index pointing at a
-- provision the store did not have, and the repair needed a manifest to find.
--
-- The vector column holds **no text**. The text is in the row, in this table, and
-- the licence gate runs on the way out. A vector index that held the text would
-- be a second copy of the corpus that bypassed the gate.
--
-- `CREATE EXTENSION vector` is deliberately **not** here. The extension is
-- created by the database administrator — it is a privilege operation and the
-- house rule is that the agent does not run those. The pgvector template ships
-- with it installed; `scripts/check-corpus-db.mjs` verifies it and says what to
-- run if it is missing.

-- ── the corpus revision the store is at ──────────────────────────────────────

-- One row per corpus. The commit it was ingested from, and the date that commit
-- carried, so "as of 2026-10-15" is a claim the product can make and defend.
CREATE TABLE IF NOT EXISTS corpus_state (
  corpus_id     TEXT PRIMARY KEY,
  commit_sha    TEXT NOT NULL,
  commit_date   DATE NOT NULL,
  as_of         DATE NOT NULL,
  row_count     INTEGER NOT NULL DEFAULT 0,
  indexed_count INTEGER NOT NULL DEFAULT 0,
  last_run_at   TIMESTAMPTZ NOT NULL
);

-- The pipeline's run log. The audit trail for every change the store has seen.
CREATE TABLE IF NOT EXISTS corpus_runs (
  id           BIGSERIAL PRIMARY KEY,
  corpus_id    TEXT NOT NULL,
  commit_sha   TEXT NOT NULL,
  commit_date  DATE NOT NULL,
  ran_at       TIMESTAMPTZ NOT NULL,
  added        INTEGER NOT NULL DEFAULT 0,
  changed      INTEGER NOT NULL DEFAULT 0,
  removed      INTEGER NOT NULL DEFAULT 0,
  unchanged    INTEGER NOT NULL DEFAULT 0,
  embedded     INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  ok           BOOLEAN NOT NULL DEFAULT TRUE,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_corpus_runs_corpus ON corpus_runs (corpus_id, ran_at DESC);

-- ── the change feed ──────────────────────────────────────────────────────────

-- What changed, and when. This is a product surface, not bookkeeping: "what
-- changed in federal law this week" is what a campaign, a legal clinic or a
-- journalist actually wants, and it is the reason to run continuously rather
-- than nightly.
CREATE TABLE IF NOT EXISTS corpus_changes (
  id           BIGSERIAL PRIMARY KEY,
  corpus_id    TEXT NOT NULL,
  change       TEXT NOT NULL CHECK (change IN ('added', 'changed', 'removed')),
  row_id       TEXT NOT NULL,
  instrument   TEXT NOT NULL,
  citation     TEXT NOT NULL,
  section      TEXT NOT NULL,
  heading      TEXT,
  status       TEXT,
  summary      TEXT,
  source_url   TEXT,
  occurred_at  DATE NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corpus_changes_feed ON corpus_changes (corpus_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_corpus_changes_row ON corpus_changes (row_id, occurred_at DESC);

-- ── the provisions ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS statute_provisions (
  -- The LIMS id: unique across every provision in the corpus, and stable across
  -- re-consolidation, which is what makes it the row's identity.
  id            TEXT PRIMARY KEY,
  corpus_id     TEXT NOT NULL,
  -- The display title. Not unique: 416 different instruments are called
  -- "Contraventions Regulations".
  instrument    TEXT NOT NULL,
  -- The instrument's own citation. This is what identifies a document.
  citation      TEXT NOT NULL,
  section       TEXT NOT NULL,
  schedule      TEXT,
  part          INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('in-force', 'repealed', 'placeholder')),
  heading       TEXT,
  text          TEXT NOT NULL,
  source_url    TEXT NOT NULL,
  jurisdiction  TEXT NOT NULL DEFAULT 'CA',
  in_force      BOOLEAN NOT NULL DEFAULT TRUE,
  language      TEXT NOT NULL DEFAULT 'en',
  -- The normalised token bag the lexical path searches.
  search_text   TEXT NOT NULL,
  -- The fingerprint of everything a caller can observe. A row whose fingerprint
  -- is unchanged is unchanged, and does not need re-embedding.
  text_hash     TEXT NOT NULL,
  -- The date of the corpus revision that last changed this row.
  last_changed  DATE NOT NULL,
  -- The embedding. 768 dimensions, L2-normalised, EmbeddingGemma 2.
  embedding     vector(768)
);

-- The approximate nearest-neighbour index. HNSW, because at 127,092 rows an exact
-- cosine scan is 40x slower and the difference is felt.
CREATE INDEX IF NOT EXISTS idx_provisions_embedding
  ON statute_provisions USING hnsw (embedding vector_cosine_ops);

-- The lexical path. Postgres full text, which PGlite could not do — it has no
-- FTS5 — so the keyword fallback is a real one and not a LIKE scan.
CREATE INDEX IF NOT EXISTS idx_provisions_fts
  ON statute_provisions USING gin (to_tsvector('english', search_text));

-- The citation path: (instrument citation, section) resolves a provision.
CREATE INDEX IF NOT EXISTS idx_provisions_citation ON statute_provisions (citation, section);
CREATE INDEX IF NOT EXISTS idx_provisions_status ON statute_provisions (corpus_id, status);
CREATE INDEX IF NOT EXISTS idx_provisions_hash ON statute_provisions (text_hash);
