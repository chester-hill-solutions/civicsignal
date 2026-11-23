import { readTar, type InstrumentFile } from '../../src/ingest/source';
import type { SourceHeadSend } from '../../src/ingest/source-head';
import { MAX_FILE_BYTES } from './builder';

const ARCHIVE = 'https://codeload.github.com/justicecanada/laws-lois-xml/tar.gz/';
export const SNAPSHOT_ARCHIVE_TIMEOUT_MS = 60 * 60 * 1000;
export const SNAPSHOT_ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;
export const SNAPSHOT_EXPANDED_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const SNAPSHOT_LONGNAME_MAX_BYTES = 4096;
const headers = { accept: 'application/vnd.github+json', 'user-agent': 'civicsignal-corpus-pipeline' };

export type SnapshotArchiveErrorCode = 'http-refused' | 'redirect-refused' | 'timeout' | 'transport' |
  'response-too-large' | 'invalid-response';
const failureCodes: readonly string[] = ['http-refused', 'redirect-refused', 'timeout', 'transport', 'response-too-large', 'invalid-response'];

/** Workflow errors persist this message. Retain only fixed codes and an actual
 * observed HTTP status, never the archive, URL or original exception/cause. */
export class SnapshotArchiveError extends Error {
  readonly code: SnapshotArchiveErrorCode;
  readonly status?: number;
  constructor(code: SnapshotArchiveErrorCode, status?: number) {
    const safeCode = failureCodes.includes(code) ? code : 'transport';
    const safeStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    super(`Snapshot archive failed or is uncertain: ${JSON.stringify({ code: safeCode, ...(safeStatus === undefined ? {} : { status: safeStatus }) })}`);
    this.name = 'SnapshotArchiveError';
    this.code = safeCode;
    this.status = safeStatus;
  }
}

/** Framing only: the existing readTar still parses names and content. Inspect
 * each header before forwarding it, so it cannot allocate an oversized entry.
 * Require a complete body/padding and two end blocks rather than silently
 * accepting the unchanged reader's early EOF behaviour. O(512) extra memory. */
export async function* checkedTarChunks(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const header = new Uint8Array(512);
  let used = 0, body = 0, padding = 0, zeros = 0, total = 0, needsFile = false;
  function octal(start: number, length: number) {
    const field = header.subarray(start, start + length), nul = field.indexOf(0);
    // readTar's readString stops at the FIRST NUL. Digits after it must not
    // produce a different guard size and conceal unchecked parser headers.
    if (nul !== -1 && field.subarray(nul).some(value => value !== 0 && value !== 32)) throw new Error('Snapshot tar numeric suffix is invalid.');
    const text = new TextDecoder().decode(nul === -1 ? field : field.subarray(0, nul)).trim();
    if (text && !/^[0-7]{1,12}$/.test(text)) throw new Error('Snapshot tar numeric header is invalid.');
    return text ? parseInt(text, 8) : 0;
  }
  for await (const chunk of source) {
    total += chunk.length;
    let at = 0;
    while (at < chunk.length) {
      if (zeros >= 2) {
        if (chunk.subarray(at).some(value => value !== 0)) throw new Error('Snapshot tar has data after its end marker.');
        at = chunk.length; continue;
      }
      if (body) { const n = Math.min(body, chunk.length - at); body -= n; at += n; continue; }
      if (padding) {
        const n = Math.min(padding, chunk.length - at);
        if (chunk.subarray(at, at + n).some(value => value !== 0)) throw new Error('Snapshot tar padding is invalid.');
        padding -= n; at += n; continue;
      }
      const n = Math.min(512 - used, chunk.length - at);
      header.set(chunk.subarray(at, at + n), used); used += n; at += n;
      if (used !== 512) continue;
      used = 0;
      if (header.every(value => value === 0)) {
        if (needsFile) throw new Error('Snapshot tar has an unpaired long name.');
        zeros++; continue;
      }
      if (zeros) throw new Error('Snapshot tar has an incomplete end marker.');
      const checksum = octal(148, 8);
      let sum = 0;
      for (let i = 0; i < header.length; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
      if (sum !== checksum) throw new Error('Snapshot tar checksum is invalid.');
      const size = octal(124, 12), longName = header[156] === 76;
      if (size > (longName ? SNAPSHOT_LONGNAME_MAX_BYTES : MAX_FILE_BYTES)) throw new Error('Snapshot tar entry exceeds its input bound.');
      needsFile = longName;
      body = size; padding = (512 - size % 512) % 512;
    }
    yield chunk;
  }
  if (used || body || padding || zeros < 2 || needsFile || total % 512 !== 0) throw new Error('Snapshot tar is truncated.');
}

/** Shared snapshot archive transport. Canonical callers retain their Workflow
 * retry policy; qualification adds a durable claim immediately before sending.
 * No implicit redirects or transport retries exist inside one invocation. */
export function snapshotArchive(options: {
  beforeSend?: (commit: string) => Promise<void>; send?: SourceHeadSend;
  timeoutMs?: number; archiveBytes?: number; expandedBytes?: number;
  assertCanSend?: () => void; monotonicNow?: () => number;
} = {}) {
  const timeoutMs = options.timeoutMs ?? SNAPSHOT_ARCHIVE_TIMEOUT_MS;
  const archiveBytes = options.archiveBytes ?? SNAPSHOT_ARCHIVE_MAX_BYTES;
  const expandedBytes = options.expandedBytes ?? SNAPSHOT_EXPANDED_MAX_BYTES;
  for (const [value, maximum] of [[timeoutMs, SNAPSHOT_ARCHIVE_TIMEOUT_MS], [archiveBytes, SNAPSHOT_ARCHIVE_MAX_BYTES], [expandedBytes, SNAPSHOT_EXPANDED_MAX_BYTES]]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error('Snapshot source bounds are invalid.');
  }
  return {
    async *instruments(commit: string, paths: readonly string[]): AsyncGenerator<InstrumentFile> {
      if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Snapshot archive revision is invalid.');
      const controller = new AbortController();
      const now = options.monotonicNow ?? (() => performance.now()), started = now();
      function check() {
        const at = now();
        if (!Number.isFinite(at) || !Number.isFinite(started) || at < started || at - started >= timeoutMs || controller.signal.aborted) throw new SnapshotArchiveError('timeout', response?.status);
      }
      let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let phase: 'admission' | 'transport' | 'response' = 'admission';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); if (reader) void reader.cancel().catch(() => {}); reject(new SnapshotArchiveError('timeout', response?.status)); }, timeoutMs);
      });
      try {
        check();
        if (options.beforeSend) await Promise.race([options.beforeSend(commit), deadline]);
        check(); options.assertCanSend?.();
        phase = 'transport';
        const pending = (options.send ?? fetch)(ARCHIVE + commit, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
        void pending.then(value => { if (controller.signal.aborted) void value.body?.cancel().catch(() => {}); }, () => {});
        response = await Promise.race([pending, deadline]);
        phase = 'response';
        check();
        if (response.status >= 300 && response.status <= 399 || response.redirected || response.url && response.url !== ARCHIVE + commit) throw new SnapshotArchiveError('redirect-refused', response.status);
        if (response.status !== 200) throw new SnapshotArchiveError('http-refused', response.status);
        if (!response.body) throw new SnapshotArchiveError('invalid-response', response.status);
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > archiveBytes)) throw new SnapshotArchiveError('response-too-large', response.status);
        let compressed = 0;
        const compressedStream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array<ArrayBuffer>>({ transform(value, out) {
          compressed += value.byteLength;
          if (compressed > archiveBytes) throw new SnapshotArchiveError('response-too-large', response?.status);
          out.enqueue(new Uint8Array(value));
        } }));
        reader = compressedStream.pipeThrough(new DecompressionStream('gzip')).getReader();
        const selected = reader;
        async function* chunks() {
          let expanded = 0;
          for (;;) {
            check();
            const next = await Promise.race([selected.read(), deadline]);
            check();
            if (next.done) return;
            expanded += next.value.byteLength;
            if (expanded > expandedBytes) throw new SnapshotArchiveError('response-too-large', response?.status);
            yield next.value;
          }
        }
        const checked = checkedTarChunks(chunks());
        for await (const entry of readTar(checked)) {
          check();
          if (!entry.path.endsWith('.xml')) continue;
          const path = entry.path.replace(/^[^/]+\//, '');
          if (paths.some(prefix => path.startsWith(prefix))) yield { path, content: entry.content.toString('utf8') };
        }
        // readTar intentionally stops on the first zero block. Complete the
        // framing/gzip checks before stageCorpus can return a publishable plan.
        for await (const _ of checked) { /* drain bounded trailing framing */ }
        check();
      } catch (error) {
        if (error instanceof SnapshotArchiveError) throw error;
        if (phase === 'admission') throw new Error('Snapshot archive failed or is uncertain.');
        throw new SnapshotArchiveError(phase === 'transport' ? 'transport' : 'invalid-response', response?.status);
      }
      finally {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
        if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} }
        else if (response?.body) void response.body.cancel().catch(() => {});
      }
    },
  };
}
