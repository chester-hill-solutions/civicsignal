import { calibrateThreshold, type ScoreObservation, type V1Observation, type V1Question } from './v1';
import type { TargetProvenance } from './v1-target';

/** A successful response from the wrong corpus/model must not be scored as
 * evidence about the supplied target. Preserve its safe metadata for diagnosis. */
export function validateServingProvenance(observations: V1Observation[], expected: TargetProvenance): V1Observation[] {
  const backend = expected.backend === 'postgres' ? 'postgres-cosine' : expected.backend;
  return observations.map((response) => {
    if (response.outcome !== 'ok') return response;
    const traces = response.retrieval?.filter((trace) => trace.corpusId === 'statutes-canada');
    const matched = traces?.length === 1 && traces[0]!.backend === backend && traces[0]!.revision === expected.corpusRevision &&
      traces[0]!.parserVersion === expected.parserVersion && traces[0]!.encoderModel === expected.encoderModel && traces[0]!.policy === expected.retrievalPolicy;
    return matched ? response : { ...response, outcome: 'invalid-response', errorCode: 'RETRIEVAL_PROVENANCE_MISMATCH', items: [] };
  });
}

/** Use only actual serving-path observations. Refusals retain their pre-floor
 * score. Cache origins, exact lookups and an unfiltered /api/match are excluded. */
export function observedCalibration(questions: V1Question[], observations: V1Observation[], expected: TargetProvenance) {
  const calibration = questions.filter((q) => q.split === 'calibration' && q.status !== 'unverified');
  const ids = new Map(observations.map((observation) => [observation.id, observation]));
  if (ids.size !== observations.length) throw new Error('Duplicate calibration observations');
  if (observations.some((o) => !questions.some((q) => q.id === o.id))) throw new Error('Unknown calibration observation');
  if (observations.some((o) => questions.some((q) => q.id === o.id && q.split === 'holdout'))) throw new Error('Holdout observations cannot select a threshold');
  const scores: (ScoreObservation & { scoredAt: string; mode: string; fallback: boolean; vectorFloor: number | null })[] = [];
  const rejected: { id: string; reason: string }[] = [];
  const backend = expected.backend === 'postgres' ? 'postgres-cosine' : expected.backend;
  for (const question of calibration) {
    const response = ids.get(question.id);
    const traces = response?.retrieval?.filter((trace) => trace.corpusId === 'statutes-canada');
    const trace = traces?.[0];
    let reason = '';
    if (response?.outcome !== 'ok') reason = 'missing or failed serving response';
    else if (traces?.length !== 1 || !trace) reason = 'exactly one serving retrieval observation is required';
    else if (trace.backend !== backend || trace.revision !== expected.corpusRevision || trace.parserVersion !== expected.parserVersion || trace.encoderModel !== expected.encoderModel || trace.policy !== expected.retrievalPolicy) reason = 'backend, corpus, parser, encoder or policy mismatch';
    else if (trace.languageFilter !== question.language) reason = 'score was not filtered for the question language';
    else if (trace.mode === 'exact' || trace.mode === 'unavailable' || trace.scoreSource !== 'computed' || trace.cache === 'hit') reason = 'fresh pre-refusal vector execution is required';
    else if (trace.preRefusalTopScore === null || !Number.isFinite(trace.preRefusalTopScore) || !trace.scoredAt || trace.providers.encoder !== 'ok' || trace.providers.vector !== 'ok') reason = 'no valid score from a successful encoder and vector query';
    if (reason || !trace || trace.preRefusalTopScore === null || !trace.scoredAt) rejected.push({ id: question.id, reason: reason || 'invalid observation' });
    else scores.push({ id: question.id, bestScore: trace.preRefusalTopScore, scoredAt: trace.scoredAt, mode: trace.mode, fallback: trace.fallback, vectorFloor: trace.vectorFloor });
  }
  const provenance = { backend: expected.backend, corpusRevision: expected.corpusRevision, parserVersion: expected.parserVersion,
    encoderModel: expected.encoderModel, scorePolicyId: `${expected.retrievalPolicy}:language-filtered:pre-refusal` };
  return {
    ready: rejected.length === 0, plannedCalibrationQuestions: calibration.length,
    acceptedScores: scores.length, rejected, provenance, observations: scores,
    threshold: rejected.length ? null : calibrateThreshold(calibration, scores, provenance),
  };
}

export function servingObservationSummary(observations: V1Observation[]) {
  const traces = observations.flatMap((response) => response.retrieval ?? []);
  return {
    requestsWithTelemetry: observations.filter((response) => response.retrieval?.length).length,
    requestsWithoutTelemetry: observations.filter((response) => !response.retrieval?.length).length,
    freshScores: traces.filter((trace) => trace.scoreSource === 'computed').length,
    cachedScores: traces.filter((trace) => trace.scoreSource === 'cached').length,
    fallbackExecutions: traces.filter((trace) => trace.fallback && trace.cache !== 'hit').length,
    cacheHits: traces.filter((trace) => trace.cache === 'hit').length,
    modes: Object.fromEntries(['exact', 'rerank', 'vector-floor', 'unavailable'].map((mode) => [mode, traces.filter((trace) => trace.mode === mode).length])),
    providerFailures: Object.fromEntries(['encoder', 'vector', 'reranker', 'rows'].map((provider) => [provider,
      traces.filter((trace) => trace.providers[provider as keyof typeof trace.providers] === 'error').length])),
  };
}
