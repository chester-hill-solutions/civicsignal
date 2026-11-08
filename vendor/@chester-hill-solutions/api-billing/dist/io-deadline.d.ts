/** A caller deadline independent of whether the transport honors cancellation. */
export declare class IoDeadline {
    readonly signal: AbortSignal;
    private readonly end;
    constructor(timeoutMs: number);
    assert(): void;
    wait<T>(task: Promise<T>, discard?: (value: T) => void): Promise<T>;
}
export declare function cancelResponseBody(response: {
    body: {
        cancel(): Promise<unknown>;
    } | null;
}): void;
