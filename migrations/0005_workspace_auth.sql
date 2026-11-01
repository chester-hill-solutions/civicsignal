-- Preserve customer IDs as workspace IDs. The usage object remains customer:<id>.
CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT,
  slug TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- This shape matches CHS auth-d1 WORKSPACE_API_KEY_DDL.
CREATE TABLE IF NOT EXISTS workspace_api_key (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  display_prefix TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  created_by_user_id TEXT,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS workspace_api_key_workspace_idx
  ON workspace_api_key(workspace_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS civic_workspace_billing (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK(plan IN ('free', 'metered', 'enterprise')),
  fuse_limit INTEGER NOT NULL DEFAULT 0 CHECK(fuse_limit >= 0),
  fuse_soft_warn INTEGER NOT NULL DEFAULT 0 CHECK(fuse_soft_warn IN (0, 1)),
  stripe_customer_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1))
);
