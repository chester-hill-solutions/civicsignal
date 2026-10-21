/**
 * CivicSignal, on Bun.
 *
 * The port's destination: the same API the Cloudflare Worker serves, over the
 * same corpus, with the same retrieval — on a host that owns its own database.
 *
 * ## What is portable and what is not
 *
 * The retrieval was built to be portable and it is: the corpus package's
 * interfaces are small (`CorpusDatabase`, `VectorIndex`, `CorpusContext`), and
 * the brief is a function of a context. So this service reuses the product's
 * own brief, its own query parsing and its own language lens, and only the
 * *storage* changes — D1 and Vectorize become one Postgres with pgvector.
 *
 * The auth changes too, because a Worker has KV and this has a database: the
 * keys and the customer are rows (`customer-store.ts`).
 *
 * ## What is not here yet
 *
 * - **The MCP surface.** It is a Worker route today, and it is the harness's
 *   primary interface, so it is the first thing to port after this.
 * - **The news, the debates and the bills.** Only the statutes are on Postgres
 *   so far, so a brief here has statutes and nothing else. The corpus that is
 *   missing is missing rather than wrong.
 * - **The change feed's read path.** The feed is written (`corpus_changes`),
 *   but reading it is a Postgres query, and this service is the thing that can
 *   run one.
 */
import postgres from 'postgres';
import { PostgresUsageLedger } from '@chester-hill-solutions/api-billing/postgres';
import { recordSuccessfulBillable } from '@chester-hill-solutions/api-billing';
import { buildBrief } from '../../src/routes/brief';
import { parseQuery } from '../../src/routes/query';
import { postgresStatutesCorpus } from '../../src/corpora/postgres-adapters';
import { postgresCorpusContext, sqlRunner } from '../../src/corpora/postgres-context';
import { PostgresApiKeyStore, PostgresCustomerStore } from './customer-store';

/**
 * Read the configuration, and refuse to start without it.
 *
 * A service that starts with a missing database URL and answers 500s for every
 * request is worse than one that will not start: the failure is visible at the
 * deploy instead of in the traffic.
 */
function readConfig(): {
  corpusDatabaseUrl: string;
  customerDatabaseUrl: string;
  encoderUrl: string;
  encoderToken: string;
  port: number;
  freeFuseLimit: number;
} {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  return {
    corpusDatabaseUrl: required('CORPUS_DATABASE_URL'),
    customerDatabaseUrl: required('CUSTOMER_DATABASE_URL'),
    encoderUrl: required('ENCODER_URL'),
    encoderToken: required('ENCODER_TOKEN'),
    port: Number(process.env.PORT ?? 8080),
    freeFuseLimit: Number(process.env.FREE_FUSE_LIMIT ?? 1000),
  };
}

const config = readConfig();

/**
 * The corpus, over one Postgres.
 *
 * The rows and their vectors are in one table, so a match and the row it
 * belongs to cannot disagree — which is the failure mode the split store had.
 */
const { context } = postgresCorpusContext({
  databaseUrl: config.corpusDatabaseUrl,
  encoderUrl: config.encoderUrl,
  encoderToken: config.encoderToken,
});

/** The customer database: the keys, the customers and the counters. */
const customerSql = sqlRunner(
  postgres(config.customerDatabaseUrl, { max: 4, idle_timeout: 30, connect_timeout: 15 }),
);
const keys = new PostgresApiKeyStore(customerSql);
const customers = new PostgresCustomerStore(customerSql);
const ledger = new PostgresUsageLedger(customerSql);

/** The SHA-256 of a secret, in hex. */
async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The auth, over Postgres. */
async function authorize(
  request: Request,
): Promise<
  | { ok: true; customerId: string; plan: string; fuseLimit: number; fuseSoftWarn: boolean }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
  if (!bearer) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'unauthorized',
        code: 'KEY_REQUIRED',
        message: 'Authorization: Bearer sk_… is required.',
      },
    };
  }
  const record = await keys.loadBySecret(await sha256Hex(bearer));
  if (!record || record.disabled) {
    return {
      ok: false,
      status: 401,
      body: { error: 'unauthorized', code: 'KEY_INVALID', message: 'Unknown or disabled Server key.' },
    };
  }
  if (record.kind !== 'server') {
    return {
      ok: false,
      status: 401,
      body: { error: 'unauthorized', code: 'WRONG_KEY_KIND', message: 'Expected a Server key.' },
    };
  }
  const customer = await customers.load(record.customerId);
  if (!customer) {
    return {
      ok: false,
      status: 404,
      body: {
        error: 'not found',
        code: 'CUSTOMER_NOT_FOUND',
        message: 'Customer not found for this key.',
      },
    };
  }
  return {
    ok: true,
    customerId: customer.id,
    plan: customer.plan,
    fuseLimit: customer.fuseLimit,
    fuseSoftWarn: Boolean(customer.fuseSoftWarn),
  };
}

const server = Bun.serve({
  port: config.port,
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true, plane: 'railway' });
    }

    if (url.pathname !== '/api/brief' && url.pathname !== '/api/match') {
      return Response.json({ error: 'not found' }, { status: 404 });
    }

    const auth = await authorize(request);
    if (!auth.ok) {
      return Response.json(auth.body, { status: auth.status });
    }

    // The fuse. It is counted before the work, so a call that is refused is
    // refused rather than performed, and the count is what the ledger says.
    const billed = await recordSuccessfulBillable(
      {
        id: auth.customerId,
        plan: auth.plan as 'free' | 'metered' | 'enterprise',
        fuseLimit: auth.fuseLimit > 0 ? auth.fuseLimit : 0,
        fuseSoftWarn: auth.fuseSoftWarn,
      },
      { freeFuseLimit: config.freeFuseLimit },
      { ledger },
    );
    if (!billed.allowed) {
      return Response.json(billed.body ?? { error: 'limit reached' }, { status: billed.status });
    }

    try {
      if (url.pathname === '/api/match') {
        const body = (await request.json()) as { vector?: number[]; limit?: number };
        if (!Array.isArray(body.vector)) {
          return Response.json({ error: 'a query vector is required' }, { status: 400 });
        }
        const matches = await context.vector!.query(body.vector, body.limit ?? 10, {});
        return Response.json({ matches, count: matches.length });
      }

      const query = parseQuery(url);
      const brief = await buildBrief(query, context, [postgresStatutesCorpus]);
      return Response.json(brief);
    } catch (error) {
      return Response.json(
        { error: 'unexpected error', message: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
});

console.log(`civicsignal: listening on ${server.port}`);
