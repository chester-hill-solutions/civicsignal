export function assertLimit(limit) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new TypeError('usage limit must be a nonnegative safe integer; zero means unlimited');
    }
}
export function assertCustomerId(customerId) {
    if (typeof customerId !== 'string' || customerId.trim().length === 0) {
        throw new TypeError('customer id must be a nonempty string');
    }
}
export function countValue(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError('usage count must be a nonnegative safe integer');
    }
    return value;
}
export function isDay(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function ledgerResult(value, month, limit, method) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError('invalid usage response');
    }
    const result = value;
    const count = countValue(result.count);
    const consistent = result.allowed === true
        ? limit === 0 || (method === 'POST' ? count <= limit : count < limit)
        : result.allowed === false && limit > 0 && count >= limit;
    if (typeof result.allowed !== 'boolean' || result.limit !== limit || result.month !== month ||
        !consistent || (method === 'POST' && result.allowed && count === 0)) {
        throw new TypeError('inconsistent usage response');
    }
    if (result.day !== undefined &&
        (typeof result.day !== 'string' || !isDay(result.day) || !result.day.startsWith(month + '-'))) {
        throw new TypeError('invalid usage response day');
    }
    return {
        allowed: result.allowed,
        count,
        limit,
        month,
        ...(typeof result.day === 'string' ? { day: result.day } : {}),
    };
}
