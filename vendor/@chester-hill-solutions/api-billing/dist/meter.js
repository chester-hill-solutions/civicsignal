import { cancelResponseBody, IoDeadline } from './io-deadline.js';
import { effectiveFuseLimit, enforcementLimit } from './fuse.js';
import { utcMonth } from './time.js';
import { assertCustomerId } from './validation.js';
/**
 * After a successful call: count it, enforce the fuse, and report it.
 *
 * The fuse decision precedes the meter event. An authoritative quota refusal
 * never increments; a lost store response can leave an ambiguous increment.
 */
export async function recordSuccessfulBillable(customer, config, options) {
    const nowMs = options.nowMs ?? Date.now();
    const limit = effectiveFuseLimit(customer, config.freeFuseLimit);
    const softWarn = customer.fuseSoftWarn;
    // A soft fuse warns; it does not refuse. So the enforced limit is zero, which
    // every ledger reads as "count it and allow it".
    const enforced = enforcementLimit(customer, config.freeFuseLimit);
    assertCustomerId(customer.id);
    let usage;
    try {
        usage = await options.ledger.consumeMonthly(customer.id, enforced, nowMs);
    }
    catch (error) {
        console.warn('[Billing] usage ledger unavailable:', error);
        usage = { allowed: enforced === 0, count: 0, limit: enforced, month: utcMonth(nowMs) };
    }
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
        const task = reportStripeMeter(customer, config, 1, nowMs);
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
 * handled by the host or written off — never a reason to stop serving.
 */
export async function reportStripeMeter(customer, config, quantity, nowMs = Date.now()) {
    if (!Number.isSafeInteger(quantity) || quantity <= 0)
        throw new TypeError('meter quantity must be a positive safe integer');
    if (!config.meterEventName.trim() || config.meterEventName.length > 100) {
        throw new TypeError('meter event name must contain 1 to 100 characters');
    }
    const timestamp = Math.floor(nowMs / 1000);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0)
        throw new TypeError('invalid meter timestamp');
    const secret = config.stripeSecretKey;
    if (!secret || !customer.stripeCustomerId)
        return;
    try {
        const deadline = new IoDeadline(10_000);
        const body = new URLSearchParams();
        body.set('event_name', config.meterEventName);
        body.set('payload[stripe_customer_id]', customer.stripeCustomerId);
        body.set('payload[value]', String(quantity));
        body.set('identifier', crypto.randomUUID());
        body.set('timestamp', String(timestamp));
        deadline.assert();
        const res = await deadline.wait(fetch('https://api.stripe.com/v1/billing/meter_events', {
            method: 'POST',
            signal: deadline.signal,
            headers: {
                Authorization: `Bearer ${secret}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
        }), cancelResponseBody);
        if (!res.ok) {
            console.warn('[StripeMeter] the event failed:', res.status);
        }
        if (res.body)
            await deadline.wait(res.body.cancel());
        deadline.assert();
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
