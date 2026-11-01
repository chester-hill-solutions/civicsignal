/** D1's bookkeeping differs between hosted D1 and local workerd. Accept only
 * the exact observed schemas; an arbitrary _cf_* name is never an exemption. */
export interface RestoreSchemaEntry { name: string; type: string; sql: string | null }

const knownBookkeeping: Record<string, RegExp> = {
  _cf_KV: /^CREATE\s+TABLE\s+_cf_KV\s*\(\s*key\s+TEXT\s+PRIMARY\s+KEY\s*,\s*value\s+BLOB\s*\)\s+WITHOUT\s+ROWID\s*$/i,
  _cf_METADATA: /^CREATE\s+TABLE\s+_cf_METADATA\s*\(\s*key\s+INTEGER\s+PRIMARY\s+KEY\s*,\s*value\s+BLOB\s*\)\s*$/i,
};

export function isFreshRestoreSchema(entries: readonly RestoreSchemaEntry[]): boolean {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.name.startsWith('sqlite_')) continue;
    const expected = Object.prototype.hasOwnProperty.call(knownBookkeeping, entry.name)
      ? knownBookkeeping[entry.name] : undefined;
    if (entry.type !== 'table' || typeof entry.sql !== 'string' || !expected?.test(entry.sql) || seen.has(entry.name)) return false;
    seen.add(entry.name);
  }
  return true;
}

/** Three non-SQLite objects already exceed the two known bookkeeping tables.
 * GLOB keeps the underscore literal, unlike the former LIKE 'sqlite_%'. */
export async function isFreshRestoreDatabase(db: D1Database): Promise<boolean> {
  const schema = await db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name LIMIT 3").all<RestoreSchemaEntry>();
  return isFreshRestoreSchema(schema.results);
}
