import type { MeteredCustomer } from './types.js';
/**
 * The fuse.
 *
 * A fuse is a limit that the service applies to itself, and the whole point of
 * one is what happens when the thing it guards is unavailable.
 *
 * Two policies, and they are not variations on the same idea:
 *
 * - A **hard** fuse fails **closed**. If the counter cannot be read, the call is
 *   refused. Free-tier abuse must be bounded even during an outage, and a limit
 *   that lifts when the database is down is not a limit.
 * - A **soft** fuse fails **open**. If the counter cannot be read, the call is
 *   allowed. Availability must not depend on the counter, and the cost of a
 *   wrong answer here is a few unbilled calls rather than a product that is down.
 *
 * Getting this backwards is invisible in testing and expensive in production, so
 * it is stated in one place and used from one place.
 */
/** The result of a refusal that is a policy decision rather than a failure. */
export declare function failClosed(limit: number, month: string): {
    allowed: false;
    count: number;
    limit: number;
    month: string;
};
/** The result of a call that is allowed because the counter was unavailable. */
export declare function failOpen(limit: number, month: string): {
    allowed: true;
    count: number;
    limit: number;
    month: string;
};
/**
 * The limit that applies to a customer.
 *
 * A customer who has set their own limit has one, whatever their plan says.
 * Otherwise the free plan has the default and everyone else is unlimited.
 */
export declare function effectiveFuseLimit(customer: MeteredCustomer, freeFuseLimit: number): number;
/**
 * The limit to *enforce*, which is not the same as the limit to *report*.
 *
 * A soft fuse warns; it does not refuse. So the enforced limit is zero — which
 * every ledger reads as "count it and allow it" — while the reported limit stays
 * the real one, so the warning can say "you are over".
 */
export declare function enforcementLimit(customer: MeteredCustomer, freeFuseLimit: number): number;
