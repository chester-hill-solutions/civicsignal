/** Read both legacy key indexes. Authentication used keyhash:, not the display index. */
export interface LegacyAuthReader {
  list(prefix: string): Promise<string[]>;
  get(name: string): Promise<Record<string, unknown>>;
}

export async function collectLegacyAuth(reader: LegacyAuthReader) {
  const read = async (prefix: string) => {
    const names = await reader.list(prefix);
    if (new Set(names).size !== names.length) throw new Error('Legacy index contains duplicate names.');
    const rows: { name: string; row: Record<string, unknown> }[] = [];
    for (const name of names) {
      if (!name.startsWith(prefix)) throw new Error('Legacy prefix listing returned an unrelated name.');
      rows.push({ name, row: await reader.get(name) });
    }
    return rows;
  };
  const customers = await read('customer:');
  const displays = await read('key:');
  const hashes = await read('keyhash:');
  const byId = new Map<string, Record<string, unknown>>();
  for (const { name, row } of displays) {
    if (typeof row['id'] !== 'string' || name !== `key:${row['id']}` || byId.has(row['id'])) {
      throw new Error('Legacy display key identity is invalid.');
    }
    byId.set(row['id'], row);
  }
  const migrated = new Map<string, Record<string, unknown>>();
  for (const { name, row } of hashes) {
    const hash = row['secretHash'];
    const id = row['id'];
    if (row['kind'] !== 'server' || typeof id !== 'string' || typeof hash !== 'string' ||
        !/^[a-fA-F0-9]{64}$/.test(hash) || name.toLowerCase() !== `keyhash:${hash.toLowerCase()}` || migrated.has(id)) {
      throw new Error('Legacy authoritative server key identity is invalid or duplicated.');
    }
    const display = byId.get(id);
    if (display && ['id', 'customerId', 'kind', 'secretHash'].some((field) => display[field] !== row[field])) {
      throw new Error('Legacy display and authoritative hash identities disagree.');
    }
    migrated.set(id, { ...row, disabled: Boolean(row['disabled'] || display?.['disabled']) });
  }
  for (const row of byId.values()) {
    if (row['kind'] === 'server' && !migrated.has(String(row['id']))) {
      throw new Error('A server display key has no authoritative hash index. Repair the frozen backup before migration.');
    }
    if (row['kind'] === 'browser') migrated.set(String(row['id']), row);
  }
  for (const { name, row } of customers) {
    if (name !== `customer:${row['id']}`) throw new Error('Legacy customer identity is invalid.');
  }
  return { customers: customers.map(({ row }) => row), keys: [...migrated.values()] };
}
