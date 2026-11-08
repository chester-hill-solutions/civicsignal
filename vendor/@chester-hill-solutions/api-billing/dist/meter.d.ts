import type { MeterConfig, MeteredCustomer, UsageLedger } from './types.js';
/**
 * Recording a billable unit.
 *
 * The order here is the whole design: **count first, then decide, then report.**
 *
 * A call that was refused by the fuse must not be reported to the meter, and a
 * call that succeeded must be counted before the response goes out. The count is
 * the service's own record; the Stripe event is a copy of it, and the copy is
 * best-effort by design — a Stripe outage must not stop the product serving.
 */
/** The outcome of recording a billable unit. */
export interface BillableOutcome {
    /** Whether the call may proceed. */
    allowed: boolean;
    /** The HTTP status to answer with. */
    status: number;
    /** The body to answer with, when the call was refused. */
    body?: Record<string, unknown>;
}
export interface RecordBillableOptions {
    nowMs?: number;
    /**
     * Where to put the Stripe event so its delivery outlives the response.
     *
     * When omitted — tests, and synchronous callers — the event is awaited instead
     * of fire-and-forget.
     */
    waitUntil?: (task: Promise<unknown>) => void;
    /** The ledger to count in. Defaults to the one the caller supplies. */
    ledger: UsageLedger;
}
/**
 * After a successful call: count it, enforce the fuse, and report it.
 *
 * The fuse decision precedes the meter event. An authoritative quota refusal
 * never increments; a lost store response can leave an ambiguous increment.
 */
export declare function recordSuccessfulBillable(customer: MeteredCustomer, config: MeterConfig, options: RecordBillableOptions): Promise<BillableOutcome>;
/** The customer's usage this period, without counting anything. */
export declare function peekUsage(customer: MeteredCustomer, config: MeterConfig, options: {
    ledger: UsageLedger;
    nowMs?: number;
}): Promise<{
    month: string;
    count: number;
    limit: number;
}>;
/**
 * A best-effort Stripe billing meter event.
 *
 * The ledger remains canonical. Stripe is a copy, and a copy that fails is
 * handled by the host or written off — never a reason to stop serving.
 */
export declare function reportStripeMeter(customer: MeteredCustomer, config: MeterConfig, quantity: number, nowMs?: number): Promise<void>;
/**
 * The body for a refused call.
 *
 * One place, so every route speaks one dialect for a refusal. The correlation id
 * goes in the body rather than a header, because a client that gets a 429 wants
 * to be able to quote the whole thing to support.
 */
export declare function billableDenialResponse(outcome: {
    status: number;
    body?: Record<string, unknown>;
}, correlationId: string, corsHeaders: Record<string, string>): Response;
