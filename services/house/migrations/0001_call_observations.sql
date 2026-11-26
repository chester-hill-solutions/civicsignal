-- This overlay owns House call observations. The corpus cutoff is independently seeded.
CREATE TABLE IF NOT EXISTS cc_house_runs (
  instance_id TEXT PRIMARY KEY,
  session TEXT NOT NULL CHECK(session='45-1'),
  scheduled_time INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  packet_sha256 TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  result_json TEXT NOT NULL,
  UNIQUE(session, scheduled_time)
);
CREATE TABLE IF NOT EXISTS cc_house_guard (valid INTEGER NOT NULL CHECK(valid=1));
