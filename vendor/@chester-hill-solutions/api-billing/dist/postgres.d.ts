import type { UsageLedger, UsageLedgerResult } from './types.js';
/** postgres.js or a PGlite adapter, with bound values and an array of rows. */
export interface SqlRunner {
    unsafe(query: string, params?: unknown[]): Promise<unknown[]>;
}
/** One atomic upsert decides and counts; refused calls never increment. */
export declare class PostgresUsageLedger implements UsageLedger {
    private readonly sql;
    private readonly table;
    constructor(sql: SqlRunner, table?: string);
    consumeMonthly(customerId: string, monthlyLimit: number, nowMs?: number): Promise<UsageLedgerResult>;
    peekMonthly(customerId: string, monthlyLimit: number, nowMs?: number): Promise<UsageLedgerResult>;
    private read;
}
/** Initial schema: BIGINT storage is bounded to JavaScript's exact integer range. */
export declare const USAGE_COUNTERS_DDL = "\nCREATE TABLE IF NOT EXISTS usage_counters (\n  customer_id TEXT NOT NULL,\n  period      TEXT NOT NULL,\n  count       BIGINT NOT NULL DEFAULT 0 CHECK (count BETWEEN 0 AND 9007199254740991),\n  PRIMARY KEY (customer_id, period)\n);\n";
