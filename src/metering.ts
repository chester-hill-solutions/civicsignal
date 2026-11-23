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
import { BYOK_LIMITS } from './byok';
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

function workerLedger(env: Env): DurableObjectUsageLedger {
  if (!env.API_KEY_USAGE) throw new Error('The usage ledger is unavailable.');
  return new DurableObjectUsageLedger(env.API_KEY_USAGE, {
    failureMode: 'closed', acknowledgementRetries: 2,
  });
}

export async function runBillableRetrieval<T>(
  env: Env,
  identity: RetrievalIdentity,
  work: () => Promise<T>,
  options: { waitUntil?: (task: Promise<unknown>) => void; ledger?: UsageLedger } = {},
): Promise<T> {
  return runBillableWork(identity.customer, meterConfig(env), options.ledger ?? workerLedger(env), work, options.waitUntil);
}

/** Both adapters use the same success boundary; storage supplies atomic consume. */
export function runBillableWork<T>(
  customer: MeteredCustomer,
  config: MeterConfig,
  ledger: UsageLedger,
  work: () => Promise<T>,
  waitUntil?: (task: Promise<unknown>) => void,
): Promise<T> {
  return runBillableOperation(customer, config, ledger, async () => ({ result: await work(), ledger }), waitUntil);
}

export function runBillableChat<T>(
  env: Env,
  identity: RetrievalIdentity,
  work: (reserveGeneration: () => Promise<void>) => Promise<T>,
  options: { waitUntil?: (task: Promise<unknown>) => void } = {},
): Promise<T> {
  const customer = identity.customer;
  const config = meterConfig(env);
  const ledger = workerLedger(env);
  return runBillableOperation(customer, config, ledger, async (operation) => {
    const { nowMs, operationId, limit } = operation;
    let held = false;
    const reserveGeneration = async () => {
      if (limit <= 0) return;
      const reservation = await ledger.reserveMonthly(customer.id, limit, nowMs, operationId);
      if (reservation.unavailable) throw unavailable();
      if (!reservation.allowed) {
        throw quotaDenied(reservation.count, reservation.limit, reservation.month);
      }
      held = true;
      // A delayed acknowledgement cannot start provider work on a short lease.
      // Leave fifteen seconds for the first settlement acknowledgement sequence.
      if (reservation.expiresAt === undefined || reservation.expiresAt - Date.now() < BYOK_LIMITS.timeoutMs + 15_000) {
        throw unavailable();
      }
    };
    try {
      const result = await work(reserveGeneration);
      return { result, ledger: held ? {
        supportsOperationIds: true,
        peekMonthly: ledger.peekMonthly.bind(ledger),
        consumeMonthly: ledger.consumeReservedMonthly.bind(ledger),
      } : ledger };
    } catch (error) {
      if (held) {
        // Release follows failed work only. An ambiguous settlement may have charged.
        await ledger.releaseMonthly(customer.id, limit, nowMs, operationId).catch(() => {});
      }
      throw error;
    }
  }, options.waitUntil);
}

function unavailable(): BillableDenied {
  return new BillableDenied({ allowed: false, status: 503,
    body: { code: 'USAGE_UNAVAILABLE', error: 'The usage ledger is unavailable.' } });
}

function quotaDenied(count: number, limit: number, month: string): BillableDenied {
  return new BillableDenied({
    allowed: false, status: 429,
    body: { code: 'FUSE_EXCEEDED', error: 'Monthly usage fuse exceeded', count, limit, month },
  });
}

async function runBillableOperation<T>(
  customer: MeteredCustomer,
  config: MeterConfig,
  ledger: UsageLedger,
  work: (operation: { nowMs: number; operationId: string; limit: number }) => Promise<{ result: T; ledger: UsageLedger }>,
  waitUntil?: (task: Promise<unknown>) => void,
): Promise<T> {
  const nowMs = Date.now();
  const operationId = crypto.randomUUID();
  if (!ledger.supportsOperationIds) throw unavailable();
  const limit = enforcementLimit(customer, config.freeFuseLimit);
  // Avoid expensive work for an exhausted hard fuse. The atomic consume below
  // still decides concurrent calls, after the retrieval succeeds.
  const usage = await ledger.peekMonthly(customer.id, limit, nowMs).catch(() => { throw unavailable(); });
  if (usage.unavailable) throw unavailable();
  if (!usage.allowed) {
    if (usage.count >= limit && limit > 0) throw quotaDenied(usage.count, limit, usage.month);
    throw new BillableDenied({ allowed: false, status: 503,
      body: { ...unavailable().outcome.body, count: usage.count, limit, month: usage.month } });
  }
  const completed = await work({ nowMs, operationId, limit });
  const outcome = await recordSuccessfulBillable(customer, config, {
    ledger: completed.ledger,
    waitUntil,
    nowMs,
    operationId,
    usageFailureMode: 'closed',
  });
  if (!outcome.allowed) throw new BillableDenied(outcome);
  return completed.result;
}
