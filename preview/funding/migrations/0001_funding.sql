CREATE TABLE IF NOT EXISTS funding_catalogues (
  source TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL,
  revision TEXT NOT NULL,
  indexes_json TEXT NOT NULL,
  gaps_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS funding_editions (
  source TEXT NOT NULL,
  id TEXT NOT NULL,
  language TEXT NOT NULL,
  revision TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  status_text TEXT,
  availability TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  search_text TEXT NOT NULL,
  PRIMARY KEY(source, id, language)
);
CREATE INDEX IF NOT EXISTS funding_browse ON funding_editions(source,language,status,id);
CREATE TABLE IF NOT EXISTS funding_sections (
  source TEXT NOT NULL,
  id TEXT NOT NULL,
  language TEXT NOT NULL,
  section_index INTEGER NOT NULL,
  field TEXT NOT NULL,
  heading TEXT NOT NULL,
  text TEXT NOT NULL,
  url TEXT NOT NULL,
  normalized_heading TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  PRIMARY KEY (source, id, language, section_index)
);
CREATE INDEX IF NOT EXISTS funding_sections_lookup ON funding_sections(source, language, id, section_index);
CREATE TABLE IF NOT EXISTS funding_versions (
  source TEXT NOT NULL,
  id TEXT NOT NULL,
  language TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  revision TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('added','changed','removed')),
  edition_json TEXT NOT NULL,
  PRIMARY KEY (source,id,language,observed_at)
);
