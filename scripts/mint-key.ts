/**
 * Mint an API key.
 *
 * There was no way to make a key, which is why the corpus had never been
 * loaded and the Worker had never been deployed: the product could not be
 * asked a question.
 *
 * The key is written straight into the KV namespace, in the shape the spine
 * reads — a `key:{id}` entry and a `keyhash:{sha256}` entry, so that a key can
 * be found by its public id or by the hash of its secret.
 *
 * The secret is printed **once**. Only its hash is stored, which is the point:
 * a leaked store is not a leaked key.
 *
 *     bun scripts/mint-key.ts --customer cus_civicsignal --label "the first one"
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'ad5ec479b9a421faa2ed06c3d1c2b23a';
const NAMESPACE_ID = process.env.API_KEYS_NAMESPACE ?? '2d0152b0958c48fab4a98b3046e0c08e';

interface Args {
  customer: string;
  label: string;
  plan: 'free' | 'metered' | 'enterprise';
  fuseLimit: number;
  softWarn: boolean;
  kind: 'server' | 'browser';
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    customer: 'cus_civicsignal',
    label: 'a CivicSignal key',
    plan: 'free',
    fuseLimit: 0,
    softWarn: false,
    kind: 'server',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--customer') args.customer = argv[++i] ?? args.customer;
    else if (arg === '--label') args.label = argv[++i] ?? args.label;
    else if (arg === '--plan') {
      const value = argv[++i];
      if (value !== 'free' && value !== 'metered' && value !== 'enterprise') {
        throw new Error(`--plan must be free, metered or enterprise (got "${value ?? ''}")`);
      }
      args.plan = value;
    } else if (arg === '--fuse-limit') args.fuseLimit = Number(argv[++i]) || 0;
    else if (arg === '--soft-warn') args.softWarn = true;
    else if (arg === '--kind') {
      const value = argv[++i];
      args.kind = value === 'browser' ? 'browser' : 'server';
    }
  }
  return args;
}

function token(): string {
  const config = readFileSync(join(process.env.HOME ?? '.', '.wrangler', 'config', 'default.toml'), 'utf8');
  const found = /oauth_token\s*=\s*"([^"]+)"/.exec(config)?.[1];
  if (!found) throw new Error('no token found. Run `npx wrangler login` first.');
  return found;
}

/** Write one key into the KV namespace. */
async function put(auth: string, key: string, value: unknown): Promise<void> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}/values/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    },
  );
  if (!response.ok) {
    throw new Error(`KV refused ${key}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const auth = token();

  // The secret. A server key is `sk_` and a browser key is `pk_`, and the
  // prefix is part of the key the customer copies, so it is the format the
  // house uses everywhere else.
  const secret = `${args.kind === 'browser' ? 'pk' : 'sk'}_${randomBytes(24).toString('base64url')}`;
  const hash = createHash('sha256').update(secret).digest('hex');
  const id = `${args.kind === 'browser' ? 'pk' : 'sk'}_${randomBytes(9).toString('base64url')}`;
  const now = new Date().toISOString();

  const record = {
    id,
    kind: args.kind,
    customerId: args.customer,
    label: args.label,
    origins: [],
    dailyLimit: 0,
    secretHash: hash,
    createdAt: now,
  };

  await put(auth, `keyhash:${hash}`, record);
  await put(auth, `key:${id}`, record);

  // The customer. The meter reads it to know the plan and the fuse, and the
  // fuse is what refuses a customer who has used their allowance.
  const customer = {
    id: args.customer,
    plan: args.plan,
    fuseLimit: args.fuseLimit,
    fuseSoftWarn: args.softWarn,
    updatedAt: now,
  };
  await put(auth, `customer:${args.customer}`, customer);

  console.log('the key — copy it now, it is not stored:');
  console.log(`  ${secret}`);
  console.log(`  id       ${id}`);
  console.log(`  customer ${args.customer} (${args.plan})`);
  console.log(`  fuse     ${args.fuseLimit || 'unlimited'}${args.softWarn ? ', soft (warns)' : ''}`);
}

await main();
