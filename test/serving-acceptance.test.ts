import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RETRIEVAL_POLICY_VERSION, type RetrievalObservation } from '../src/corpora/retrieval-observation';
import raw from '../src/eval/data/v1-november-questions.json';
import { checkServingAcceptance } from '../src/eval/serving-acceptance';
import { validateV1Dataset, type RetrievedItem, type V1Observation, type V1Question } from '../src/eval/v1';
import { balancedSchedule, targetProvenanceSchema } from '../src/eval/v1-target';

const measuredAt = '2026-11-23T02:00:00Z';
function fixture(revision = raw.revision, head = revision) {
  const dataset = validateV1Dataset({ ...raw, revision, questions: raw.questions.map((q) =>
    q.answerable ? { ...q, provenance: { ...q.provenance, revision } } : q) });
  const datasetSha256 = createHash('sha256').update(JSON.stringify(dataset)).digest('hex');
  const provenance = targetProvenanceSchema.parse({
    backend: 'vectorize', environment: 'staging', deployment: 'synthetic-stage-version', corpusRevision: revision,
    parserVersion: 'statutes-v2', corpusAsOf: '2026-10-15', corpusLastRunAt: '2026-11-22T12:00:00Z',
    upstream: { revision: head, committedAt: '2026-11-20T00:00:00Z', observedAt: '2026-11-23T00:00:00Z' },
    encoderModel: 'embeddinggemma-2-270m', encoderArtifact: 'synthetic-image', encoderDimensions: 768,
    retrievalPolicy: `vectorize:${RETRIEVAL_POLICY_VERSION}`, reranker: 'synthetic-reranker',
    evidence: { source: 'test fixture', observedAt: '2026-11-23T00:00:00Z', note: 'No network or model execution.' },
  });
  const origin = 'http://127.0.0.1:8788';
  const base = {
    startedAt: '2026-11-23T01:00:00Z', endedAt: measuredAt,
    target: { origin, route: '/api/statutes', limit: 10 }, provenance,
    dataset: { version: dataset.version, sha256: datasetSha256 },
    discovery: { status: 200, encoder: { model: provenance.encoderModel, dimensions: provenance.encoderDimensions } },
  };
  function response(q: V1Question): V1Observation {
    const items = q.gold ? [{ id: q.gold.rowIds[0]!, language: q.language }] : [];
    const trace: RetrievalObservation = {
      version: 1, corpusId: 'statutes-canada', backend: 'vectorize', revision, parserVersion: provenance.parserVersion,
      policy: provenance.retrievalPolicy, encoderModel: provenance.encoderModel, mode: 'vector-floor',
      decision: q.answerable ? 'answer' : 'refuse', languageFilter: q.language, preRefusalTopScore: q.answerable ? 0.9 : 0.4,
      scoreSource: 'computed', scoredAt: base.startedAt, vectorFloor: 0.62, candidateCount: 10, resultCount: items.length,
      cache: 'bypass', fallback: false, providers: { encoder: 'ok', vector: 'ok', rows: 'ok', reranker: 'ok' }, elapsedMs: 30,
    };
    return { id: q.id, items, elapsedMs: 100, outcome: 'ok', status: 200, retrieval: [trace] };
  }
  const calibration = { ...base, kind: 'serving-path-retrieval-evaluation',
    observations: dataset.questions.filter((q) => q.split === 'calibration').map(response) };
  const holdout = { ...base, kind: 'serving-path-retrieval-evaluation',
    observations: dataset.questions.filter((q) => q.split === 'holdout').map(response) };
  const benchmark = { ...base, kind: 'closed-loop-serving-http-benchmark', billableRequestsAttempted: 44,
    runs: [1, 4].map((concurrency) => ({ concurrency,
      observations: balancedSchedule(dataset.questions, 20).map((q, at) => response({ ...q, id: `${q.id}#${at}` })),
      warmupObservations: dataset.questions.slice(0, 2).map(response),
    })),
  };
  return { dataset, datasetSha256, provenance, origin, limit: 10, benchmarkSplit: 'all' as const, calibration, holdout, benchmark };
}

function items(row: V1Observation, replacement: RetrievedItem[]) {
  row.items = replacement;
  const trace = row.retrieval![0]!;
  trace.resultCount = replacement.length;
  trace.decision = replacement.length ? 'answer' : 'refuse';
}

describe('offline D-01 serving acceptance', () => {
  it('accepts the approved accuracy, latency and observation-age boundaries', () => {
    const input = fixture();
    const french = input.holdout.observations.filter((row) => row.retrieval![0]!.languageFilter === 'fr' && row.items.length);
    items(french[0]!, []);
    items(french[1]!, [{ id: 'distractor', language: 'fr' }]);
    for (const run of input.benchmark.runs) {
      for (const row of run.observations) row.elapsedMs = 8000;
      run.observations[19]!.elapsedMs = 9000;
    }
    input.provenance.upstream.observedAt = '2026-11-22T02:00:00Z';
    expect(checkServingAcceptance(input)).toMatchObject({ ready: true, latencies: [
      { concurrency: 1, p95Ms: 8000 }, { concurrency: 4, p95Ms: 8000 },
    ], languageResults: [{ language: 'en', hitAt5: { numerator: 24 } }, { language: 'fr', hitAt5: { numerator: 22 } }] });
  });

  it('checks correctness separately in each language and ignores supplied summary metrics', () => {
    const input = fixture();
    const french = input.holdout.observations.filter((row) => row.retrieval![0]!.languageFilter === 'fr');
    const positives = french.filter((row) => row.items.length);
    const wrongLanguage = [{ id: positives[0]!.items[0]!.id, language: 'en' }];
    items(positives[0]!, wrongLanguage);
    items(positives[1]!, []);
    items(positives[2]!, []);
    items(french.find((row) => !row.items.length && !positives.includes(row))!, [{ id: 'outside-scope', language: 'fr' }]);
    const result = checkServingAcceptance({ ...input, holdout: { ...input.holdout, metrics: { fabricated: true } } });
    expect(result.issues).toEqual([
      { code: 'top-five', language: 'fr' }, { code: 'unsupported-accept', language: 'fr' },
      { code: 'false-refusal', language: 'fr' },
    ]);
  });

  it('rejects too many nonempty misses even when top-five is sufficient', () => {
    const input = fixture();
    const english = input.holdout.observations.filter((row) => row.retrieval![0]!.languageFilter === 'en' && row.items.length);
    for (const row of english.slice(0, 2)) items(row, [{ id: 'distractor', language: 'en' }]);
    expect(checkServingAcceptance(input).issues).toEqual([{ code: 'accepted-without-gold', language: 'en' }]);
  });

  it('checks latency independently per concurrency and includes warm-up failures', () => {
    const input = fixture();
    input.benchmark.runs[0]!.warmupObservations[0]!.status = 502;
    for (const row of input.benchmark.runs[1]!.observations.slice(18)) row.elapsedMs = 8001;
    expect(checkServingAcceptance(input).issues).toEqual([
      { code: 'incomplete-benchmark', phase: 'benchmark', concurrency: 1 },
      { code: 'benchmark-p95', phase: 'benchmark', concurrency: 4 },
    ]);
  });

  it('requires the matching encoder contract in all three discovery responses', () => {
    const input = fixture();
    const result = checkServingAcceptance({
      ...input,
      calibration: { ...input.calibration, discovery: { status: 502, encoder: null } },
      holdout: { ...input.holdout, discovery: { status: 200, encoder: null } },
      benchmark: { ...input.benchmark, discovery: { status: 200, encoder: { ...input.benchmark.discovery.encoder, dimensions: 384 } } },
    });
    expect(result.issues).toEqual([
      { code: 'discovery-mismatch', phase: 'calibration' },
      { code: 'discovery-mismatch', phase: 'holdout' },
      { code: 'discovery-mismatch', phase: 'benchmark' },
    ]);
  });

  it.each(['cached-calibration', 'different-deployment', 'different-dataset', 'replaced-holdout-id', 'wrong-observation-revision', 'wrong-benchmark-split'])
  ('refuses %s under the reviewed run', (fault) => {
    const input = fixture();
    if (fault === 'cached-calibration') input.calibration.observations[0]!.retrieval![0]!.cache = 'hit';
    if (fault === 'different-deployment') input.benchmark.provenance = { ...input.provenance, deployment: 'other' };
    if (fault === 'different-dataset') input.holdout.dataset = { ...input.holdout.dataset, sha256: 'a'.repeat(64) };
    if (fault === 'replaced-holdout-id') input.holdout.observations[0]!.id = input.calibration.observations[0]!.id;
    if (fault === 'wrong-observation-revision') input.holdout.observations[0]!.retrieval![0]!.revision = 'b'.repeat(40);
    const result = checkServingAcceptance({ ...input, benchmarkSplit: fault === 'wrong-benchmark-split' ? 'holdout' : 'all' });
    expect(result.ready).toBe(false);
  });

  it('rejects stale or future head observations even when the served revision matches', () => {
    const input = fixture();
    for (const observedAt of ['2026-11-22T01:59:59Z', '2026-11-23T02:00:01Z']) {
      input.provenance.upstream.observedAt = observedAt;
      expect(checkServingAcceptance(input).issues).toEqual([{ code: 'freshness' }]);
    }
  });

  it('requires the exact ancestor approval, ancestry proof and a recent commit', () => {
    const input = fixture(raw.revision, 'b'.repeat(40));
    const ancestorCommitTime = vi.fn(() => Date.parse('2026-11-16T02:00:00Z'));
    expect(checkServingAcceptance({ ...input, ancestorCommitTime }).issues).toEqual([{ code: 'freshness' }]);
    expect(ancestorCommitTime).not.toHaveBeenCalled();
    const approved = { ...input, approvedAncestor: raw.revision };
    expect(checkServingAcceptance(approved).issues).toEqual([{ code: 'freshness' }]);
    expect(checkServingAcceptance({ ...approved, ancestorCommitTime }).ready).toBe(true);
    expect(ancestorCommitTime).toHaveBeenCalledWith(raw.revision, 'b'.repeat(40));
    expect(checkServingAcceptance({ ...approved, ancestorCommitTime: () => Date.parse('2026-11-16T01:59:59Z') }).issues)
      .toEqual([{ code: 'freshness' }]);
  });

  it('checks ancestor history and its actual commit timestamp through the offline CLI', () => {
    const directory = mkdtempSync(join(tmpdir(), 'civicsignal-d01-fixture-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', directory, '-c', 'user.name=Fixture',
        '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-21T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-11-21T00:00:00Z' } }).trim();
      git('init', '-q');
      git('commit', '-q', '--allow-empty', '-m', 'Ancestor');
      const ancestor = git('rev-parse', 'HEAD');
      git('commit', '-q', '--allow-empty', '-m', 'Observed head');
      const head = git('rev-parse', 'HEAD');
      const run = (served: string, observed: string) => {
        const input = fixture(served, observed);
        const reports = ['dataset', 'provenance', 'calibration', 'holdout', 'benchmark'] as const;
        for (const name of reports) writeFileSync(join(directory, name), JSON.stringify(input[name]));
        return spawnSync('bun', ['scripts/check-serving-acceptance.ts',
          ...reports.flatMap((name) => [`--${name}`, join(directory, name)]),
          '--origin', input.origin, '--benchmark-split', 'all', '--approved-ancestor', served, '--source-repo', directory],
        { encoding: 'utf8', timeout: 15_000 });
      };
      const accepted = run(ancestor, head);
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(JSON.parse(accepted.stdout).ready).toBe(true);
      const reversed = run(head, ancestor);
      expect(reversed.status, reversed.stderr).toBe(1);
      expect(JSON.parse(reversed.stdout).issues).toEqual([{ code: 'freshness' }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
