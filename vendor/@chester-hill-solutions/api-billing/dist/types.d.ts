/**
 * The shapes the metering is written against.
 *
 * Nothing here names a runtime. A customer is whoever the product says is billed,
 * a ledger is wherever the counters live, and the fuse is the policy that decides
 * whether this call is allowed.
 */
/** The plan a customer is on. What it buys is the product's business, not this package's. */
export type CustomerPlan = 'free' | 'metered' | 'enterprise';
/**
 * The customer, as the metering needs it.
 *
 * A product that has a richer customer model maps it onto this. The house's
 * `auth` package already has the concept — a workspace, with an id — and a
 * product's customer *is* a workspace, so this is a narrower view of one.
 */
export interface MeteredCustomer {
    id: string;
    plan: CustomerPlan;
    /**
     * The monthly allowance in billable units. Zero means unlimited.
     *
     * A customer can also override the plan's default, which is what an
     * enterprise arrangement looks like: the plan says "metered", and the
     * contract says how many calls.
     */
    fuseLimit: number;
    /**
     * When the limit is exceeded, warn rather than refuse.
     *
     * This is not a smaller limit. It is a different *failure mode*: a soft fuse
     * keeps serving and tells the operator, a hard fuse refuses.
     */
    fuseSoftWarn: boolean;
    /** The Stripe customer, when the meter reports to Stripe. */
    stripeCustomerId?: string;
}
/** Optional identity for one consumption, scoped to a customer and UTC month. */
export interface UsageConsumeOptions {
    /** Reuse this ID and the same nowMs when acknowledging/reconciling one operation. */
    operationId?: string;
}
/** The result of asking the ledger whether a call is allowed. */
export interface UsageLedgerResult {
    /** Whether the call may proceed. */
    allowed: boolean;
    /** The count after the call, or the count at the limit when it was refused. */
    count: number;
    /** The limit that was enforced. Zero means unlimited. */
    limit: number;
    /** The billing period, `YYYY-MM`. */
    month: string;
    /** The daily period, `YYYY-MM-DD`, when the ledger counts days as well. */
    day?: string;
    /** The store could not confirm its state; this is not an exhausted fuse. */
    unavailable?: boolean;
    /** A consumption may have committed, but could not be acknowledged. */
    uncertain?: boolean;
    /** Present only when the store acknowledges an idempotent operation. */
    operationId?: string;
}
/**
 * Where the counters live.
 *
 * The interface is the seam between the policy — which is the same everywhere —
 * and the store, which is not. A Durable Object, a Postgres table and an
 * in-memory map all satisfy it, and the fuse behaves identically in all three.
 */
export interface UsageLedger {
    /** True only when operation IDs are atomically deduplicated by this store. */
    readonly supportsOperationIds?: boolean;
    /**
     * Count one call and say whether it was allowed.
     *
     * A refused call is **not** counted. An attacker who keeps trying should not
     * push the counter up and make the number meaningless.
     */
    consumeMonthly(customerId: string, monthlyLimit: number, nowMs?: number, options?: UsageConsumeOptions): Promise<UsageLedgerResult>;
    /** Read the count without changing it. */
    peekMonthly(customerId: string, monthlyLimit: number, nowMs?: number): Promise<UsageLedgerResult>;
}
/** What the product configures about the meter. */
export interface MeterConfig {
    /** The default monthly allowance for the free plan. */
    freeFuseLimit: number;
    /** The Stripe secret, when the meter reports to Stripe. */
    stripeSecretKey?: string;
    /**
     * The Stripe billing meter event name.
     *
     * Required rather than defaulted: the name belongs to the product's Stripe
     * account, and a default would silently report events under the wrong name.
     */
    meterEventName: string;
}
