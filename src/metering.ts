import {
  enforcementLimit,
  recordSuccessfulBillable,
  type BillableOutcome,
  type MeterConfig,
  type UsageLedger,
  type MeteredCustomer,
} from '@chester-hill-solutions/api-billing';
import { DurableObjectUsageLedger } from '@chester-hill-solutions/api-billing/durable-object';
import type { RetrievalIdentity } from './access';
import type { Env } from './types';

export class BillableDenied extends Error {
  constructor(readonly outcome: BillableOutcome) {
    super(String(outcome.body?.['error'] ?? 'The usage allowance is exhausted.'));
    this.name = 'BillableDenied';
  }
}

function meterConfig(env: Env): MeterConfig {
  const allowance = Number(env.FREE_MONTHLY_ALLOWANCE ?? 1000);
  if (!Number.isSafeInteger(allowance) || allowance < 1) throw new Error('Invalid free monthly allowance.');
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_METER_EVENT_NAME) {
    throw new Error('The Stripe meter event name is required.');
  }
  return {
    freeFuseLimit: allowance,
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    meterEventName: env.STRIPE_METER_EVENT_NAME ?? 'civicsignal_retrieval',
  };
}

export async function runBillableRetrieval<T>(
  env: Env,
  identity: RetrievalIdentity,
  work: () => Promise<T>,
  options: { waitUntil?: (task: Promise<unknown>) => void; ledger?: UsageLedger } = {},
): Promise<T> {
  const config = meterConfig(env);
  if (!options.ledger && !env.API_KEY_USAGE) throw new Error('The usage ledger is unavailable.');
  const ledger = options.ledger ?? new DurableObjectUsageLedger(env.API_KEY_USAGE!, {
    failureMode: 'closed', acknowledgementRetries: 2,
  });
  return runBillableWork(identity.customer, config, ledger, work, options.waitUntil);
}

/** Both adapters use the same success boundary; storage supplies atomic consume. */
export async function runBillableWork<T>(
  customer: MeteredCustomer,
  config: MeterConfig,
  ledger: UsageLedger,
  work: () => Promise<T>,
  waitUntil?: (task: Promise<unknown>) => void,
): Promise<T> {
  const nowMs = Date.now();
  const operationId = crypto.randomUUID();
  const unavailable = () => new BillableDenied({ allowed: false, status: 503,
    body: { code: 'USAGE_UNAVAILABLE', error: 'The usage ledger is unavailable.' } });
  if (!ledger.supportsOperationIds) throw unavailable();
  const limit = enforcementLimit(customer, config.freeFuseLimit);
  // Avoid expensive work for an exhausted hard fuse. The atomic consume below
  // still decides concurrent calls, after the retrieval succeeds.
  const usage = await ledger.peekMonthly(customer.id, limit, nowMs).catch(() => { throw unavailable(); });
  if (usage.unavailable) throw unavailable();
  if (!usage.allowed) {
    throw new BillableDenied({
      allowed: false,
      status: usage.count >= limit && limit > 0 ? 429 : 503,
      body: {
        code: usage.count >= limit && limit > 0 ? 'FUSE_EXCEEDED' : 'USAGE_UNAVAILABLE',
        error: usage.count >= limit && limit > 0 ? 'Monthly usage fuse exceeded' : 'The usage ledger is unavailable.',
        count: usage.count,
        limit,
        month: usage.month,
      },
    });
  }
  const result = await work();
  const outcome = await recordSuccessfulBillable(customer, config, {
    ledger,
    waitUntil,
    nowMs,
    operationId,
    usageFailureMode: 'closed',
  });
  if (!outcome.allowed) throw new BillableDenied(outcome);
  return result;
}
