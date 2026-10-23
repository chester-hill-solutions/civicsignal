import type { UsageConsumeOptions, UsageLedger, UsageLedgerResult } from './types.js';
/**
 * An in-memory ledger.
 *
 * A test double implementing intent, not wire format. It counts the same way the
 * real ones do — a refused call is not counted — so a test that passes against
 * it means something about the policy rather than about the double.
 */
export declare class InMemoryUsageLedger implements UsageLedger {
    private readonly seed?;
    readonly supportsOperationIds = true;
    private readonly counts;
    private readonly receipts;
    constructor(seed?: Map<string, number> | undefined);
    private key;
    consumeMonthly(customerId: string, monthlyLimit: number, nowMs?: number, options?: UsageConsumeOptions): Promise<UsageLedgerResult>;
    peekMonthly(customerId: string, monthlyLimit: number, nowMs?: number): Promise<UsageLedgerResult>;
}
/**
 * A ledger that always says the same thing.
 *
 * For a product whose metering is not configured, and for tests that care about
 * something else.
 */
export declare class StaticUsageLedger implements UsageLedger {
    private readonly result;
    constructor(result?: Partial<UsageLedgerResult>);
    consumeMonthly(_customerId: string, monthlyLimit: number, nowMs?: number): Promise<UsageLedgerResult>;
    peekMonthly(_customerId: string, monthlyLimit: number, nowMs?: number): Promise<UsageLedgerResult>;
}
