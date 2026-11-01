import type { CorpusRevision } from './source';

export const SOURCE_HEAD_TIMEOUT_MS = 15_000;
export const SOURCE_HEAD_MAX_BYTES = 1024 * 1024;

/** Only numeric public quota metadata is retained; response bodies and
 * transport exceptions can contain private data and never enter this error. */
export interface SourceHeadRateLimits {
  limit?: number;
  remaining?: number;
  used?: number;
  /** Unix seconds, as returned by GitHub. */
  reset?: number;
  /** Only an unsigned numeric Retry-After of at most one day is accepted. */
  retryAfterSeconds?: number;
}
export type SourceHeadErrorCode = 'http-refused' | 'primary-rate-limit' | 'redirect-refused' |
  'timeout' | 'transport' | 'response-too-large' | 'invalid-response';
const errorCodes: readonly string[] = ['http-refused','primary-rate-limit','redirect-refused','timeout','transport','response-too-large','invalid-response'];
function safeRateLimits(input: Readonly<SourceHeadRateLimits>): SourceHeadRateLimits {
  const result: SourceHeadRateLimits = {};
  for (const field of ['limit','remaining','used','reset','retryAfterSeconds'] as const) {
    const value = input[field];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 &&
      (field !== 'retryAfterSeconds' || value <= 86400)) result[field] = value;
  }
  return result;
}
export class SourceHeadError extends Error {
  constructor(readonly code: SourceHeadErrorCode, readonly status?: number,
    readonly rateLimits: Readonly<SourceHeadRateLimits> = {}) {
    const safeCode = errorCodes.includes(code) ? code : 'transport';
    const safeStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    const safeLimits = safeRateLimits(rateLimits);
    // The coordinator persists String(error).slice(0,500). Keep that string
    // useful without persisting any response/transport text or address.
    super(`Corpus source head failed: ${JSON.stringify({ code: safeCode, ...(safeStatus === undefined ? {} : { status: safeStatus }), rateLimits: safeLimits })}`);
    this.name = 'SourceHeadError';
    this.code = safeCode;
    this.status = safeStatus;
    this.rateLimits = Object.freeze(safeLimits);
  }
}

function decimal(value: string | null, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === null || !/^(0|[1-9]\d{0,15})$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= maximum ? number : undefined;
}
export function parseSourceHeadRateLimits(headers: Pick<Headers, 'get'>): SourceHeadRateLimits {
  const result: SourceHeadRateLimits = {};
  for (const field of ['limit', 'remaining', 'used', 'reset'] as const) {
    const number = decimal(headers.get(`x-ratelimit-${field}`));
    if (number !== undefined) result[field] = number;
  }
  const retryAfter = decimal(headers.get('retry-after'), 86400);
  if (retryAfter !== undefined) result.retryAfterSeconds = retryAfter;
  return result;
}

export function parseSourceHeadRevision(value: unknown): CorpusRevision {
  const commit = value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  const sha = commit && 'sha' in commit ? commit.sha : undefined;
  const metadata = commit && 'commit' in commit && commit.commit && typeof commit.commit === 'object' ? commit.commit : undefined;
  const committer = metadata && 'committer' in metadata && metadata.committer && typeof metadata.committer === 'object' ? metadata.committer : undefined;
  const timestamp = committer && 'date' in committer ? committer.date : undefined;
  const time = typeof timestamp === 'string' ? /^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(?:Z|[+-](\d\d):(\d\d))$/.exec(timestamp) : null;
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha) || typeof timestamp !== 'string' || !time ||
    Number(time[2])>23 || Number(time[3])>59 || Number(time[4])>59 || Number(time[5]??0)>23 || Number(time[6]??0)>59 ||
    !Number.isFinite(Date.parse(timestamp))) throw new SourceHeadError('invalid-response');
  const date = timestamp.slice(0, 10);
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new SourceHeadError('invalid-response');
  return { commit: sha, date };
}

export type SourceHeadSend = (url: string, init: RequestInit) => Promise<Response>;

/** The list endpoint returns commit metadata, rather than the unbounded file
 * patches in GET /commits/:ref. There is one attempt, including body reading.
 * A deadline aborts the request and cancels its body; it never retries. */
export async function requestSourceHead(api: string, branch: string, headers: Record<string, string>,
  send: SourceHeadSend = fetch): Promise<CorpusRevision> {
  const query = new URLSearchParams({ sha: branch, per_page: '1' });
  const url = `${api.replace(/\/$/, '')}/commits?${query}`;
  const controller = new AbortController();
  let response: Response | undefined;
  // Workers and Bun expose different extra reader methods. Only this shared
  // body-reading boundary is needed by the client.
  let reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void>; releaseLock(): void } | undefined;
  function cancelBody(): void {
    if (reader) void reader.cancel().catch(() => {});
    else if (response?.body) void response.body.cancel().catch(() => {});
  }
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      controller.abort(); cancelBody(); reject(new SourceHeadError('timeout'));
    }, SOURCE_HEAD_TIMEOUT_MS);
  });
  async function work(): Promise<CorpusRevision> {
    try {
      response = await send(url, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
      if (controller.signal.aborted) throw new SourceHeadError('timeout');
      const rateLimits = parseSourceHeadRateLimits(response.headers);
      if (response.status >= 300 && response.status <= 399) throw new SourceHeadError('redirect-refused', response.status, rateLimits);
      if (response.status !== 200) throw new SourceHeadError(
        (response.status === 403 || response.status === 429) && rateLimits.remaining === 0 ? 'primary-rate-limit' : 'http-refused',
        response.status, rateLimits);
      const length = response.headers.get('content-length');
      if (length !== null) {
        const size = decimal(length);
        if (size === undefined) throw new SourceHeadError('invalid-response');
        if (size > SOURCE_HEAD_MAX_BYTES) throw new SourceHeadError('response-too-large');
      }
      if (!response.body) throw new SourceHeadError('invalid-response');
      const bodyReader = response.body.getReader(); reader = bodyReader;
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const next = await bodyReader.read();
        if (controller.signal.aborted) throw new SourceHeadError('timeout');
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) throw new SourceHeadError('invalid-response');
        size += next.value.byteLength;
        if (size > SOURCE_HEAD_MAX_BYTES) throw new SourceHeadError('response-too-large');
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size); let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
      catch { throw new SourceHeadError('invalid-response'); }
      if (!Array.isArray(value) || value.length !== 1) throw new SourceHeadError('invalid-response');
      return parseSourceHeadRevision(value[0]);
    } catch (error) {
      if (error instanceof SourceHeadError) throw error;
      throw new SourceHeadError(controller.signal.aborted ? 'timeout' : 'transport');
    } finally {
      cancelBody();
      try { reader?.releaseLock(); } catch { /* A pending read is being cancelled. */ }
    }
  }
  try { return await Promise.race([work(), deadline]); }
  finally { if (deadlineTimer !== undefined) clearTimeout(deadlineTimer); }
}
