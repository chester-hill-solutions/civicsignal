import { dayBefore, utcDay, utcMonth } from './time.js';
import { validateOperationId } from './operation.js';
/** Existing customer objects and month/count keys remain compatible. */
export class ApiKeyUsageDO {
    state;
    constructor(state) {
        this.state = state;
    }
    async fetch(request) {
        const url = new URL(request.url);
        const period = url.searchParams.get('month') || url.searchParams.get('day') || utcMonth();
        const prefix = url.searchParams.has('month') ? 'month' : 'count';
        const limit = parseInt(url.searchParams.get('limit') || '0', 10);
        const storageKey = `${prefix}:${period}`;
        const operationId = request.headers.get('X-Usage-Operation') ?? undefined;
        if (operationId !== undefined) {
            try {
                validateOperationId(operationId);
            }
            catch {
                return this.json({ error: 'Invalid operation ID' }, 400);
            }
        }
        const receiptKey = operationId === undefined ? undefined : `operation:${storageKey}:${operationId}`;
        if (request.method === 'GET') {
            if (receiptKey !== undefined) {
                const receipt = await this.state.storage.get(receiptKey);
                if (receipt)
                    return this.json({ ...receipt, recorded: true });
            }
            const count = (await this.state.storage.get(storageKey)) || 0;
            return this.json({ day: period, month: period, count, limit, allowed: limit <= 0 || count < limit,
                ...(operationId === undefined ? {} : { operationId, recorded: false }) });
        }
        if (request.method !== 'POST')
            return this.json({ error: 'Use GET or POST' }, 405);
        // The receipt and counter must commit together, including refused decisions.
        // Retrying a transaction can never cause a second increment for the same ID.
        if (receiptKey !== undefined) {
            const result = await this.state.storage.transaction(async (transaction) => {
                const receipt = await transaction.get(receiptKey);
                if (receipt)
                    return receipt;
                const current = (await transaction.get(storageKey)) || 0;
                const allowed = limit <= 0 || current < limit;
                const count = allowed ? current + 1 : current;
                const result = { day: period, month: period, count, limit, allowed, operationId };
                await transaction.put({ ...(allowed ? { [storageKey]: count } : {}), [receiptKey]: result });
                return result;
            });
            return this.json({ ...result, recorded: true });
        }
        // Legacy clients keep their existing single-consumption wire contract.
        const current = (await this.state.storage.get(storageKey)) || 0;
        if (limit > 0 && current >= limit) {
            return this.json({ day: period, month: period, count: current, limit, allowed: false });
        }
        const next = current + 1;
        await this.state.storage.put(storageKey, next);
        if (prefix === 'count')
            await this.pruneOldDays(utcDay());
        return this.json({ day: period, month: period, count: next, limit, allowed: true });
    }
    async pruneOldDays(currentDay) {
        const cutoff = dayBefore(currentDay, 7);
        const entries = await this.state.storage.list({ prefix: 'count:' });
        await this.state.storage.delete([...entries.keys()].filter((key) => key.slice('count:'.length) < cutoff));
    }
    json(body, status = 200) {
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=UTF-8' } });
    }
}
/** A client that can reconcile an uncertain POST using its durable receipt. */
export class DurableObjectUsageLedger {
    namespace;
    options;
    supportsOperationIds = true;
    retries;
    timeoutMs;
    constructor(namespace, options = {}) {
        this.namespace = namespace;
        this.options = options;
        this.retries = options.acknowledgementRetries ?? 2;
        this.timeoutMs = options.requestTimeoutMs ?? 5000;
        if (!Number.isInteger(this.retries) || this.retries < 0 || this.retries > 4)
            throw new TypeError('acknowledgementRetries must be from zero to four.');
        if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000)
            throw new TypeError('requestTimeoutMs must be from one to 60000.');
    }
    async consumeMonthly(customerId, monthlyLimit, nowMs = Date.now(), options = {}) {
        const month = utcMonth(nowMs);
        const operationId = options.operationId;
        if (operationId !== undefined)
            validateOperationId(operationId);
        let uncertain = false;
        const attempts = operationId === undefined ? 1 : this.retries + 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                if (operationId !== undefined) {
                    // Also verifies protocol support before any write: an old DO must not
                    // ignore the operation ID and charge once per acknowledgement retry.
                    const receipt = await this.call(customerId, month, monthlyLimit, 'GET', nowMs, operationId);
                    if (receipt.recorded)
                        return receipt;
                }
                uncertain = true;
                return await this.call(customerId, month, monthlyLimit, 'POST', nowMs, operationId);
            }
            catch {
                // Never retry a POST without an operation ID. With one, the next GET
                // recovers its receipt; an absent receipt permits the same safe POST.
            }
        }
        return { allowed: this.options.failureMode !== 'closed' && monthlyLimit <= 0,
            count: 0, limit: monthlyLimit, month, day: utcDay(nowMs), unavailable: true,
            ...(uncertain ? { uncertain: true } : {}), ...(operationId === undefined ? {} : { operationId }) };
    }
    async peekMonthly(customerId, monthlyLimit, nowMs = Date.now()) {
        const month = utcMonth(nowMs);
        try {
            return await this.call(customerId, month, monthlyLimit, 'GET', nowMs);
        }
        catch {
            return { allowed: this.options.failureMode !== 'closed' && monthlyLimit <= 0,
                count: 0, limit: monthlyLimit, month, day: utcDay(nowMs), unavailable: true };
        }
    }
    async call(customerId, month, limit, method, nowMs, operationId) {
        const stub = this.namespace.get(this.namespace.idFromName(`customer:${customerId}`));
        const response = await stub.fetch(`https://usage/consume?month=${month}&limit=${limit}`, {
            method, signal: AbortSignal.timeout(this.timeoutMs),
            ...(operationId === undefined ? {} : { headers: { 'X-Usage-Operation': operationId } }),
        });
        if (!response.ok)
            throw new Error('The usage object is unavailable.');
        const result = await response.json();
        if (typeof result.allowed !== 'boolean' || !Number.isSafeInteger(result.count) || result.count < 0 ||
            result.month !== month || !Number.isSafeInteger(result.limit) || result.limit < 0 ||
            (!result.recorded && result.limit !== limit) ||
            (operationId !== undefined && (result.operationId !== operationId || typeof result.recorded !== 'boolean' || (method === 'POST' && !result.recorded)))) {
            throw new Error('The usage object returned an invalid acknowledgement.');
        }
        return { allowed: result.allowed, count: result.count, limit: result.limit, month, day: result.day ?? utcDay(nowMs),
            recorded: result.recorded ?? false, ...(operationId === undefined ? {} : { operationId }) };
    }
}
