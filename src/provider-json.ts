/** One finite provider JSON POST. Endpoint, credentials and schema belong to callers. */
export type ProviderJsonPhase =
  | 'request-serialization' | 'transport' | 'upstream-http' | 'response-body'
  | 'response-parse' | 'timeout' | 'cancelled' | 'response-validation';

const phases: readonly ProviderJsonPhase[] = [
  'request-serialization', 'transport', 'upstream-http', 'response-body',
  'response-parse', 'timeout', 'cancelled', 'response-validation',
];

/** Only these bounded metadata fields may leave the exchange. Never retain a cause. */
export class ProviderJsonError extends Error {
  readonly phase: ProviderJsonPhase;
  readonly httpStatus?: number;
  constructor(phase: ProviderJsonPhase, httpStatus?: number) {
    super('The provider JSON exchange did not complete.');
    this.name = 'ProviderJsonError';
    this.phase = phases.includes(phase) ? phase : 'transport';
    if (Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599) this.httpStatus = httpStatus;
  }
}

export interface ProviderJsonOptions<T> {
  url: string;
  headers: HeadersInit;
  body: unknown;
  timeoutMs: number;
  responseBytes: number;
  requestBytes?: number;
  signal?: AbortSignal;
  send?: typeof fetch;
  /** Runs inside the same deadline; exceptions become response-validation. */
  parse: (value: unknown) => T;
}

/** No retry, redirect, fallback or provider-body error. Synchronous JavaScript
 * cannot be preempted; elapsed-time checks refuse its result after an overrun.
 * Failure cleanup shares the original deadline. An unsettled failure is terminal. */
export async function providerJsonOnce<T>(options: ProviderJsonOptions<T>): Promise<T> {
  const { url, headers, body: inputBody, timeoutMs, responseBytes, requestBytes, signal, parse } = options;
  const send = options.send ?? fetch;
  const started = performance.now(), deadline = started + timeoutMs;
  let last = started, httpStatus: number | undefined, stopped: ProviderJsonError | undefined;
  const controller = new AbortController();
  const error = (phase: ProviderJsonPhase) => new ProviderJsonError(phase, httpStatus);
  let rejectStopped!: (reason: ProviderJsonError) => void;
  const stopPromise = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  void stopPromise.catch(() => {});
  const stop = (phase: 'timeout' | 'cancelled') => {
    stopped ??= error(phase);
    controller.abort();
    rejectStopped(stopped);
  };
  const check = () => {
    if (signal?.aborted) stop('cancelled');
    const at = performance.now();
    if (!Number.isFinite(at) || at < last || at >= deadline) stop('timeout');
    last = at;
    if (stopped) throw stopped;
  };
  const within = async <V>(pending: Promise<V>): Promise<V> => {
    void pending.catch(() => {});
    check();
    const value = await Promise.race([pending, stopPromise]);
    check();
    return value;
  };
  const abort = () => stop('cancelled');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response | undefined;
  let reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'read' | 'cancel' | 'releaseLock'> | undefined;
  let finished = false, phase: ProviderJsonPhase = 'request-serialization';
  let failure: ProviderJsonError | undefined, result!: T;
  try {
    if (!Number.isFinite(started) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
      timeoutMs > 2_147_483_647 || !Number.isFinite(deadline) ||
      !Number.isSafeInteger(responseBytes) || responseBytes <= 0 ||
      requestBytes !== undefined && (!Number.isSafeInteger(requestBytes) || requestBytes <= 0)) throw error(phase);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('timeout'), Math.max(0, deadline - performance.now()));
    check();
    const body = JSON.stringify(inputBody);
    check();
    if (typeof body !== 'string' || requestBytes !== undefined && new TextEncoder().encode(body).byteLength > requestBytes) throw error(phase);
    check();
    phase = 'transport';
    // Workers supports manual/follow. Inspect 3xx below without forwarding credentials.
    const pending = send(url, { method: 'POST', headers, body, redirect: 'manual', signal: controller.signal }).then(value => {
      if (finished) {
        // A transport that ignored abort may fulfil after our terminal failure.
        try { void value.body?.cancel().catch(() => {}); } catch { /* No raw error or new request. */ }
        throw error(stopped?.phase === 'cancelled' ? 'cancelled' : 'timeout');
      }
      response = value;
      if (Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) httpStatus = value.status;
      check();
      return value;
    });
    response = await within(pending);
    if (response.redirected) throw error('transport');
    if (!response.ok) { phase = 'upstream-http'; throw error(phase); }
    phase = 'response-body';
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > responseBytes)) throw error(phase);
    if (!response.body) throw error(phase);
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const next = await within(reader.read());
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw error(phase);
      size += next.value.byteLength;
      if (size > responseBytes) throw error(phase);
      if (next.value.byteLength) chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    check();
    phase = 'response-parse';
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    check();
    phase = 'response-validation';
    const parsed = parse(value);
    check();
    result = await within(Promise.resolve(parsed));
  } catch {
    try { check(); } catch { /* The safe deadline state takes precedence. */ }
    failure = stopped ?? error(phase);
  } finally {
    finished = true;
    if (failure) controller.abort();
    try {
      const cancelled = reader ? reader.cancel() : response?.body?.cancel();
      if (cancelled) await within(Promise.resolve(cancelled));
      check();
    } catch {
      failure ??= stopped ?? error('response-body');
    }
    try { reader?.releaseLock(); } catch { failure ??= stopped ?? error('response-body'); }
    try { check(); } catch { failure ??= stopped; }
    if (failure) controller.abort();
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
  if (failure) throw failure;
  return result;
}
