/** IDs are opaque identifiers, never raw API keys or request bodies. */
export declare function validateOperationId(value: string): void;
export declare function operationDigest(value: string): Promise<string>;
