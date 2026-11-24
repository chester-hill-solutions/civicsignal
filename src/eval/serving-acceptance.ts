import { z } from 'zod';
import { retrievalObservationSchema } from '../corpora/retrieval-observation';
import { eligibleQuestions, percentile, rate, scoreV1, type V1Dataset, type V1Observation, type V1Question } from './v1';
import { observedCalibration, validateServingProvenance } from './v1-observed';
import { balancedSchedule, targetProvenanceSchema, type TargetProvenance } from './v1-target';

const hourMs = 3_600_000;
const measuredRequests = 20;
const warmupRequests = 2;
const benchmarkLevels = [1, 4] as const;
const observation = z.object({
  id: z.string().min(1),
  items: z.array(z.object({ id: z.string().min(1), language: z.string().optional() })).max(100),
  elapsedMs: z.number().finite().nonnegative(),
  outcome: z.enum(['ok', 'http-error', 'transport-error', 'invalid-response']),
  status: z.number().int().min(100).max(599).optional(),
  retrieval: z.array(retrievalObservationSchema).max(8).optional(),
});
const report = z.object({
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  target: z.object({ origin: z.url(), route: z.literal('/api/statutes'), limit: z.number().int().min(5).max(100) }),
  provenance: targetProvenanceSchema,
  dataset: z.object({ version: z.string(), sha256: z.string() }),
  discovery: z.object({
    status: z.number().int().nullable(),
    encoder: z.object({ model: z.string(), dimensions: z.number().int().positive() }).nullish(),
  }),
});
const evaluationReport = report.extend({
  kind: z.literal('serving-path-retrieval-evaluation'),
  observations: z.array(observation).max(64),
});
const benchmarkReport = report.extend({
  kind: z.literal('closed-loop-serving-http-benchmark'),
  billableRequestsAttempted: z.literal(44),
  runs: z.array(z.object({
    concurrency: z.union([z.literal(1), z.literal(4)]),
    observations: z.array(observation).max(measuredRequests),
    warmupObservations: z.array(observation).max(warmupRequests),
  })).length(2),
});

type BenchmarkSplit = 'calibration' | 'holdout' | 'all';
type Phase = 'calibration' | 'holdout' | 'benchmark';
interface Issue {
  code: string;
  phase?: Phase;
  language?: 'en' | 'fr';
  concurrency?: number;
}

interface ServingAcceptance {
  dataset: V1Dataset;
  datasetSha256: string;
  provenance: TargetProvenance;
  origin: string;
  limit: number;
  benchmarkSplit: BenchmarkSplit;
  approvedAncestor?: string;
  ancestorCommitTime?: (ancestor: string, head: string) => number | undefined;
  calibration: unknown;
  holdout: unknown;
  benchmark: unknown;
}

function matchesSelection(observations: V1Observation[], questions: V1Question[]) {
  return observations.length === questions.length && observations.every((row, index) => row.id === questions[index]!.id);
}

function completeObservations(observations: V1Observation[], questions: V1Question[], expected: TargetProvenance) {
  return validateServingProvenance(observations, expected).every((row, index) => {
    const trace = row.retrieval?.[0];
    return row.outcome === 'ok' && row.status === 200 && trace?.languageFilter === questions[index]!.language &&
      trace.mode !== 'unavailable' && trace.decision !== 'error' && trace.decision !== 'unavailable' &&
      trace.resultCount === row.items.length;
  });
}

function validFreshness(input: ServingAcceptance, endedAt: number) {
  const { upstream, corpusRevision } = input.provenance;
  const observedAt = Date.parse(upstream.observedAt);
  const observationAge = endedAt - observedAt;
  if (observationAge < 0 || observationAge > 24 * hourMs || Date.parse(upstream.committedAt) > observedAt) return false;
  if (corpusRevision === upstream.revision) return true;
  if (corpusRevision !== input.approvedAncestor) return false;
  const ancestorAt = input.ancestorCommitTime?.(corpusRevision, upstream.revision);
  return ancestorAt !== undefined && Number.isFinite(ancestorAt) &&
    ancestorAt <= observedAt && endedAt - ancestorAt <= 7 * 24 * hourMs;
}

function freshJevFallbacks(questions: V1Question[], observations: V1Observation[], language: 'en' | 'fr') {
  const attempts = observations.flatMap((row, index) => {
    const trace = row.retrieval?.[0];
    if (questions[index]!.language !== language || !trace || trace.cache === 'hit') return [];
    return trace.providers.reranker === 'ok' || trace.providers.reranker === 'error' ? [trace] : [];
  });
  return rate(attempts.filter((trace) => trace.fallback).length, attempts.length);
}

/** Recompute D-01 from the exact observations of the reviewed staging run. */
export function checkServingAcceptance(input: ServingAcceptance) {
  const issues: Issue[] = [];
  const calibration = evaluationReport.safeParse(input.calibration);
  const holdout = evaluationReport.safeParse(input.holdout);
  const benchmark = benchmarkReport.safeParse(input.benchmark);
  if (!calibration.success) issues.push({ code: 'invalid-report', phase: 'calibration' });
  if (!holdout.success) issues.push({ code: 'invalid-report', phase: 'holdout' });
  if (!benchmark.success) issues.push({ code: 'invalid-report', phase: 'benchmark' });
  if (!calibration.success || !holdout.success || !benchmark.success) return { ready: false, issues };

  const expected = targetProvenanceSchema.parse(input.provenance);
  if (expected.backend !== 'vectorize' || expected.environment !== 'staging') issues.push({ code: 'staging-vectorize-required' });
  if (input.dataset.revision !== expected.corpusRevision) issues.push({ code: 'dataset-revision' });
  const measured = { calibration: calibration.data, holdout: holdout.data, benchmark: benchmark.data };
  for (const phase of ['calibration', 'holdout', 'benchmark'] as const) {
    const { provenance, target, dataset, discovery, startedAt, endedAt } = measured[phase];
    if (JSON.stringify(provenance) !== JSON.stringify(expected) || target.origin !== input.origin || target.limit !== input.limit) {
      issues.push({ code: 'target-mismatch', phase });
    }
    if (dataset.version !== input.dataset.version || dataset.sha256 !== input.datasetSha256) issues.push({ code: 'dataset-mismatch', phase });
    if (discovery.status !== 200 || discovery.encoder?.model !== expected.encoderModel ||
      discovery.encoder.dimensions !== expected.encoderDimensions) issues.push({ code: 'discovery-mismatch', phase });
    if (Date.parse(endedAt) < Date.parse(startedAt)) issues.push({ code: 'measurement-window', phase });
  }
  if (issues.length > 0) return { ready: false, issues };

  const calibrationQuestions = eligibleQuestions(input.dataset, expected.corpusRevision, 'calibration').eligible;
  const holdoutQuestions = eligibleQuestions(input.dataset, expected.corpusRevision, 'holdout').eligible;
  const calRows = measured.calibration.observations;
  const holdoutRows = measured.holdout.observations;
  if (calibrationQuestions.length !== 20 || !matchesSelection(calRows, calibrationQuestions) ||
    !completeObservations(calRows, calibrationQuestions, expected) ||
    !observedCalibration(calibrationQuestions, calRows, expected).ready) {
    issues.push({ code: 'incomplete-calibration', phase: 'calibration' });
  }
  const holdoutComplete = holdoutQuestions.length === 64 && matchesSelection(holdoutRows, holdoutQuestions) &&
    completeObservations(holdoutRows, holdoutQuestions, expected);
  if (!holdoutComplete) issues.push({ code: 'incomplete-holdout', phase: 'holdout' });

  const scores = holdoutComplete ? scoreV1(holdoutQuestions, holdoutRows) : undefined;
  const languageResults = scores && (['en', 'fr'] as const).map((language) => {
    const score = scores.byLanguage[language];
    if (score.answerable !== 24 || score.unanswerable !== 8) issues.push({ code: 'holdout-language-mix', language });
    if (score.hitAt5.numerator < 22) issues.push({ code: 'top-five', language });
    if (score.falseAcceptance.numerator > 0) issues.push({ code: 'unsupported-accept', language });
    if (score.falseRejection.numerator > 1) issues.push({ code: 'false-refusal', language });
    if (score.acceptedWithoutGold > 1) issues.push({ code: 'accepted-without-gold', language });
    return { language, hitAt1: score.hitAt1, hitAt5: score.hitAt5, falseAcceptance: score.falseAcceptance,
      falseRejection: score.falseRejection, acceptedWithoutGold: score.acceptedWithoutGold,
      freshJev: freshJevFallbacks(holdoutQuestions, holdoutRows, language) };
  });

  const benchmarkQuestions = eligibleQuestions(input.dataset, expected.corpusRevision, input.benchmarkSplit).eligible;
  const benchMix = new Set(benchmarkQuestions.map((q) => `${q.language}:${q.answerable}`));
  const schedule = benchMix.size === 4
    ? balancedSchedule(benchmarkQuestions, measuredRequests).map((q, index) => ({ ...q, id: `${q.id}#${index}` }))
    : [];
  const warmups = benchmarkQuestions.slice(0, warmupRequests);
  const latencies = benchmarkLevels.map((concurrency) => {
    const runs = measured.benchmark.runs.filter((run) => run.concurrency === concurrency);
    const run = runs[0];
    if (!run || runs.length !== 1 || schedule.length !== measuredRequests ||
      !matchesSelection(run.observations, schedule) || !completeObservations(run.observations, schedule, expected) ||
      !matchesSelection(run.warmupObservations, warmups) || !completeObservations(run.warmupObservations, warmups, expected)) {
      issues.push({ code: 'incomplete-benchmark', phase: 'benchmark', concurrency });
      return { concurrency, p95Ms: null };
    }
    const p95Ms = percentile(run.observations.map((row) => row.elapsedMs), 0.95);
    if (p95Ms === null || p95Ms > 8000) issues.push({ code: 'benchmark-p95', phase: 'benchmark', concurrency });
    return { concurrency, p95Ms };
  });

  const endedAt = Math.max(...Object.values(measured).map((item) => Date.parse(item.endedAt)));
  if (!validFreshness(input, endedAt)) issues.push({ code: 'freshness' });
  return { ready: issues.length === 0, issues, languageResults, paired: scores?.paired, latencies };
}
