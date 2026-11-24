CREATE TABLE IF NOT EXISTS parliament_entries (
  collection TEXT NOT NULL,
  session TEXT NOT NULL,
  language TEXT NOT NULL,
  key TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  search_text TEXT NOT NULL,
  member_id TEXT,
  position TEXT,
  PRIMARY KEY (collection, session, language, key, ordinal)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS parliament_entries_member
  ON parliament_entries(collection, session, language, member_id, position);
CREATE INDEX IF NOT EXISTS parliament_editions_date
  ON parliament_editions(collection, session, language, date DESC, key);
