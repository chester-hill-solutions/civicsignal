import { effectiveFuseLimit, enforcementLimit } from './fuse.js';
import { operationDigest, validateOperationId } from './operation.js';
import { utcMonth } from './time.js';
/**
 * After a successful call: count it, enforce the fuse, and report it.
 *
 * The fuse is enforced *before* the meter event, so a refused call is neither
 * counted beyond its limit nor reported.
 */
export async function recordSuccessfulBillable(customer, config, options) {
    const nowMs = options.nowMs ?? Date.now();
    const limit = effectiveFuseLimit(customer, config.freeFuseLimit);
    const softWarn = customer.fuseSoftWarn;
    // A soft fuse warns; it does not refuse. So the enforced limit is zero, which
    // every ledger reads as "count it and allow it".
    const enforced = enforcementLimit(customer, config.freeFuseLimit);
    const unavailable = (uncertain = false) => ({
        allowed: false, status: 503,
        body: { code: 'USAGE_UNAVAILABLE', error: 'The usage ledger could not confirm this operation.',
            month: utcMonth(nowMs), uncertain,
            ...(options.operationId === undefined ? {} : { operationId: options.operationId }) },
    });
    if (options.operationId !== undefined) {
        validateOperationId(options.operationId);
        if (!options.ledger.supportsOperationIds)
            return unavailable();
    }
    let usage;
    try {
        usage = await options.ledger.consumeMonthly(customer.id, enforced, nowMs, { operationId: options.operationId });
    }
    catch {
        return unavailable(true);
    }
    if (usage.unavailable && (options.usageFailureMode === 'closed' || !usage.allowed))
        return unavailable(usage.uncertain);
    if (!usage.allowed) {
        return {
            allowed: false,
            status: 429,
            body: {
                error: 'Monthly usage fuse exceeded',
                code: 'FUSE_EXCEEDED',
                count: usage.count,
                limit,
                month: usage.month,
            },
        };
    }
    if (softWarn && limit > 0 && usage.count > limit) {
        console.warn(`[Billing] customer ${customer.id} is over its fuse (${usage.count}/${limit}) soft-warn`);
    }
    if (customer.plan === 'metered' || customer.plan === 'enterprise') {
        const task = reportStripeMeter(customer, config, 1, nowMs, options.operationId);
        if (options.waitUntil)
            options.waitUntil(task);
        else
            await task;
    }
    return { allowed: true, status: 200 };
}
/** The customer's usage this period, without counting anything. */
export async function peekUsage(customer, config, options) {
    const nowMs = options.nowMs ?? Date.now();
    const limit = effectiveFuseLimit(customer, config.freeFuseLimit);
    const usage = await options.ledger.peekMonthly(customer.id, limit, nowMs);
    return { month: usage.month || utcMonth(nowMs), count: usage.count, limit };
}
/**
 * A best-effort Stripe billing meter event.
 *
 * The ledger remains canonical. Stripe is a copy, and a copy that fails is
 * retried later or written off — never a reason to stop serving.
 */
export async function reportStripeMeter(customer, config, quantity, nowMs = Date.now(), operationId) {
    const secret = config.stripeSecretKey;
    if (!secret || !customer.stripeCustomerId)
        return;
    try {
        const body = new URLSearchParams();
        body.set('event_name', config.meterEventName);
        body.set('payload[stripe_customer_id]', customer.stripeCustomerId);
        body.set('payload[value]', String(quantity));
        body.set('identifier', operationId === undefined ? `${customer.id}:${utcMonth(nowMs)}:${crypto.randomUUID()}`
            : `chs:${await operationDigest(JSON.stringify([customer.id, utcMonth(nowMs), operationId]))}`);
        const res = await fetch('https://api.stripe.com/v1/billing/meter_events', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${secret}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
        });
        if (!res.ok) {
            console.warn('[StripeMeter] the event failed:', res.status, await res.text());
        }
    }
    catch (error) {
        console.warn('[StripeMeter] unavailable:', error);
    }
}
/**
 * The body for a refused call.
 *
 * One place, so every route speaks one dialect for a refusal. The correlation id
 * goes in the body rather than a header, because a client that gets a 429 wants
 * to be able to quote the whole thing to support.
 */
export function billableDenialResponse(outcome, correlationId, corsHeaders) {
    return new Response(JSON.stringify({ ...(outcome.body ?? {}), correlationId }), {
        status: outcome.status,
        headers: {
            'content-type': 'application/json; charset=UTF-8',
            ...corsHeaders,
        },
    });
}
