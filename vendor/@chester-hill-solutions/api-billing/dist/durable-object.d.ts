import type { DurableObjectState } from '@cloudflare/workers-types';
import type { UsageConsumeOptions, UsageLedger, UsageLedgerResult } from './types.js';
export interface UsageReservationResult extends UsageLedgerResult {
    expiresAt?: number;
}
/** Existing customer objects and month/count keys remain compatible. */
export declare class ApiKeyUsageDO {
    private readonly state;
    constructor(state: DurableObjectState);
    fetch(request: Request): Promise<Response>;
    private hasSpareCapacity;
    private reservation;
    private pruneOldDays;
    private json;
}
export interface DurableObjectNamespaceLike {
    idFromName(name: string): unknown;
    get(id: unknown): {
        fetch(input: string, init?: RequestInit): Promise<Response>;
    };
}
export interface DurableObjectLedgerOptions {
    /** Default 'fuse' preserves the historical soft-fuse fail-open policy. */
    failureMode?: 'fuse' | 'closed';
    /** Additional acknowledgement attempts after the first, from zero to four. */
    acknowledgementRetries?: number;
    /** Bound each acknowledgement request. Defaults to five seconds. */
    requestTimeoutMs?: number;
}
/** A client that can reconcile an uncertain POST using its durable receipt. */
export declare class DurableObjectUsageLedger implements UsageLedger {
    private readonly namespace;
    private readonly options;
    readonly supportsOperationIds = true;
    private readonly retries;
    private readonly timeoutMs;
    constructor(namespace: DurableObjectNamespaceLike, options?: DurableObjectLedgerOptions);
    consumeMonthly(customerId: string, monthlyLimit: number, nowMs?: number, options?: UsageConsumeOptions): Promise<UsageLedgerResult>;
    consumeReservedMonthly(customerId: string, monthlyLimit: number, nowMs: number, options?: UsageConsumeOptions): Promise<UsageLedgerResult>;
    reserveMonthly(customerId: string, limit: number, nowMs: number, operationId: string): Promise<UsageReservationResult>;
    releaseMonthly(customerId: string, limit: number, nowMs: number, operationId: string): Promise<void>;
    private reservationCall;
    private consume;
    peekMonthly(customerId: string, monthlyLimit: number, nowMs?: number): Promise<UsageLedgerResult>;
    private fetchUsage;
    private call;
}
