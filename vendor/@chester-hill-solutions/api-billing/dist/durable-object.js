import { dayBefore, utcDay, utcMonth } from './time.js';
import { validateOperationId } from './operation.js';
const RESERVATION_LEASE_MS = 60_000;
const RESERVATION_PROTOCOL = 1;
const expiryKey = (prefix, expiresAt) => `${prefix}${String(expiresAt).padStart(16, '0')}:`;
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
        const reservationRoute = url.pathname === '/reservation';
        const settleReservation = url.pathname === '/reservation/consume';
        if (reservationRoute || settleReservation) {
            if (prefix !== 'month' || !/^\d{4}-\d{2}$/.test(period) || !Number.isSafeInteger(limit) || limit <= 0 || !operationId || !receiptKey) {
                return this.json({ error: 'Invalid usage reservation request' }, 400);
            }
            if (reservationRoute)
                return this.reservation(request.method, storageKey, receiptKey, period, limit, operationId);
            if (request.method !== 'PATCH')
                return this.json({ error: 'Use PATCH' }, 405);
        }
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
        if (!settleReservation && request.method !== 'POST')
            return this.json({ error: 'Use GET or POST' }, 405);
        // Check live holds and write the receipt/counter in the same transaction.
        const result = await this.state.storage.transaction(async (transaction) => {
            if (receiptKey) {
                const receipt = await transaction.get(receiptKey);
                if (receipt)
                    return receipt;
            }
            const current = (await transaction.get(storageKey)) || 0;
            const now = Date.now();
            const key = `reservation:${storageKey}:${operationId}`;
            const hold = prefix === 'month' && operationId ? await transaction.get(key) : undefined;
            if (hold && !settleReservation)
                return null;
            if (settleReservation && (!hold || hold.released || hold.expiresAt <= now || hold.limit !== limit))
                return null;
            const allowed = hold !== undefined || limit <= 0 ||
                (current < limit && (prefix !== 'month' || await this.hasSpareCapacity(transaction, storageKey, limit - current, now)));
            const count = allowed ? current + 1 : current;
            const result = { day: period, month: period, count, limit, allowed, operationId };
            if (hold) {
                const index = expiryKey(`reservation-active:${storageKey}:`, hold.expiresAt);
                await transaction.delete(`${index}${operationId}`);
                await transaction.delete(key);
            }
            if (allowed || receiptKey) {
                await transaction.put({ ...(allowed ? { [storageKey]: count } : {}), ...(receiptKey ? { [receiptKey]: result } : {}) });
            }
            return result;
        });
        if (result === null) {
            if (!settleReservation)
                return this.json({ error: 'Use reserved consumption for this operation' }, 409);
            return this.json({ reservationProtocol: RESERVATION_PROTOCOL, reservationUnavailable: true, month: period, operationId });
        }
        if (result.allowed && prefix === 'count' && !receiptKey)
            await this.pruneOldDays(utcDay());
        return this.json({ ...result, ...(receiptKey ? { recorded: true } : {}),
            ...(settleReservation ? { reservationProtocol: RESERVATION_PROTOCOL } : {}) });
    }
    async hasSpareCapacity(transaction, storageKey, remaining, now) {
        const latest = await transaction.get(`reservation-latest:${storageKey}`);
        if (latest === undefined || latest <= now)
            return true;
        const prefix = `reservation-active:${storageKey}:`;
        const end = `${prefix}~`;
        let start = expiryKey(prefix, now + 1);
        for (;;) {
            const limit = Math.min(remaining, 100);
            const active = await transaction.list({ start, end, limit });
            if (active.size < limit)
                return true;
            remaining -= active.size;
            if (remaining === 0)
                return false;
            start = `${Array.from(active.keys()).at(-1)}\0`;
        }
    }
    async reservation(method, storageKey, receiptKey, month, limit, operationId) {
        const protocol = { reservationProtocol: RESERVATION_PROTOCOL, month, operationId };
        if (method === 'GET')
            return this.json(protocol);
        if (method !== 'PUT' && method !== 'DELETE')
            return this.json({ error: 'Use GET, PUT or DELETE' }, 405);
        const key = `reservation:${storageKey}:${operationId}`;
        const prefix = `reservation-active:${storageKey}:`;
        const latestKey = `reservation-latest:${storageKey}`;
        const result = await this.state.storage.transaction(async (transaction) => {
            const now = Date.now();
            const hold = await transaction.get(key);
            if (method === 'DELETE') {
                if (hold && !hold.released) {
                    await transaction.delete(`${expiryKey(prefix, hold.expiresAt)}${operationId}`);
                    await transaction.put({ [key]: { ...hold, released: true } });
                }
                return { released: true };
            }
            const count = (await transaction.get(storageKey)) || 0;
            const response = { count, limit, allowed: false };
            if (hold) {
                return !hold.released && hold.expiresAt > now && hold.limit === limit
                    ? { ...response, allowed: true, expiresAt: hold.expiresAt }
                    : { ...response, unavailable: true };
            }
            if (await transaction.get(receiptKey))
                return { ...response, unavailable: true };
            if (count >= limit || !await this.hasSpareCapacity(transaction, storageKey, limit - count, now))
                return response;
            // Bound cleanup to a small page. Expired index entries never consume capacity.
            const expired = await transaction.list({ start: prefix, end: expiryKey(prefix, now + 1), limit: 16 });
            if (expired.size)
                await transaction.delete([...expired.keys()]);
            const expiresAt = now + RESERVATION_LEASE_MS;
            const latest = await transaction.get(latestKey);
            await transaction.put({
                [key]: { expiresAt, limit },
                [`${expiryKey(prefix, expiresAt)}${operationId}`]: true,
                [latestKey]: Math.max(expiresAt, latest ?? 0),
            });
            return { ...response, allowed: true, expiresAt };
        });
        return this.json({ ...result, ...protocol });
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
        return this.consume(customerId, monthlyLimit, nowMs, options.operationId, false);
    }
    async consumeReservedMonthly(customerId, monthlyLimit, nowMs, options = {}) {
        if (options.operationId === undefined)
            throw new TypeError('A reserved consumption requires an operation ID.');
        return this.consume(customerId, monthlyLimit, nowMs, options.operationId, true);
    }
    async reserveMonthly(customerId, limit, nowMs, operationId) {
        validateOperationId(operationId);
        const month = utcMonth(nowMs);
        for (let attempt = 0; attempt <= this.retries; attempt++) {
            try {
                await this.reservationCall(customerId, month, limit, operationId, 'GET');
                const result = await this.reservationCall(customerId, month, limit, operationId, 'PUT');
                if (typeof result.allowed !== 'boolean' || !Number.isSafeInteger(result.count) || result.count < 0 ||
                    result.limit !== limit || (result.allowed && !Number.isSafeInteger(result.expiresAt))) {
                    throw new Error('Invalid usage reservation acknowledgement.');
                }
                return { month, limit, operationId, count: result.count, allowed: result.allowed,
                    ...(result.allowed ? { expiresAt: result.expiresAt } : {}),
                    ...(result.unavailable === true ? { unavailable: true } : {}) };
            }
            catch {
                // Retry only the same reservation. A hold does not increment the counter.
            }
        }
        return { allowed: false, count: 0, limit, month, operationId, unavailable: true };
    }
    async releaseMonthly(customerId, limit, nowMs, operationId) {
        validateOperationId(operationId);
        const result = await this.reservationCall(customerId, utcMonth(nowMs), limit, operationId, 'DELETE');
        if (result.released !== true)
            throw new Error('Invalid usage reservation release.');
    }
    async reservationCall(customerId, month, limit, operationId, method) {
        const response = await this.fetchUsage(customerId, month, limit, 'reservation', method, operationId);
        const result = await response.json();
        if (result.reservationProtocol !== RESERVATION_PROTOCOL || result.month !== month || result.operationId !== operationId) {
            throw new Error('The usage object does not acknowledge the reservation protocol.');
        }
        return result;
    }
    async consume(customerId, monthlyLimit, nowMs, operationId, reserved) {
        const month = utcMonth(nowMs);
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
                if (reserved)
                    await this.reservationCall(customerId, month, monthlyLimit, operationId, 'GET');
                uncertain = true;
                return await this.call(customerId, month, monthlyLimit, 'POST', nowMs, operationId, reserved);
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
    async fetchUsage(customerId, month, limit, path, method, operationId) {
        const stub = this.namespace.get(this.namespace.idFromName(`customer:${customerId}`));
        const response = await stub.fetch(`https://usage/${path}?month=${month}&limit=${limit}`, {
            method, signal: AbortSignal.timeout(this.timeoutMs),
            ...(operationId === undefined ? {} : { headers: { 'X-Usage-Operation': operationId } }),
        });
        if (!response.ok)
            throw new Error('The usage object is unavailable.');
        return response;
    }
    async call(customerId, month, limit, method, nowMs, operationId, reserved = false) {
        const response = await this.fetchUsage(customerId, month, limit, reserved ? 'reservation/consume' : 'consume', reserved ? 'PATCH' : method, operationId);
        const result = await response.json();
        if (reserved) {
            if (result.reservationProtocol !== RESERVATION_PROTOCOL || result.month !== month || result.operationId !== operationId) {
                throw new Error('The usage object does not acknowledge the reservation protocol.');
            }
            if (result.reservationUnavailable === true)
                return { allowed: false, count: 0, limit, month, operationId, unavailable: true, recorded: false };
        }
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
