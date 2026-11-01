import { utcDay, utcMonth } from './time.js';
import { validateOperationId } from './operation.js';
function identifier(value) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?$/.test(value))
        throw new TypeError('Invalid usage table identifier.');
    return value;
}
/**
 * The ledger in Postgres.
 *
 * One statement does the counting and the deciding, which is what makes the
 * counter trustworthy under concurrency: two requests arriving together cannot
 * both see "29 of 30" and both be allowed.
 *
 * A **refused call is not counted.** The `WHERE` clause on the update is what
 * does that — when the count has reached the limit, the row is not updated and
 * no row comes back, and that absence is the refusal. An attacker who keeps
 * trying must not be able to push the counter up and make the number
 * meaningless.
 */
export class PostgresUsageLedger {
    sql;
    table;
    operationTable;
    retries;
    get supportsOperationIds() { return this.sql.transaction !== undefined; }
    constructor(sql, 
    /** The table holding the counters. */
    table = 'usage_counters', options = {}) {
        this.sql = sql;
        this.table = table;
        identifier(table);
        this.operationTable = identifier(options.operationTable ?? 'usage_operations');
        this.retries = options.acknowledgementRetries ?? 2;
        if (!Number.isInteger(this.retries) || this.retries < 0 || this.retries > 4)
            throw new TypeError('acknowledgementRetries must be from zero to four.');
    }
    async consumeMonthly(customerId, monthlyLimit, nowMs = Date.now(), options = {}) {
        if (options.operationId !== undefined) {
            validateOperationId(options.operationId);
            return this.consumeOperation(customerId, monthlyLimit, nowMs, options.operationId);
        }
        const month = utcMonth(nowMs);
        const day = utcDay(nowMs);
        const rows = await this.sql.unsafe(`INSERT INTO ${this.table} (customer_id, period, count)
       VALUES ($1, $2, 1)
       ON CONFLICT (customer_id, period) DO UPDATE
          SET count = ${this.table}.count + 1
        WHERE $3 = 0 OR ${this.table}.count < $3
       RETURNING count`, [customerId, month, monthlyLimit]);
        if (rows.length === 0) {
            // The limit was reached, so nothing was counted. Read the count so the
            // caller can say where the customer is.
            const current = await this.sql.unsafe(`SELECT count FROM ${this.table} WHERE customer_id = $1 AND period = $2`, [customerId, month]);
            return {
                allowed: false,
                count: Number(current[0]?.count ?? 0),
                limit: monthlyLimit,
                month,
                day,
            };
        }
        return {
            allowed: true,
            count: Number(rows[0].count),
            limit: monthlyLimit,
            month,
            day,
        };
    }
    async consumeOperation(customerId, limit, nowMs, operationId) {
        const month = utcMonth(nowMs);
        const day = utcDay(nowMs);
        const unavailable = (uncertain) => ({
            allowed: false, count: 0, limit, month, day, unavailable: true, uncertain, operationId,
        });
        if (!this.sql.transaction)
            return unavailable(false);
        for (let attempt = 0; attempt <= this.retries; attempt++) {
            try {
                return await this.sql.transaction(async (transaction) => {
                    // The existing counter row is the serialization point for both legacy
                    // upserts and operation-aware calls. Read the receipt AFTER locking it.
                    await transaction.unsafe(`INSERT INTO ${this.table}(customer_id,period,count) VALUES($1,$2,0)
            ON CONFLICT(customer_id,period) DO NOTHING`, [customerId, month]);
                    const counters = await transaction.unsafe(`SELECT count FROM ${this.table}
            WHERE customer_id=$1 AND period=$2 FOR UPDATE`, [customerId, month]);
                    const receipts = await transaction.unsafe(`SELECT allowed,count,enforced_limit FROM ${this.operationTable}
            WHERE customer_id=$1 AND period=$2 AND operation_id=$3`, [customerId, month, operationId]);
                    const existing = receipts[0];
                    if (existing)
                        return { allowed: existing.allowed, count: Number(existing.count),
                            limit: Number(existing.enforced_limit), month, day, operationId };
                    const current = Number(counters[0].count);
                    const allowed = limit <= 0 || current < limit;
                    const count = allowed ? current + 1 : current;
                    if (allowed)
                        await transaction.unsafe(`UPDATE ${this.table} SET count=$3
            WHERE customer_id=$1 AND period=$2`, [customerId, month, count]);
                    await transaction.unsafe(`INSERT INTO ${this.operationTable}
            (customer_id,period,operation_id,allowed,count,enforced_limit) VALUES($1,$2,$3,$4,$5,$6)`, [customerId, month, operationId, allowed, count, limit]);
                    return { allowed, count, limit, month, day, operationId };
                });
            }
            catch {
                // The prior transaction may have committed. The same operation ID and
                // locked receipt lookup make another acknowledgement attempt safe.
            }
        }
        return unavailable(true);
    }
    async peekMonthly(customerId, monthlyLimit, nowMs = Date.now()) {
        const month = utcMonth(nowMs);
        const rows = await this.sql.unsafe(`SELECT count FROM ${this.table} WHERE customer_id = $1 AND period = $2`, [customerId, month]);
        const count = Number(rows[0]?.count ?? 0);
        return {
            allowed: monthlyLimit <= 0 || count < monthlyLimit,
            count,
            limit: monthlyLimit,
            month,
            day: utcDay(nowMs),
        };
    }
}
/**
 * The table the Postgres ledger needs.
 *
 * One row per customer per period. The primary key is what makes the upsert
 * atomic, and the period is a string so that a monthly and a daily counter can
 * live in the same table without a second one.
 */
export const USAGE_COUNTERS_DDL = `
CREATE TABLE IF NOT EXISTS usage_counters (
  customer_id TEXT NOT NULL,
  period      TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (customer_id, period)
);
`;
/** Apply this additive DDL before using operation IDs with an existing ledger. */
export const USAGE_OPERATIONS_DDL = `
CREATE TABLE IF NOT EXISTS usage_operations (
  customer_id TEXT NOT NULL,
  period TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  allowed BOOLEAN NOT NULL,
  count INTEGER NOT NULL,
  enforced_limit INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (customer_id, period, operation_id)
);
`;
