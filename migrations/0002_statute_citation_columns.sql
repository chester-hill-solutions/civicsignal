-- The corpus store's citation columns.
--
-- The ingest has always written `citation` and `language`, but the table never had
-- them, so `dist/statutes.sql` could not be loaded against the migrated schema.
--
-- `citation` is the instrument's own citation — "A-1", "C-34", "SOR-96-313" — and it
-- is what makes a citation resolvable. The display title is not: a regulation's
-- title is not unique. "Contraventions Regulations" is the title of 416 different
-- instruments, and "Schedule I" is the label of a schedule in thousands of them.
-- The citation is the only part of a reference that identifies one document.
--
-- `status` is the state of the provision: in force, repealed, or a placeholder in
-- the consolidation. Nearly eleven thousand rows are placeholders — "[Amendment]"
-- means the provision exists but its text lives in an amending instrument — and
-- they are excluded from the vector index, because eleven thousand identical
-- vectors would crowd it. They stay in the store, because a citation to a section
-- has to resolve to something.
--
-- `schedule` and `part` are what a schedule chunk carries. A schedule is indexed as
-- the schedule, chunked so that no chunk is too large to embed; the chunk's number
-- is `part`, and the schedule it belongs to is `schedule`.

ALTER TABLE statute_sections ADD COLUMN citation TEXT;
ALTER TABLE statute_sections ADD COLUMN language TEXT;
ALTER TABLE statute_sections ADD COLUMN schedule TEXT;
ALTER TABLE statute_sections ADD COLUMN part INTEGER;
ALTER TABLE statute_sections ADD COLUMN status TEXT;

CREATE INDEX IF NOT EXISTS idx_statute_sections_citation ON statute_sections (citation, section);
