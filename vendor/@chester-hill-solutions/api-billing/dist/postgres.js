import { utcDay, utcMonth } from './time.js';
import { assertCustomerId, assertLimit, countValue } from './validation.js';
/** One atomic upsert decides and counts; refused calls never increment. */
export class PostgresUsageLedger {
    sql;
    table;
    constructor(sql, table = 'usage_counters') {
        this.sql = sql;
        const names = table.split('.');
        if (names.length > 2 || names.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
            throw new TypeError('usage table must be a table name or schema.table');
        }
        this.table = names.map(name => '"' + name + '"').join('.');
    }
    async consumeMonthly(customerId, monthlyLimit, nowMs = Date.now()) {
        assertCustomerId(customerId);
        assertLimit(monthlyLimit);
        const month = utcMonth(nowMs);
        const day = utcDay(nowMs);
        try {
            const rows = await this.sql.unsafe(`INSERT INTO ${this.table} AS counter (customer_id, period, count)
         VALUES ($1, $2, 1)
         ON CONFLICT (customer_id, period) DO UPDATE
            SET count = counter.count + 1
          WHERE ($3::bigint = 0 OR counter.count < $3::bigint) AND counter.count < 9007199254740991
         RETURNING count`, [customerId, month, monthlyLimit]);
            if (rows.length === 0) {
                const current = await this.read(customerId, month);
                if (monthlyLimit === 0 || current < monthlyLimit)
                    throw new Error('usage update returned no counter');
                return { allowed: false, count: current, limit: monthlyLimit, month, day };
            }
            if (rows.length !== 1)
                throw new TypeError('usage update returned multiple counters');
            const count = sqlCount(rows[0]);
            if (count === 0 || (monthlyLimit > 0 && count > monthlyLimit))
                throw new TypeError('invalid updated count');
            return { allowed: true, count, limit: monthlyLimit, month, day };
        }
        catch (error) {
            console.warn('[ApiKeyUsage] monthly SQL counter unavailable:', error);
            return { allowed: monthlyLimit === 0, count: 0, limit: monthlyLimit, month, day };
        }
    }
    async peekMonthly(customerId, monthlyLimit, nowMs = Date.now()) {
        assertCustomerId(customerId);
        assertLimit(monthlyLimit);
        const month = utcMonth(nowMs);
        try {
            const count = await this.read(customerId, month);
            return { allowed: monthlyLimit === 0 || count < monthlyLimit, count, limit: monthlyLimit, month, day: utcDay(nowMs) };
        }
        catch (error) {
            console.warn('[ApiKeyUsage] monthly SQL counter unavailable:', error);
            return { allowed: monthlyLimit === 0, count: 0, limit: monthlyLimit, month, day: utcDay(nowMs) };
        }
    }
    async read(customerId, month) {
        const rows = await this.sql.unsafe(`SELECT count FROM ${this.table} WHERE customer_id = $1 AND period = $2`, [customerId, month]);
        if (rows.length > 1)
            throw new TypeError('usage read returned multiple counters');
        return rows.length === 0 ? 0 : sqlCount(rows[0]);
    }
}
function sqlCount(row) {
    if (typeof row !== 'object' || row === null || !('count' in row))
        throw new TypeError('missing usage counter');
    const value = row.count;
    if (typeof value === 'string' && /^\d+$/.test(value))
        return countValue(Number(value));
    return countValue(value);
}
/** Initial schema: BIGINT storage is bounded to JavaScript's exact integer range. */
export const USAGE_COUNTERS_DDL = `
CREATE TABLE IF NOT EXISTS usage_counters (
  customer_id TEXT NOT NULL,
  period      TEXT NOT NULL,
  count       BIGINT NOT NULL DEFAULT 0 CHECK (count BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (customer_id, period)
);
`;
