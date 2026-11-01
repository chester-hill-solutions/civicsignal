import { utcDay, utcMonth } from './time.js';
import { validateOperationId } from './operation.js';
/**
 * An in-memory ledger.
 *
 * A test double implementing intent, not wire format. It counts the same way the
 * real ones do — a refused call is not counted — so a test that passes against
 * it means something about the policy rather than about the double.
 */
export class InMemoryUsageLedger {
    seed;
    supportsOperationIds = true;
    counts = new Map();
    receipts = new Map();
    constructor(seed) {
        this.seed = seed;
        if (seed)
            for (const [key, value] of seed)
                this.counts.set(key, value);
    }
    key(customerId, month) {
        return `${customerId}:${month}`;
    }
    async consumeMonthly(customerId, monthlyLimit, nowMs = Date.now(), options = {}) {
        const month = utcMonth(nowMs);
        const operationId = options.operationId;
        if (operationId !== undefined)
            validateOperationId(operationId);
        const receiptKey = operationId === undefined ? undefined : JSON.stringify([customerId, month, operationId]);
        const receipt = receiptKey === undefined ? undefined : this.receipts.get(receiptKey);
        if (receipt)
            return { ...receipt };
        const key = this.key(customerId, month);
        const current = this.counts.get(key) ?? 0;
        if (monthlyLimit > 0 && current >= monthlyLimit) {
            // Refused, and deliberately not counted.
            const result = { allowed: false, count: current, limit: monthlyLimit, month, day: utcDay(nowMs), ...(operationId === undefined ? {} : { operationId }) };
            if (receiptKey !== undefined)
                this.receipts.set(receiptKey, result);
            return result;
        }
        const next = current + 1;
        this.counts.set(key, next);
        const result = { allowed: true, count: next, limit: monthlyLimit, month, day: utcDay(nowMs), ...(operationId === undefined ? {} : { operationId }) };
        if (receiptKey !== undefined)
            this.receipts.set(receiptKey, result);
        return result;
    }
    async peekMonthly(customerId, monthlyLimit, nowMs = Date.now()) {
        const month = utcMonth(nowMs);
        const count = this.counts.get(this.key(customerId, month)) ?? 0;
        return { allowed: monthlyLimit <= 0 || count < monthlyLimit, count, limit: monthlyLimit, month, day: utcDay(nowMs) };
    }
}
/**
 * A ledger that always says the same thing.
 *
 * For a product whose metering is not configured, and for tests that care about
 * something else.
 */
export class StaticUsageLedger {
    result;
    constructor(result = {}) {
        this.result = result;
    }
    async consumeMonthly(_customerId, monthlyLimit, nowMs = Date.now()) {
        return {
            allowed: true,
            count: 0,
            limit: monthlyLimit,
            month: utcMonth(nowMs),
            day: utcDay(nowMs),
            ...this.result,
        };
    }
    async peekMonthly(_customerId, monthlyLimit, nowMs = Date.now()) {
        return {
            allowed: true,
            count: 0,
            limit: monthlyLimit,
            month: utcMonth(nowMs),
            day: utcDay(nowMs),
            ...this.result,
        };
    }
}
