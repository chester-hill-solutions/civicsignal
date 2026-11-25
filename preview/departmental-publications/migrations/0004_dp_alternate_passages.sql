-- Applied by the local passage builder after 0002. The table is rebuilt from
-- the catalogue, so this column is present in every new serving generation.
ALTER TABLE dp_extraction_runs
  ADD COLUMN alternate_documents_extracted INTEGER NOT NULL DEFAULT 0;
