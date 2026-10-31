import { type InstrumentFile } from '../../src/ingest/source';
import { requestSourceHead, parseSourceHeadRateLimits, SOURCE_HEAD_TIMEOUT_MS, SourceHeadError, type SourceHeadSend } from '../../src/ingest/source-head';
import { assertQualificationSourceWindow, reserveSourceAttempt, type Qualification, type QualificationBucket } from './qualification';

const API = 'https://api.github.com/repos/justicecanada/laws-lois-xml';
export { SNAPSHOT_ARCHIVE_TIMEOUT_MS as QUALIFICATION_ARCHIVE_TIMEOUT_MS,
  SNAPSHOT_ARCHIVE_MAX_BYTES as QUALIFICATION_ARCHIVE_MAX_BYTES,
  SNAPSHOT_EXPANDED_MAX_BYTES as QUALIFICATION_EXPANDED_MAX_BYTES } from './archive-source';
import { snapshotArchive } from './archive-source';
const headers = { accept: 'application/vnd.github+json', 'user-agent': 'civicsignal-scheduled-qualification' };

/** The stage-only transport reuses the real head parser and tar reader. It has
 * no credentials, alternate URL, redirects, pagination or hidden retries. Each
 * actual fetch is preceded by a durable phase reservation. */
export function qualificationSource(bucket: QualificationBucket, q: Qualification, send: SourceHeadSend = fetch,
  limits: { archiveTimeoutMs?: number; archiveBytes?: number; expandedBytes?: number; now?: () => number; monotonicNow?: () => number } = {}) {
  const wall = limits.now ?? Date.now, monotonic = limits.monotonicNow ?? (() => performance.now());
  return {
    async head(phase: 'discovery' | 'authoritative') {
      const started = monotonic();
      function check() {
        const at = monotonic();
        if (!Number.isFinite(at) || !Number.isFinite(started) || at < started || at - started >= SOURCE_HEAD_TIMEOUT_MS) throw new SourceHeadError('timeout');
        assertQualificationSourceWindow(q, wall);
      }
      check();
      const branch = phase === 'discovery' ? 'main' : q.identity.revision.commit;
      const expected = API + '/commits?' + new URLSearchParams({ sha: branch, per_page: '1' });
      let response: Response | undefined;
      try {
        const result = await requestSourceHead(API, branch, headers, async (url, init) => {
          if (url !== expected || init.signal?.aborted) throw new Error('Qualification source transport was rejected.');
          await reserveSourceAttempt(bucket, q, phase, wall);
          check();
          if (init.signal?.aborted) throw new Error('Qualification source deadline expired.');
          response = await send(expected, { method: 'GET', headers, redirect: 'manual', signal: init.signal });
          return response;
        });
        check();
        return result;
      } catch (error) {
        if (error instanceof SourceHeadError && response) {
          throw new SourceHeadError(error.code, error.status ?? response.status, {
            ...parseSourceHeadRateLimits(response.headers), ...error.rateLimits,
          });
        }
        throw error;
      }
    },
    async *instruments(commit: string, paths: readonly string[]): AsyncGenerator<InstrumentFile> {
      if (commit !== q.identity.revision.commit) throw new Error('Qualification archive revision differs.');
      const source = snapshotArchive({ send, timeoutMs: limits.archiveTimeoutMs, archiveBytes: limits.archiveBytes,
        expandedBytes: limits.expandedBytes, beforeSend: () => reserveSourceAttempt(bucket, q, 'archive', wall),
        assertCanSend: () => assertQualificationSourceWindow(q, wall), monotonicNow: monotonic });
      yield* source.instruments(commit, paths);
    },
  };
}
