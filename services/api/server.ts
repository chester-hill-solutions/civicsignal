/** Undeployed Bun/Postgres portability entry point. Keep Railway services running. */
import postgres from 'postgres';
import { PostgresUsageLedger } from '@chester-hill-solutions/api-billing/postgres';
import type { CustomerPlan } from '@chester-hill-solutions/api-billing';
import { postgresCorpusContext, sqlRunner } from '../../src/corpora/postgres-context';
import { PostgresApiKeyStore, PostgresCustomerStore } from './customer-store';
import { createPortabilityHandler } from './handler';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
const corpus = postgresCorpusContext({ databaseUrl: required('CORPUS_DATABASE_URL'),
  encoderUrl: required('ENCODER_URL'), encoderToken: required('ENCODER_TOKEN') });
const customerSql = sqlRunner(postgres(required('CUSTOMER_DATABASE_URL'), { max: 4, idle_timeout: 30, connect_timeout: 15 }));
const keys = new PostgresApiKeyStore(customerSql);
const customers = new PostgresCustomerStore(customerSql);
const ledger = new PostgresUsageLedger(customerSql);
const freeFuseLimit = Number(process.env.FREE_FUSE_LIMIT ?? 1000);
if (!Number.isSafeInteger(freeFuseLimit) || freeFuseLimit < 1) throw new Error('FREE_FUSE_LIMIT is invalid');
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const meterEventName = process.env.STRIPE_METER_EVENT_NAME ?? 'civicsignal_retrieval';
if (stripeSecretKey && !process.env.STRIPE_METER_EVENT_NAME) throw new Error('STRIPE_METER_EVENT_NAME is required for Stripe');

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
  | { ok: true; customerId: string; plan: string; fuseLimit: number; fuseSoftWarn: boolean; stripeCustomerId?: string }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
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
    stripeCustomerId: customer.stripeCustomerId,
  };
}


const server = Bun.serve({ port: Number(process.env.PORT ?? 8080), fetch: createPortabilityHandler({
  context: corpus.context, ledger, meter: { freeFuseLimit, stripeSecretKey, meterEventName },
  authorize: async (request) => {
    const auth = await authorize(request);
    if (!auth.ok) return Response.json(auth.body, { status: auth.status });
    return { id: auth.customerId, plan: auth.plan as CustomerPlan, fuseLimit: auth.fuseLimit,
      fuseSoftWarn: auth.fuseSoftWarn, stripeCustomerId: auth.stripeCustomerId };
  },
}) });
console.log(`civicsignal portability: listening on ${server.port}`);
