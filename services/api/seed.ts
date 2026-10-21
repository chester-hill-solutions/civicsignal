/**
 * Seed the customer database.
 *
 * The keys and the customer live in KV on the Cloudflare plane, and in a
 * database here. This script moves them across: it reads the records out of
 * KV and writes them into Postgres, so the cutover does not invalidate a
 * customer's key.
 *
 * With `--from-file` it writes the records from a JSON file instead, which is
 * what a cutover does when the old plane is already gone.
 *
 *     bun services/api/seed.ts --from-file customers.json
 *
 * The file is a list of `{ customer, keys }`:
 *
 *     [{ "customer": { "id": "cus_civicsignal", "plan": "free", "fuseLimit": 1000 },
 *        "keys": [{ "id": "key_1", "kind": "server", "secretHash": "…" }] }]
 */
import postgres from 'postgres';
import { sqlRunner } from '../../src/corpora/postgres-context';
import {
  ensureCustomerSchema,
  PostgresApiKeyStore,
  PostgresCustomerStore,
} from './customer-store';
import type { ApiKeyRecord } from '../../src/spine/api-keys';
import type { CustomerRecord } from '../../src/spine/customer';

/** What the file holds. */
interface SeedFile {
  customer: CustomerRecord;
  keys: ApiKeyRecord[];
}

async function main(): Promise<void> {
  const url = process.env.CUSTOMER_DATABASE_URL;
  if (!url) throw new Error('CUSTOMER_DATABASE_URL is not set');
  const file = process.argv[process.argv.indexOf('--from-file') + 1];
  if (!file) throw new Error('pass --from-file <path>');

  const raw = postgres(url, { max: 2, connect_timeout: 15 });
  const sql = sqlRunner(raw);
  await ensureCustomerSchema(sql);

  const customers = new PostgresCustomerStore(sql);
  const keys = new PostgresApiKeyStore(sql);

  const records = JSON.parse(await Bun.file(file).text()) as SeedFile[];
  for (const record of records) {
    await customers.put(record.customer);
    for (const key of record.keys) {
      await keys.put(key);
      console.log(`  ${key.id} → ${record.customer.id}`);
    }
  }
  console.log(`  ${records.length} customer(s) seeded`);

  await raw.end({ timeout: 5 });
}

await main();
