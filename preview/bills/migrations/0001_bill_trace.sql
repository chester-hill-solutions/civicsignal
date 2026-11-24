CREATE TABLE IF NOT EXISTS bill_trace_sources (
  bill_key TEXT NOT NULL,
  source TEXT NOT NULL,
  available INTEGER NOT NULL CHECK (available IN (0, 1)),
  records_json TEXT NOT NULL,
  PRIMARY KEY (bill_key, source)
);
CREATE TABLE IF NOT EXISTS bill_trace_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_key TEXT NOT NULL,
  source TEXT NOT NULL,
  record_id TEXT NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('added', 'corrected', 'removed')),
  record_json TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
