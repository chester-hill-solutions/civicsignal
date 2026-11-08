import { cancelResponseBody, IoDeadline } from './io-deadline.js';
import { dayBefore, utcDay, utcMonth } from './time.js';
import { assertCustomerId, assertLimit, countValue, isDay, ledgerResult } from './validation.js';
/** One object per customer. Storage transactions cover the check, count and retention. */
export class ApiKeyUsageDO {
    state;
    constructor(state) {
        this.state = state;
    }
    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== '/consume')
            return new Response('Not found', { status: 404 });
        if (request.method !== 'GET' && request.method !== 'POST') {
            return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, POST' } });
        }
        const month = url.searchParams.get('month');
        const day = url.searchParams.get('day');
        const rawLimit = url.searchParams.get('limit') ?? '0';
        const limit = Number(rawLimit);
        if ((month !== null && day !== null) ||
            (month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) ||
            (day !== null && !isDay(day)) || !/^\d+$/.test(rawLimit) ||
            !Number.isSafeInteger(limit) || limit < 0) {
            return new Response('Invalid period or limit', { status: 400 });
        }
        const period = month ?? day ?? utcMonth();
        const prefix = day !== null ? 'count' : 'month';
        const key = prefix + ':' + period;
        const result = await this.state.storage.transaction(async (transaction) => {
            const stored = await transaction.get(key);
            const count = stored === undefined ? 0 : countValue(stored);
            const allowed = limit === 0 || count < limit;
            if (request.method === 'GET' || !allowed)
                return { count, allowed };
            if (count === Number.MAX_SAFE_INTEGER)
                throw new RangeError('usage counter exhausted');
            if (prefix === 'count')
                await this.pruneOldDays(transaction, utcDay());
            await transaction.put(key, count + 1);
            return { count: count + 1, allowed: true };
        });
        return Response.json({
            ...result,
            limit,
            month: period.slice(0, 7),
            ...(prefix === 'count' ? { day: period } : {}),
        });
    }
    async pruneOldDays(storage, currentDay) {
        const end = 'count:' + dayBefore(currentDay, 7);
        while (true) {
            const entries = await storage.list({ prefix: 'count:', end, limit: 128 });
            if (entries.size === 0)
                return;
            await storage.delete([...entries.keys()]);
        }
    }
}
/** Hard limits fail closed on transport, storage or wire errors; unlimited/soft use fails open. */
export class DurableObjectUsageLedger {
    namespace;
    constructor(namespace) {
        this.namespace = namespace;
    }
    async consumeMonthly(customerId, monthlyLimit, nowMs = Date.now()) {
        return this.request(customerId, monthlyLimit, nowMs, 'POST');
    }
    async peekMonthly(customerId, monthlyLimit, nowMs = Date.now()) {
        return this.request(customerId, monthlyLimit, nowMs, 'GET');
    }
    async request(customerId, limit, nowMs, method) {
        assertCustomerId(customerId);
        assertLimit(limit);
        const month = utcMonth(nowMs);
        try {
            const deadline = new IoDeadline(5_000);
            const id = this.namespace.idFromName('customer:' + customerId);
            const stub = this.namespace.get(id);
            deadline.assert();
            const response = await deadline.wait(stub.fetch('https://usage/consume?month=' + month + '&limit=' + limit, { method }), cancelResponseBody);
            if (!response.ok) {
                cancelResponseBody(response);
                throw new Error('usage object returned ' + response.status);
            }
            const result = ledgerResult(await readResponse(response, deadline), month, limit, method);
            deadline.assert();
            return { ...result, day: result.day ?? utcDay(nowMs) };
        }
        catch (error) {
            console.warn('[ApiKeyUsage] monthly counter unavailable:', error);
            return { allowed: limit === 0, count: 0, limit, month, day: utcDay(nowMs) };
        }
    }
}
async function readResponse(response, deadline) {
    if (!response.body)
        throw new TypeError('empty usage response');
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
        for (let reads = 0; reads < 128; reads++) {
            const { done, value } = await deadline.wait(reader.read());
            if (done) {
                const body = new Uint8Array(bytes);
                let offset = 0;
                for (const chunk of chunks) {
                    body.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
                deadline.assert();
                return value;
            }
            if (!(value instanceof Uint8Array) || value.byteLength === 0)
                throw new TypeError('invalid usage response chunk');
            bytes += value.byteLength;
            if (bytes > 4096)
                throw new RangeError('usage response exceeds 4096 bytes');
            chunks.push(value);
        }
        throw new RangeError('too many usage response chunks');
    }
    finally {
        void reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
