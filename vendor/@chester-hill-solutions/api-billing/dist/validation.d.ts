import type { UsageLedgerResult } from './types.js';
export declare function assertLimit(limit: number): void;
export declare function assertCustomerId(customerId: string): void;
export declare function countValue(value: unknown): number;
export declare function isDay(value: string): boolean;
export declare function ledgerResult(value: unknown, month: string, limit: number, method: 'GET' | 'POST'): UsageLedgerResult;
