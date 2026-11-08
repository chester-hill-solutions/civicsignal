import type { DurableObjectState } from '@cloudflare/workers-types';
import type { UsageLedger, UsageLedgerResult } from './types.js';
/** One object per customer. Storage transactions cover the check, count and retention. */
export declare class ApiKeyUsageDO {
    private readonly state;
    constructor(state: DurableObjectState);
    fetch(request: Request): Promise<Response>;
    private pruneOldDays;
}
interface UsageResponse {
    ok: boolean;
    status: number;
    body: {
        cancel(): Promise<unknown>;
        getReader(): {
            read(): Promise<{
                done: boolean;
                value?: unknown;
            }>;
            cancel(): Promise<unknown>;
            releaseLock(): void;
        };
    } | null;
}
/** Structural subset also accepts the host's generated Durable Object namespace binding. */
export interface DurableObjectNamespaceLike {
    idFromName(name: string): unknown;
    get(id: unknown): {
        fetch(input: string, init?: {
            method?: string;
        }): Promise<UsageResponse>;
    };
}
/** Hard limits fail closed on transport, storage or wire errors; unlimited/soft use fails open. */
export declare class DurableObjectUsageLedger implements UsageLedger {
    private readonly namespace;
    constructor(namespace: DurableObjectNamespaceLike);
    consumeMonthly(customerId: string, monthlyLimit: number, nowMs?: number): Promise<UsageLedgerResult>;
    peekMonthly(customerId: string, monthlyLimit: number, nowMs?: number): Promise<UsageLedgerResult>;
    private request;
}
export {};
