import { describe, expect, it } from 'vitest';
import raw from '../src/eval/data/v1-questions.json';
import { calibrateThreshold, eligibleQuestions, goldRank, percentile, scoreV1, validateV1Dataset, type V1Observation, type V1Question } from '../src/eval/v1';

const dataset = validateV1Dataset(raw);
const revision = dataset.revision;
const positive = dataset.questions.filter((q) => q.pairId === 'A-1-4');
const negative = dataset.questions.filter((q) => q.pairId === 'unsupported-weather');
const selected = [...positive, ...negative];
const response = (q: V1Question, items: V1Observation['items'] = []): V1Observation => ({ id: q.id, outcome: 'ok', items, elapsedMs: 10 });

describe('v1 evaluation provenance and partitioning', () => {
  it('adds 24 new held-out provisions across 12 Acts, with paired English/French questions', () => {
    const held = dataset.questions.filter((q) => q.answerable && q.split === 'holdout');
    expect(held).toHaveLength(48);
    expect(new Set(held.map((q) => q.pairId)).size).toBe(24);
    expect(new Set(held.map((q) => q.group)).size).toBe(12);
    expect(dataset.questions.filter((q) => q.answerable)).toHaveLength(60);
    expect(eligibleQuestions(dataset, revision).eligible).toHaveLength(84);
  });
  it('keeps unverified HST labels out of every denominator', () => {
    const result = eligibleQuestions(dataset, revision);
    expect(result.excluded).toEqual([
      { id: 'ambiguous-hst-en', reason: 'unverified label' },
      { id: 'ambiguous-hst-fr', reason: 'unverified label' },
    ]);
  });
  it('does not silently reuse positive labels on a new corpus revision', () => {
    const result = eligibleQuestions(dataset, 'f'.repeat(40));
    expect(result.eligible).toHaveLength(24);
    expect(result.eligible.every((q) => !q.answerable)).toBe(true);
    expect(result.excluded.filter((q) => q.reason.includes('revision'))).toHaveLength(60);
  });
  it('rejects a calibration/holdout split of the same Act', () => {
    const changed = structuredClone(raw);
    changed.questions[0]!.split = 'calibration';
    expect(() => validateV1Dataset(changed)).toThrow('group leakage');
  });
  it('rejects gold marked verified without a source digest', () => {
    const changed = structuredClone(raw);
    delete changed.questions[0]!.provenance.sourceSha256;
    expect(() => validateV1Dataset(changed)).toThrow('provenance');
  });
});

describe('v1 serving metrics', () => {
  it('distinguishes failed requests, refusals, accepted wrong results and gold hits', () => {
    const en = positive[0]!; const fr = positive[1]!;
    const result = scoreV1(selected, [
      response(en, [{ id: 'distractor', language: 'en' }, { id: en.gold!.rowIds[0]!, language: 'en' }]),
      { ...response(fr), outcome: 'http-error', status: 503 },
      response(negative[0]!, [{ id: 'irrelevant', language: 'en' }]),
      response(negative[1]!),
    ]);
    expect(result.overall.hitAt5).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(result.overall.mrr).toBe(0.25);
    expect(result.overall.falseRejection).toEqual({ numerator: 0, denominator: 1, value: 0 });
    expect(result.overall.falseAcceptance).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(result.overall.requestErrors).toBe(1);
    expect(result.overall.upstreamErrorResponses).toBe(1);
    expect(result.paired.bothHitAt5.denominator).toBe(1);
    expect(result.paired.onlyEnglishHitAt5).toBe(1);
  });
  it('counts a wrong-language gold row as a miss', () => {
    const en = positive[0]!;
    expect(goldRank(en, response(en, [{ id: en.gold!.rowIds[0]!, language: 'fr' }]))).toBeNull();
    expect(goldRank(en, response(en, [{ id: en.gold!.rowIds[0]! }]))).toBeNull();
  });
  it('keeps missing requests in ranking denominators and out of refusal denominators', () => {
    const result = scoreV1(positive, [response(positive[0]!)]).overall;
    expect(result.missing).toBe(1);
    expect(result.hitAt5.denominator).toBe(2);
    expect(result.falseRejection).toEqual({ numerator: 1, denominator: 1, value: 1 });
  });
  it('returns null for empty denominators instead of a false zero-error rate', () => {
    expect(scoreV1([], []).overall.falseAcceptance.value).toBeNull();
  });
  it('does not accept duplicate or unrelated observations', () => {
    expect(() => scoreV1(selected, [response(positive[0]!), response(positive[0]!)])).toThrow('Duplicate');
    expect(() => scoreV1(selected, [{ ...response(positive[0]!), id: 'not-selected' }])).toThrow('Unexpected');
  });
  it('uses the nearest-rank percentile over real request samples', () => {
    expect(percentile([40, 10, 30, 20], 0.5)).toBe(20);
    expect(percentile([40, 10, 30, 20], 0.95)).toBe(40);
    expect(percentile([], 0.95)).toBeNull();
    expect(() => percentile([NaN], 0.5)).toThrow('latency');
  });
});

describe('backend-specific calibration', () => {
  const calibration = selected.map((q) => ({ ...q, split: 'calibration' as const }));
  const provenance = { backend: 'vectorize' as const, corpusRevision: revision, parserVersion: 'statutes-v2', encoderModel: 'embeddinggemma-2-270m', scorePolicyId: 'raw-vectorize-language-filtered' };
  const scores = calibration.map((q, at) => ({ id: q.id, bestScore: [0.9, 0.8, 0.7, 0.6][at]! }));
  it('selects a floor above calibration negatives without touching held-out data', () => {
    const result = calibrateThreshold(calibration, scores, provenance);
    expect(result.selected.threshold).toBeGreaterThan(0.7);
    expect(result.selected.threshold).toBeLessThan(0.8);
    expect(result.selected.falseAcceptance.value).toBe(0);
    expect(result.selected.falseRejection.value).toBe(0);
  });
  it('rejects held-out observations, incomplete coverage and mismatched revision', () => {
    expect(() => calibrateThreshold(selected, scores, provenance)).toThrow('Holdout');
    expect(() => calibrateThreshold(calibration, scores.slice(1), provenance)).toThrow('incomplete');
    expect(() => calibrateThreshold(calibration, scores, { ...provenance, corpusRevision: 'f'.repeat(40) })).toThrow('revision');
  });
  it('reports independent thresholds for backends on different score scales', () => {
    const vectorize = calibrateThreshold(calibration, scores, provenance);
    const postgres = calibrateThreshold(calibration, scores.map((s) => ({ ...s, bestScore: s.bestScore / 2 })), { ...provenance, backend: 'postgres', scorePolicyId: 'raw-pgvector-cosine-language-filtered' });
    expect(postgres.selected.threshold).toBeLessThan(vectorize.selected.threshold);
    expect(postgres.provenance.backend).toBe('postgres');
  });
});
