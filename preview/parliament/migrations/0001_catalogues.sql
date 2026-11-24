CREATE TABLE IF NOT EXISTS parliament_catalogues (
  collection TEXT NOT NULL,
  session TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  revision TEXT NOT NULL,
  records_per_language INTEGER NOT NULL CHECK (records_per_language > 0),
  PRIMARY KEY (collection, session)
);
CREATE TABLE IF NOT EXISTS parliament_editions (
  collection TEXT NOT NULL,
  session TEXT NOT NULL,
  key TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en','fr')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  date TEXT,
  url TEXT NOT NULL,
  search_text TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  PRIMARY KEY (collection, session, language, key)
);
