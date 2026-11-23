ALTER TABLE corpus_state ADD COLUMN IF NOT EXISTS parser_version TEXT;
ALTER TABLE corpus_runs ADD COLUMN IF NOT EXISTS parser_version TEXT;
