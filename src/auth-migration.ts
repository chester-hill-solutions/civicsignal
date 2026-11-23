import { z } from 'zod';
import { RETRIEVE_CAPABILITY } from './access';

const id = z.string().min(1).max(200);
const customerSchema = z.object({
  id,
  plan: z.enum(['free', 'metered', 'enterprise']),
  fuseLimit: z.number().int().nonnegative(),
  fuseSoftWarn: z.boolean().optional().default(false),
  stripeCustomerId: z.string().optional(),
  label: z.string().optional(),
  updatedAt: z.string().optional(),
});
const keySchema = z.object({
  id, customerId: id, kind: z.enum(['server', 'browser']),
  label: z.string().optional(),
  secretHash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  disabled: z.boolean().optional().default(false),
  createdAt: z.string().optional(),
});
const exportSchema = z.object({
  customers: z.array(customerSchema), keys: z.array(keySchema),
});
/** Strip unknown fields before a protected backup leaves the legacy store. */
export function normalizeAuthExport(input: unknown) { return exportSchema.parse(input); }

export interface AuthMigrationStatement { sql: string; params: (string | number | null)[] }

/** Prepare an idempotent migration. No raw key or usage-counter write is needed. */
export function prepareAuthMigration(input: unknown) {
  const data = normalizeAuthExport(input);
  const customers = new Map(data.customers.map((customer) => [customer.id, customer]));
  if (customers.size !== data.customers.length) throw new Error('Duplicate customer identity in the export.');
  const serverKeys = data.keys.filter((key) => key.kind === 'server');
  const hashes = new Set<string>();
  const ids = new Set<string>();
  for (const key of serverKeys) {
    if (!key.secretHash) throw new Error(`Server key ${key.id} has no SHA-256 hash.`);
    if (!customers.has(key.customerId)) throw new Error(`Server key ${key.id} has no customer.`);
    const hash = key.secretHash.toLowerCase();
    if (hashes.has(hash) || ids.has(key.id)) throw new Error('Duplicate server key identity in the export.');
    hashes.add(hash); ids.add(key.id);
  }
  const statements: AuthMigrationStatement[] = [];
  const timestamp = (value: string | undefined) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
  for (const customer of customers.values()) {
    const at = timestamp(customer.updatedAt);
    statements.push({
      sql: 'INSERT INTO workspace(id,name,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING',
      params: [customer.id, customer.label ?? null, at, at],
    }, {
      sql: `INSERT INTO civic_workspace_billing(workspace_id,plan,fuse_limit,fuse_soft_warn,stripe_customer_id,enabled)
        VALUES(?,?,?,?,?,1) ON CONFLICT(workspace_id) DO NOTHING`,
      params: [customer.id, customer.plan, customer.fuseLimit, customer.fuseSoftWarn ? 1 : 0, customer.stripeCustomerId ?? null],
    });
  }
  for (const key of serverKeys) {
    const at = timestamp(key.createdAt);
    statements.push({
      sql: `INSERT INTO workspace_api_key(id,workspace_id,name,key_hash,display_prefix,capabilities,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(key_hash) DO UPDATE SET
        id=CASE WHEN workspace_api_key.id=excluded.id AND workspace_api_key.workspace_id=excluded.workspace_id
          THEN workspace_api_key.id ELSE NULL END,
        status=CASE WHEN excluded.status='revoked' THEN 'revoked' ELSE workspace_api_key.status END`,
      params: [key.id, key.customerId, key.label ?? 'Migrated server key', key.secretHash!.toLowerCase(),
        key.id.slice(0, 16), JSON.stringify([RETRIEVE_CAPABILITY]), key.disabled ? 'revoked' : 'active', at, at],
    });
  }
  return { statements, summary: { customers: customers.size, serverKeys: serverKeys.length,
    revokedKeys: serverKeys.filter((key) => key.disabled).length,
    skippedBrowserKeys: data.keys.length - serverKeys.length } };
}

export function authMigrationSql(input: unknown): string {
  const { statements } = prepareAuthMigration(input);
  const quote = (value: string | number | null) => value === null ? 'NULL'
    : typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`;
  return statements.map(({ sql, params }) => {
    let position = 0;
    return sql.replace(/\?/g, () => quote(params[position++]!)) + ';';
  }).join('\n');
}
