import type { UsageConsumeOptions, UsageLedger, UsageLedgerResult } from './types.js';
/**
 * The slice of a SQL client this adapter needs.
 *
 * Structural rather than postgres.js's own type, so the adapter can be tested
 * against PGlite — and so it is not tied to one driver. The atomicity of the
 * counter is the claim that matters here, and it has to be testable to be worth
 * making.
 */
export interface SqlRunner {
    unsafe(query: string, params?: unknown[]): Promise<unknown[]>;
    /** Execute work on the same connection inside one database transaction. */
    transaction?<T>(work: (transaction: SqlRunner) => Promise<T>): Promise<T>;
}
export interface PostgresLedgerOptions {
    /** Additive receipt table; defaults to usage_operations. */
    operationTable?: string;
    /** Additional attempts after an uncertain transaction acknowledgement, zero to four. */
    acknowledgementRetries?: number;
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
export declare class PostgresUsageLedger implements UsageLedger {
    private readonly sql;
    /** The table holding the counters. */
    private readonly table;
    private readonly operationTable;
    private readonly retries;
    get supportsOperationIds(): boolean;
    constructor(sql: SqlRunner, 
    /** The table holding the counters. */
    table?: string, options?: PostgresLedgerOptions);
    consumeMonthly(customerId: string, monthlyLimit: number, nowMs?: number, options?: UsageConsumeOptions): Promise<UsageLedgerResult>;
    private consumeOperation;
    peekMonthly(customerId: string, monthlyLimit: number, nowMs?: number): Promise<UsageLedgerResult>;
}
/**
 * The table the Postgres ledger needs.
 *
 * One row per customer per period. The primary key is what makes the upsert
 * atomic, and the period is a string so that a monthly and a daily counter can
 * live in the same table without a second one.
 */
export declare const USAGE_COUNTERS_DDL = "\nCREATE TABLE IF NOT EXISTS usage_counters (\n  customer_id TEXT NOT NULL,\n  period      TEXT NOT NULL,\n  count       INTEGER NOT NULL DEFAULT 0,\n  PRIMARY KEY (customer_id, period)\n);\n";
/** Apply this additive DDL before using operation IDs with an existing ledger. */
export declare const USAGE_OPERATIONS_DDL = "\nCREATE TABLE IF NOT EXISTS usage_operations (\n  customer_id TEXT NOT NULL,\n  period TEXT NOT NULL,\n  operation_id TEXT NOT NULL,\n  allowed BOOLEAN NOT NULL,\n  count INTEGER NOT NULL,\n  enforced_limit INTEGER NOT NULL,\n  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (customer_id, period, operation_id)\n);\n";
