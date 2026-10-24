-- A corpus commit alone does not identify the row semantics after parser fixes.
-- NULL identifies the legacy parser and forces full snapshot reconciliation.
ALTER TABLE corpus_state ADD COLUMN parser_version TEXT;
ALTER TABLE corpus_runs ADD COLUMN parser_version TEXT;
