import { describe, expect, it } from 'vitest';
import raw from '../src/eval/data/v1-questions.json';
import { RETRIEVAL_POLICY_VERSION, retrievalObservationSchema } from '../src/corpora/retrieval-observation';
import { observedCalibration, servingObservationSummary, validateServingProvenance } from '../src/eval/v1-observed';
import { validateV1Dataset, type V1Observation, type V1Question } from '../src/eval/v1';
import type { TargetProvenance } from '../src/eval/v1-target';

const dataset = validateV1Dataset(raw);
const questions = dataset.questions.filter((q) => q.split === 'calibration');
const expected: TargetProvenance = {
  backend: 'vectorize', environment: 'local-fixture', deployment: 'fixture', corpusRevision: dataset.revision, parserVersion: 'statutes-v2',
  corpusAsOf: '2026-10-20', corpusLastRunAt: '2026-10-22T00:00:00Z',
  upstream: { revision: dataset.revision, committedAt: '2026-10-20T00:00:00Z', observedAt: '2026-10-22T00:00:00Z' },
  encoderModel: 'embeddinggemma-2-270m', encoderArtifact: 'fixture-file', encoderDimensions: 768,
  retrievalPolicy: `vectorize:${RETRIEVAL_POLICY_VERSION}`, reranker: 'disabled',
  evidence: { source: 'unit fixture', observedAt: '2026-10-22T00:00:00Z', note: 'Synthetic metadata for collector validation, not a measured score' },
};
function response(question: V1Question): V1Observation {
  const items = question.gold ? [{ id: question.gold.rowIds[0]!, language: question.language }] : [];
  return { id: question.id, outcome: 'ok', elapsedMs: 1, items, retrieval: [retrievalObservationSchema.parse({
    version: 1, corpusId: 'statutes-canada', backend: 'vectorize', revision: dataset.revision, parserVersion: expected.parserVersion,
    policy: expected.retrievalPolicy, encoderModel: expected.encoderModel, mode: 'vector-floor', decision: question.answerable ? 'answer' : 'refuse',
    languageFilter: question.language, preRefusalTopScore: question.answerable ? 0.9 : 0.4, scoreSource: 'computed', scoredAt: '2026-10-22T00:00:00Z',
    vectorFloor: 0.62, candidateCount: 10, resultCount: items.length, cache: 'bypass', fallback: false,
    providers: { encoder: 'ok', vector: 'ok', rows: question.answerable ? 'ok' : 'not-called', reranker: 'disabled' }, elapsedMs: 1,
  })] };
}

describe('calibration from actual serving observation contract', () => {
  it('collects all 20 calibration scores, including scores from refused responses', () => {
    const result = observedCalibration(dataset.questions, questions.map(response), expected);
    expect(result.ready).toBe(true);
    expect(result.acceptedScores).toBe(20);
    expect(result.threshold!.selected.falseAcceptance.value).toBe(0);
    expect(result.threshold!.selected.falseRejection.value).toBe(0);
    expect(result.observations.filter((s) => s.bestScore < 0.62)).toHaveLength(8);
  });
  it.each(['language', 'backend', 'parser', 'encoder', 'policy', 'cached', 'exact', 'provider'] as const)('does not calibrate from a %s mismatch', (mismatch) => {
    const responses = questions.map(response);
    const trace = responses[0]!.retrieval![0]!;
    if (mismatch === 'language') trace.languageFilter = 'fr';
    if (mismatch === 'backend') trace.backend = 'postgres-cosine';
    if (mismatch === 'parser') trace.parserVersion = 'different-parser';
    if (mismatch === 'encoder') trace.encoderModel = 'different-model';
    if (mismatch === 'policy') trace.policy = 'different-policy';
    if (mismatch === 'cached') { trace.scoreSource = 'cached'; trace.cache = 'hit'; }
    if (mismatch === 'exact') trace.mode = 'exact';
    if (mismatch === 'provider') trace.providers.vector = 'error';
    const result = observedCalibration(dataset.questions, responses, expected);
    expect(result.ready).toBe(false);
    expect(result.acceptedScores).toBe(19);
    expect(result.rejected).toHaveLength(1);
    expect(result.threshold).toBeNull();
  });
  it('never substitutes missing metadata or an unfiltered match response', () => {
    const responses = questions.map(response);
    delete responses[0]!.retrieval;
    const result = observedCalibration(dataset.questions, responses, expected);
    expect(result.ready).toBe(false);
    expect(result.rejected[0]!.reason).toContain('serving retrieval observation');
  });
  it('does not count wrong deployment metadata or missing metadata as successful retrieval evidence', () => {
    const correct = response(questions[0]!);
    const wrong = response(questions[1]!);
    wrong.retrieval![0]!.parserVersion = 'legacy';
    const missing = response(questions[2]!);
    delete missing.retrieval;
    const checked = validateServingProvenance([correct, wrong, missing], expected);
    expect(checked[0]!.outcome).toBe('ok');
    expect(checked[1]!.errorCode).toBe('RETRIEVAL_PROVENANCE_MISMATCH');
    expect(checked[2]!.errorCode).toBe('RETRIEVAL_PROVENANCE_MISMATCH');
    expect(checked[1]!.items).toEqual([]);
  });
  it('rejects holdout observations and duplicate cases', () => {
    expect(() => observedCalibration(dataset.questions, [response(dataset.questions[0]!)], expected)).toThrow('Holdout');
    expect(() => observedCalibration(dataset.questions, [response(questions[0]!), response(questions[0]!)], expected)).toThrow('Duplicate');
  });
  it('reports provider fallbacks separately from HTTP success', () => {
    const successfulFallback = response(questions[0]!);
    successfulFallback.retrieval![0]!.providers.reranker = 'error';
    successfulFallback.retrieval![0]!.fallback = true;
    const cached = response(questions[1]!);
    cached.retrieval![0]!.cache = 'hit';
    cached.retrieval![0]!.scoreSource = 'cached';
    const summary = servingObservationSummary([successfulFallback, cached, { id: 'failed', outcome: 'http-error', elapsedMs: 1, items: [] }]);
    expect(summary.providerFailures.reranker).toBe(1);
    expect(summary.fallbackExecutions).toBe(1);
    expect(summary.cacheHits).toBe(1);
    expect(summary.requestsWithoutTelemetry).toBe(1);
  });
});
