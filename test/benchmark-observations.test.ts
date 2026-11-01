import { afterEach, describe, expect, it, vi } from 'vitest';
import raw from '../src/eval/data/v1-questions.json';
import { retrievalTrace } from '../src/corpora/retrieval-observation';
import type { V1Observation } from '../src/eval/v1';
import type { TargetProvenance } from '../src/eval/v1-target';

const provenance: TargetProvenance = {
  backend: 'vectorize', environment: 'local-fixture', deployment: 'synthetic-benchmark',
  corpusRevision: raw.revision, parserVersion: 'statutes-v2', corpusAsOf: '2026-10-15',
  corpusLastRunAt: '2026-10-22T00:00:00Z',
  upstream: { revision: raw.revision, committedAt: '2026-10-15T00:00:00Z', observedAt: '2026-10-22T00:00:00Z' },
  encoderModel: 'embeddinggemma-2-270m', encoderArtifact: 'synthetic-no-model', encoderDimensions: 768,
  retrievalPolicy: 'vectorize:federal-authority-v3-observed', reranker: 'synthetic-no-provider',
  evidence: { source: 'local injected observations', observedAt: '2026-10-22T00:00:00Z', note: 'No network or model execution.' },
};
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.doUnmock('../src/eval/v1-target');
  vi.doUnmock('../src/eval/v1-cli');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('benchmark warmup evidence', () => {
  it.each(['rows-error', 'provenance-mismatch'])('retains %s warmups and the same 44 request attempts', async (fault) => {
    vi.resetModules();
    const observations: V1Observation[] = [];
    let attempts = 0;
    const request = vi.fn(async (_target, question): Promise<V1Observation> => {
      const at = attempts++;
      const fail = at % 22 === 0;
      const trace = await retrievalTrace({ fetch, now: () => new Date(), corpusRevision:
        `${fail && fault === 'provenance-mismatch' ? 'b'.repeat(40) : raw.revision}:statutes-v2` }, question, 'vectorize', 'vector-floor', 0.62);
      trace.observation.decision = fail && fault === 'rows-error' ? 'error' : 'refuse';
      if (fail && fault === 'rows-error') trace.observation.providers.rows = 'error';
      const value: V1Observation = { id: question.id, items: [], elapsedMs: 1,
        correlationId: `synthetic-request-${at}`, status: fail && fault === 'rows-error' ? 502 : 200,
        outcome: fail && fault === 'rows-error' ? 'http-error' : 'ok', retrieval: [trace.observation],
        ...(fail && fault === 'rows-error' ? { errorCode: 'UPSTREAM_UNAVAILABLE' } : {}) };
      observations[at] = value;
      return value;
    });
    vi.doMock('../src/eval/v1-target', async () => ({ ...await vi.importActual<typeof import('../src/eval/v1-target')>('../src/eval/v1-target'), requestRetrieval: request }));
    const writeReport = vi.fn();
    vi.doMock('../src/eval/v1-cli', async () => ({ ...await vi.importActual<typeof import('../src/eval/v1-cli')>('../src/eval/v1-cli'),
      targetInputs: () => ({ target: { baseUrl: 'http://127.0.0.1:1', route: '/api/statutes', limit: 10, timeoutMs: 1 }, provenance }),
      readDiscovery: async () => ({ status: 200, encoder: { model: provenance.encoderModel } }), writeReport }));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('External requests are forbidden in this synthetic benchmark fixture.'); }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = ['node', 'scripts/bench-v1.ts', '--requests', '20', '--warmup', '2', '--concurrency', '1,4'];
    await import('../scripts/bench-v1');

    expect(request).toHaveBeenCalledTimes(44);
    expect(writeReport).toHaveBeenCalledTimes(1);
    const report = writeReport.mock.calls[0]![1];
    expect(report.billableRequestsAttempted).toBe(44);
    expect(report.runs).toHaveLength(2);
    for (const [at, run] of report.runs.entries()) {
      expect(run.warmupRequests).toBe(2);
      expect(run.warmupFailures).toBe(1);
      expect(run.warmupObservations).toHaveLength(2);
      expect(run.warmupObservations[0]).toMatchObject({ id: observations[at * 22]!.id, correlationId: `synthetic-request-${at * 22}`,
        outcome: fault === 'rows-error' ? 'http-error' : 'invalid-response',
        errorCode: fault === 'rows-error' ? 'UPSTREAM_UNAVAILABLE' : 'RETRIEVAL_PROVENANCE_MISMATCH' });
      expect(run.warmupObservations[1]).toMatchObject({ id: observations[at * 22 + 1]!.id, outcome: 'ok' });
      expect(run.measuredRequests).toBe(20);
      expect(run.completedRequests).toBe(20);
      expect(run.observations).toHaveLength(20);
    }
    expect(process.exitCode).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
