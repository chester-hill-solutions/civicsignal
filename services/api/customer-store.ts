/**
 * The customer database, on Postgres.
 *
 * The keys and the customer live in KV today, because KV is what a Worker has.
 * The Bun service has a database instead, and a key is a row.
 *
 * The records are **columns**, not a JSON blob. That is the one thing this
 * store does differently from the KV it replaces, and it is deliberate: KV
 * stores the record as a JSON string, so a field that is added to
 * `ApiKeyRecord` is available the moment it is written. Here a column is a
 * migration, and a migration is a thing that can be forgotten. So the columns
 * are spelled out, and the mapper below is the one place that has to change
 * when the record's shape does.
 *
 * The lookup that matters is `loadBySecret`: a server key arrives as a secret,
 * and the store holds only its SHA-256. The hash is what the index is on, so
 * the lookup is an index seek rather than a scan of every key.
 */
import type { SqlRunner } from '@chester-hill-solutions/api-billing/postgres';
import type { ApiKeyRecord, ApiKeyKind } from '../../src/spine/api-keys';
import type { CustomerRecord, CustomerPlan } from '../../src/spine/customer';

/** The schema of the customer database. */
export const CUSTOMER_DB_DDL = `
-- The API keys.
--
-- A browser key is public: it says which origins may use it and how much it
-- may spend in a day. A server key is a secret: only its hash is here, and
-- the raw value is shown once, at mint.
CREATE TABLE IF NOT EXISTS api_keys (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('browser', 'server')),
  customer_id    TEXT NOT NULL,
  label          TEXT,
  origins        JSONB NOT NULL DEFAULT '[]'::jsonb,
  daily_limit    INTEGER NOT NULL DEFAULT 0,
  secret_hash    TEXT,
  disabled       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The lookup for a server key is by the hash of the secret, and there is one
-- row per key, so the hash is unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_secret_hash
  ON api_keys (secret_hash) WHERE secret_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_api_keys_customer ON api_keys (customer_id);

-- The customers.
--
-- The fuse limit is a column rather than a setting because it is the thing
-- that decides whether a call is allowed, and a number in a row can be
-- changed and audited.
CREATE TABLE IF NOT EXISTS customers (
  id                   TEXT PRIMARY KEY,
  plan                 TEXT NOT NULL CHECK (plan IN ('free', 'metered', 'enterprise')),
  fuse_limit           INTEGER NOT NULL DEFAULT 1000,
  fuse_soft_warn       BOOLEAN NOT NULL DEFAULT FALSE,
  batch_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  stripe_customer_id   TEXT,
  label                TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/** A row of `api_keys`, as Postgres holds it. */
interface ApiKeyRow {
  id: string;
  kind: string;
  customer_id: string;
  label: string | null;
  origins: unknown;
  daily_limit: number;
  secret_hash: string | null;
  disabled: boolean;
  created_at: Date | string;
}

/** A row of `customers`, as Postgres holds it. */
interface CustomerRow {
  id: string;
  plan: string;
  fuse_limit: number;
  fuse_soft_warn: boolean;
  batch_enabled: boolean;
  stripe_customer_id: string | null;
  label: string | null;
  updated_at: Date | string;
}

/** The origins are a JSON array of strings. */
function parseOrigins(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Postgres's timestamps are `Date`s, and sometimes strings. */
function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toApiKey(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    kind: row.kind as ApiKeyKind,
    customerId: row.customer_id,
    label: row.label ?? undefined,
    origins: parseOrigins(row.origins),
    dailyLimit: row.daily_limit,
    secretHash: row.secret_hash ?? undefined,
    disabled: row.disabled,
    createdAt: iso(row.created_at),
  };
}

function toCustomer(row: CustomerRow): CustomerRecord {
  return {
    id: row.id,
    plan: row.plan as CustomerPlan,
    fuseLimit: row.fuse_limit,
    fuseSoftWarn: row.fuse_soft_warn,
    batchEnabled: row.batch_enabled,
    stripeCustomerId: row.stripe_customer_id ?? undefined,
    label: row.label ?? undefined,
    updatedAt: iso(row.updated_at),
  };
}

/** The keys. */
export class PostgresApiKeyStore {
  constructor(private readonly sql: SqlRunner) {}

  async load(id: string): Promise<ApiKeyRecord | null> {
    const rows = (await this.sql.unsafe('SELECT * FROM api_keys WHERE id = $1', [id])) as ApiKeyRow[];
    return rows[0] ? toApiKey(rows[0]) : null;
  }

  /** The lookup that matters: a secret arrives, and only its hash is here. */
  async loadBySecret(secretHash: string): Promise<ApiKeyRecord | null> {
    const rows = (await this.sql.unsafe('SELECT * FROM api_keys WHERE secret_hash = $1', [
      secretHash,
    ])) as ApiKeyRow[];
    return rows[0] ? toApiKey(rows[0]) : null;
  }

  async put(record: ApiKeyRecord): Promise<void> {
    await this.sql.unsafe(
      `INSERT INTO api_keys (id, kind, customer_id, label, origins, daily_limit, secret_hash, disabled, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, COALESCE($9::timestamptz, now()))
       ON CONFLICT (id) DO UPDATE SET
         kind = EXCLUDED.kind,
         customer_id = EXCLUDED.customer_id,
         label = EXCLUDED.label,
         origins = EXCLUDED.origins,
         daily_limit = EXCLUDED.daily_limit,
         secret_hash = EXCLUDED.secret_hash,
         disabled = EXCLUDED.disabled`,
      [
        record.id,
        record.kind,
        record.customerId,
        record.label ?? null,
        JSON.stringify(record.origins ?? []),
        record.dailyLimit ?? 0,
        record.secretHash ?? null,
        record.disabled ?? false,
        record.createdAt ?? null,
      ],
    );
  }

  async delete(id: string): Promise<void> {
    await this.sql.unsafe('DELETE FROM api_keys WHERE id = $1', [id]);
  }

  async list(customerId: string): Promise<ApiKeyRecord[]> {
    const rows = (await this.sql.unsafe(
      'SELECT * FROM api_keys WHERE customer_id = $1 ORDER BY id',
      [customerId],
    )) as ApiKeyRow[];
    return rows.map(toApiKey);
  }
}

/** The customers. */
export class PostgresCustomerStore {
  constructor(private readonly sql: SqlRunner) {}

  async load(id: string): Promise<CustomerRecord | null> {
    const rows = (await this.sql.unsafe('SELECT * FROM customers WHERE id = $1', [id])) as CustomerRow[];
    return rows[0] ? toCustomer(rows[0]) : null;
  }

  async put(record: CustomerRecord): Promise<void> {
    await this.sql.unsafe(
      `INSERT INTO customers (id, plan, fuse_limit, fuse_soft_warn, batch_enabled, stripe_customer_id, label, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (id) DO UPDATE SET
         plan = EXCLUDED.plan,
         fuse_limit = EXCLUDED.fuse_limit,
         fuse_soft_warn = EXCLUDED.fuse_soft_warn,
         batch_enabled = EXCLUDED.batch_enabled,
         stripe_customer_id = EXCLUDED.stripe_customer_id,
         label = EXCLUDED.label,
         updated_at = now()`,
      [
        record.id,
        record.plan,
        record.fuseLimit,
        record.fuseSoftWarn ?? false,
        record.batchEnabled ?? false,
        record.stripeCustomerId ?? null,
        record.label ?? null,
      ],
    );
  }

  async delete(id: string): Promise<void> {
    await this.sql.unsafe('DELETE FROM customers WHERE id = $1', [id]);
  }
}

/** Apply the customer schema. Idempotent. */
export async function ensureCustomerSchema(sql: SqlRunner): Promise<void> {
  await sql.unsafe(CUSTOMER_DB_DDL);
}
