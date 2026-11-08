/** A caller deadline independent of whether the transport honors cancellation. */
export class IoDeadline {
    signal;
    end;
    constructor(timeoutMs) {
        this.end = performance.now() + timeoutMs;
        this.signal = AbortSignal.timeout(timeoutMs);
    }
    assert() {
        if (this.signal.aborted)
            throw this.signal.reason;
        if (performance.now() >= this.end)
            throw new DOMException('Operation deadline exceeded', 'TimeoutError');
    }
    wait(task, discard) {
        return new Promise((resolve, reject) => {
            const abort = () => reject(this.signal.reason);
            if (this.signal.aborted)
                reject(this.signal.reason);
            else
                this.signal.addEventListener('abort', abort, { once: true });
            task.then(value => {
                this.signal.removeEventListener('abort', abort);
                try {
                    this.assert();
                }
                catch (error) {
                    discard?.(value);
                    reject(error);
                    return;
                }
                resolve(value);
            }, error => { this.signal.removeEventListener('abort', abort); reject(error); });
        });
    }
}
export function cancelResponseBody(response) {
    try {
        void response.body?.cancel().catch(() => { });
    }
    catch { /* Cleanup must not replace the deadline outcome. */ }
}
