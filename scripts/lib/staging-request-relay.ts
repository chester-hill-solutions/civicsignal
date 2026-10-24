import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  unlinkSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_STAGING_REQUESTS = 160;
export const MAX_RELAY_BODY_BYTES = 128 * 1024;
export const STAGING_API_PREFIX = 'civicsignal-v1-stage-api-';
const MAX_LEDGER_BYTES = 512 * 1024;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
export interface RelayAttempt { seq: number; method: string; pathname: string; time: string }
interface LedgerHeader { format: 1; targetOrigin: string; limit: number }
export interface RelayLedger {
  readonly targetOrigin: string;
  readonly limit: number;
  reserve(method: string, pathname: string): RelayAttempt;
}
export class RelayError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function stagingTarget(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('an explicit staging HTTPS workers.dev origin is required'); }
  const labels = url.hostname.split('.');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash ||
    labels.length !== 4 || labels[2] !== 'workers' || labels[3] !== 'dev' || !labels[0]!.startsWith(STAGING_API_PREFIX) ||
    labels[0]!.length <= STAGING_API_PREFIX.length || !labels.slice(0, 2).every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('target must be an explicit HTTPS civicsignal-v1-stage-api-*.<account>.workers.dev origin; production origins and URL credentials/paths/queries are forbidden');
  }
  return url.origin;
}
function checkedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_STAGING_REQUESTS) throw new Error('staging request limit must be an integer from 1 to 160');
  return limit;
}
function exactKeys(value: object, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, at) => key === [...keys].sort()[at]);
}
function checkedPath(method: string, pathname: string): void {
  if (!METHODS.has(method) || typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.length > 2048 || !/^[\x21-\x7e]+$/.test(pathname) || /[?#\\"]/.test(pathname)) {
    throw new RelayError(400, 'unsupported method or pathname');
  }
}
function readLedger(path: string, targetOrigin: string, limit: number): { header: LedgerHeader; attempts: RelayAttempt[] } {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LEDGER_BYTES) throw new Error('staging ledger is not a bounded regular file');
  const text = readFileSync(path, 'utf8');
  if (!text.endsWith('\n')) throw new Error('staging ledger is incomplete; refusing crash recovery or repair');
  const lines = text.slice(0, -1).split('\n');
  let values: unknown[];
  try { values = lines.map((line) => JSON.parse(line)); } catch { throw new Error('staging ledger contains invalid JSON; refusing crash recovery or repair'); }
  const header = values[0] as LedgerHeader | undefined;
  if (!header || typeof header !== 'object' || !exactKeys(header, ['format', 'targetOrigin', 'limit']) ||
    header.format !== 1 || header.targetOrigin !== targetOrigin || header.limit !== limit) throw new Error('staging ledger target/limit identity differs or is invalid');
  const attempts = values.slice(1) as RelayAttempt[];
  if (attempts.length > limit) throw new Error('staging ledger exceeds its request limit');
  for (const [at, attempt] of attempts.entries()) {
    if (!attempt || typeof attempt !== 'object' || !exactKeys(attempt, ['seq', 'method', 'pathname', 'time']) ||
      attempt.seq !== at + 1 || typeof attempt.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(attempt.time) ||
      !Number.isFinite(Date.parse(attempt.time)) || new Date(attempt.time).toISOString() !== attempt.time) throw new Error('staging ledger sequence/time/shape is inconsistent');
    checkedPath(attempt.method, attempt.pathname);
  }
  return { header, attempts };
}
function append(fd: number, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  for (let at = 0; at < bytes.length;) {
    const written = writeSync(fd, bytes, at, bytes.length - at);
    if (written <= 0) throw new Error('staging ledger write did not complete');
    at += written;
  }
}
function syncDirectory(path: string, sync: (fd: number) => void): void {
  const fd = openSync(dirname(path), constants.O_RDONLY);
  try { sync(fd); } finally { closeSync(fd); }
}

/** Holds one exclusive process lock until close. Existing locks, even stale
 * ones, require operator inspection; automatically deleting them races a
 * competing process. A torn/unknown record is never silently truncated. */
export class FileRelayLedger implements RelayLedger {
  readonly targetOrigin: string;
  readonly limit: number;
  private readonly path: string;
  private readonly lockPath: string;
  private readonly token = randomUUID();
  private fd: number | undefined;
  private count = 0;
  private closed = false;
  private failed = false;
  private readonly sync: (fd: number) => void;
  constructor(options: { path: string; targetOrigin: string; limit?: number; sync?: (fd: number) => void }) {
    this.targetOrigin = stagingTarget(options.targetOrigin);
    this.limit = checkedLimit(options.limit ?? MAX_STAGING_REQUESTS);
    this.path = resolve(options.path);
    this.lockPath = `${this.path}.lock`;
    this.sync = options.sync ?? fsyncSync;
    let lock: number;
    try { lock = openSync(this.lockPath, 'wx', 0o600); }
    catch { throw new Error('staging ledger lock exists or cannot be acquired; verify the owner stopped and inspect the ledger before removing a stale lock'); }
    try {
      append(lock, `${JSON.stringify({ format: 1, pid: process.pid, token: this.token })}\n`);
      this.sync(lock);
      syncDirectory(this.lockPath, this.sync);
      closeSync(lock);
      lock = -1;
      const existed = existsSync(this.path);
      if (existed) this.count = readLedger(this.path, this.targetOrigin, this.limit).attempts.length;
      this.fd = openSync(this.path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | (existed ? 0 : constants.O_EXCL) | (constants.O_NOFOLLOW ?? 0), 0o600);
      if (!fstatSync(this.fd).isFile()) throw new Error('staging ledger must be a regular file');
      if (fstatSync(this.fd).size === 0) {
        append(this.fd, `${JSON.stringify({ format: 1, targetOrigin: this.targetOrigin, limit: this.limit } satisfies LedgerHeader)}\n`);
      }
      // Reconfirm file and directory durability on restart as well, including
      // recovery from an uncertain first-header acknowledgement.
      this.sync(this.fd);
      syncDirectory(this.path, this.sync);
    } catch (error) {
      if (lock !== -1) closeSync(lock);
      if (this.fd !== undefined) closeSync(this.fd);
      this.fd = undefined;
      unlinkSync(this.lockPath);
      throw error;
    }
  }
  static inspect(path: string, targetOrigin: string, limit = MAX_STAGING_REQUESTS) {
    const target = stagingTarget(targetOrigin);
    const result = readLedger(resolve(path), target, checkedLimit(limit));
    return { targetOrigin: result.header.targetOrigin, limit: result.header.limit, reserved: result.attempts.length,
      remaining: result.header.limit - result.attempts.length };
  }
  status() { return { targetOrigin: this.targetOrigin, limit: this.limit, reserved: this.count, remaining: this.limit - this.count }; }
  reserve(method: string, pathname: string): RelayAttempt {
    checkedPath(method, pathname);
    if (this.closed || this.failed || this.fd === undefined) throw new RelayError(503, 'staging ledger is closed or inconsistent');
    if (this.count >= this.limit) throw new RelayError(429, 'cumulative staging request budget exhausted');
    const record: RelayAttempt = { seq: this.count + 1, method, pathname, time: new Date().toISOString() };
    try {
      append(this.fd, `${JSON.stringify(record)}\n`);
      this.sync(this.fd); // Must complete before the caller can invoke fetch.
      this.count++;
      return record;
    } catch {
      this.failed = true;
      throw new RelayError(503, 'staging ledger reservation was not confirmed; no request forwarded');
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
    const lock = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { token?: string };
    if (lock.token !== this.token) throw new Error('staging ledger lock ownership changed');
    unlinkSync(this.lockPath);
    syncDirectory(this.lockPath, this.sync);
  }
}

function abortError(): Error { return new DOMException('staging relay request aborted', 'AbortError'); }
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolvePromise, reject) => {
    const abort = () => { reject(abortError()); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function bodyBytes(request: Request, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RELAY_BODY_BYTES)) throw new RelayError(413, 'staging relay request body exceeds 128 KiB');
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RELAY_BODY_BYTES) throw new RelayError(413, 'staging relay request body exceeds 128 KiB');
      chunks.push(value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(new ArrayBuffer(length));
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes;
}
const HOP_HEADERS = ['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length'];
function forwardedHeaders(original: Headers): Headers {
  const headers = new Headers(original);
  const connection = headers.get('connection')?.split(',').map((value) => value.trim()) ?? [];
  for (const name of [...HOP_HEADERS, ...connection]) headers.delete(name);
  return headers;
}

/** Framework independent HTTP/MCP relay; callers must bind only loopback. */
export function stagingRequestRelay(options: { targetOrigin: string; ledger: RelayLedger; timeoutMs?: number; fetch?: typeof fetch }) {
  const target = stagingTarget(options.targetOrigin);
  if (options.ledger.targetOrigin !== target || checkedLimit(options.ledger.limit) !== options.ledger.limit) throw new Error('relay ledger identity does not match its target');
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('staging relay timeout must be 1–60000 ms');
  const send = options.fetch ?? fetch;
  return async (request: Request): Promise<Response> => {
    const started = performance.now();
    const controller = new AbortController();
    let timedOut = false;
    const abortCaller = () => controller.abort();
    request.signal.addEventListener('abort', abortCaller, { once: true });
    if (request.signal.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); request.signal.removeEventListener('abort', abortCaller); };
    const deadline = () => {
      // A synchronous fsync can delay the timer callback. Never start an
      // upstream send after the wall deadline merely because the loop was busy.
      if (performance.now() - started >= timeoutMs) { timedOut = true; controller.abort(); }
      if (controller.signal.aborted) throw abortError();
    };
    let streaming = false;
    try {
      deadline();
      const incoming = new URL(request.url);
      checkedPath(request.method, incoming.pathname);
      const bytes = await bodyBytes(request, controller.signal);
      if ((request.method === 'GET' || request.method === 'HEAD') && bytes?.length) throw new RelayError(400, 'GET/HEAD bodies are not supported');
      deadline();
      const upstream = new URL(target);
      upstream.pathname = incoming.pathname;
      upstream.search = incoming.search;
      const message = new Request(upstream.toString(), { method: request.method, headers: forwardedHeaders(request.headers),
        body: bytes, redirect: 'error', signal: controller.signal });
      options.ledger.reserve(request.method, incoming.pathname);
      const prepareMs = performance.now() - started;
      deadline();
      const response = await abortable(send(message), controller.signal);
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        void response.body?.cancel().catch(() => {});
        throw new RelayError(502, 'staging upstream redirects are forbidden');
      }
      const headers = forwardedHeaders(response.headers);
      // Fetch exposes decoded response bytes; original compressed lengths and
      // encodings would otherwise make the downstream client decode twice.
      headers.delete('content-encoding');
      headers.set('x-civicsignal-staging-target', target);
      headers.set('x-civicsignal-staging-proxy-prepare-ms', prepareMs.toFixed(3));
      headers.append('server-timing', `staging_proxy_prepare;dur=${prepareMs.toFixed(3)}`);
      if (!response.body) return new Response(null, { status: response.status, statusText: response.statusText, headers });
      const reader = response.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            deadline();
            const { done, value } = await abortable(reader.read(), controller.signal);
            if (done) { cleanup(); reader.releaseLock(); output.close(); }
            else output.enqueue(value);
          } catch {
            cleanup(); void reader.cancel().catch(() => {}); output.error(abortError());
          }
        },
        async cancel() { controller.abort(); cleanup(); await reader.cancel().catch(() => {}); },
      });
      streaming = true;
      return new Response(stream, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      const status = error instanceof RelayError ? error.status : controller.signal.aborted ? timedOut ? 504 : 499 : 502;
      const message = error instanceof RelayError ? error.message : timedOut ? 'staging upstream deadline exceeded' : controller.signal.aborted ? 'staging caller aborted' : 'staging upstream request failed';
      return Response.json({ error: message }, { status });
    } finally { if (!streaming) cleanup(); }
  };
}
