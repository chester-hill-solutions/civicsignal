import { z } from 'zod';
import type { RetrievalObservation } from '../corpora/retrieval-observation';

const provenanceSchema = z.object({
  kind: z.enum(['corpus-provision', 'scope-exclusion', 'pending-review']),
  revision: z.string().optional(), sourcePath: z.string().optional(), sourceUrl: z.string().optional(),
  sourceSha256: z.string().optional(), rowSha256: z.string().optional(),
  evidence: z.string().min(1), annotation: z.string().optional(),
});
const questionSchema = z.object({
  id: z.string().min(1), pairId: z.string().min(1), group: z.string().min(1),
  split: z.enum(['calibration', 'holdout']), language: z.enum(['en', 'fr']),
  question: z.string().min(1), answerable: z.boolean(),
  status: z.enum(['verified-source', 'verified-scope', 'unverified']),
  gold: z.object({ rowIds: z.array(z.string().min(1)).nonempty(), act: z.string().min(1), section: z.string().min(1) }).optional(),
  provenance: provenanceSchema,
});
const datasetSchema = z.object({
  version: z.string().min(1), revision: z.string().regex(/^[a-f0-9]{40}$/),
  sourceRepository: z.string().url(), questions: z.array(questionSchema).nonempty(),
});
export type V1Question = z.infer<typeof questionSchema>;
export type V1Dataset = z.infer<typeof datasetSchema>;
export type Backend = 'vectorize' | 'postgres' | 'local-fixture';

export function validateV1Dataset(input: unknown): V1Dataset {
  const data = datasetSchema.parse(input);
  const ids = new Set<string>();
  const groups = new Map<string, string>();
  const pairs = new Map<string, V1Question[]>();
  for (const question of data.questions) {
    if (ids.has(question.id)) throw new Error(`Duplicate question id: ${question.id}`);
    ids.add(question.id);
    const split = groups.get(question.group);
    if (split && split !== question.split) throw new Error(`Calibration/holdout group leakage: ${question.group}`);
    groups.set(question.group, question.split);
    pairs.set(question.pairId, [...(pairs.get(question.pairId) ?? []), question]);
    if (question.status === 'verified-source') {
      const p = question.provenance;
      if (!question.answerable || !question.gold || p.kind !== 'corpus-provision' ||
          !/^[a-f0-9]{40}$/.test(p.revision ?? '') || !/^[a-f0-9]{64}$/.test(p.sourceSha256 ?? '') ||
          !/^[a-f0-9]{64}$/.test(p.rowSha256 ?? '') || !p.sourceUrl || !p.sourcePath) {
        throw new Error(`Incomplete verified source provenance: ${question.id}`);
      }
    }
    if (question.status === 'verified-scope' && (question.answerable || question.gold || question.provenance.kind !== 'scope-exclusion')) {
      throw new Error(`Invalid scope exclusion: ${question.id}`);
    }
  }
  for (const [id, pair] of pairs) {
    if (pair.length !== 2 || new Set(pair.map((q) => q.language)).size !== 2 ||
        new Set(pair.map((q) => `${q.split}:${q.group}:${q.answerable}:${q.status}`)).size !== 1) {
      throw new Error(`Bilingual pair must share split, group, answerability and verification: ${id}`);
    }
  }
  return data;
}

/** A new corpus revision requires source re-verification, rather than silently
 * reusing labels for possibly changed, repealed or removed provisions. */
export function eligibleQuestions(dataset: V1Dataset, corpusRevision: string, split: 'calibration' | 'holdout' | 'all' = 'all') {
  const eligible: V1Question[] = [];
  const excluded: { id: string; reason: string }[] = [];
  for (const q of dataset.questions) {
    if (split !== 'all' && q.split !== split) continue;
    if (q.status === 'unverified') excluded.push({ id: q.id, reason: 'unverified label' });
    else if (q.answerable && q.provenance.revision !== corpusRevision) excluded.push({ id: q.id, reason: 'label source revision differs from target corpus' });
    else eligible.push(q);
  }
  return { eligible, excluded };
}

export interface RetrievedItem { id: string; language?: string }
export interface V1Observation {
  id: string;
  outcome: 'ok' | 'http-error' | 'transport-error' | 'invalid-response';
  elapsedMs: number;
  items: RetrievedItem[];
  status?: number;
  errorCode?: string;
  correlationId?: string;
  retrieval?: RetrievalObservation[];
}
export interface Rate { numerator: number; denominator: number; value: number | null }
export const rate = (numerator: number, denominator: number): Rate => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
export function percentile(values: number[], quantile: number): number | null {
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) throw new Error('Quantile must be between zero and one');
  if (!values.length) return null;
  if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error('Invalid latency sample');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]!;
}
export function latencySummary(values: number[]) {
  return { samples: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), p99Ms: percentile(values, 0.99), maxMs: values.length ? Math.max(...values) : null };
}
export function goldRank(question: V1Question, observation?: V1Observation): number | null {
  if (!question.answerable || observation?.outcome !== 'ok') return null;
  // A right provision in the wrong official language is still a retrieval miss.
  const position = observation.items.findIndex((item) => question.gold?.rowIds.includes(item.id) && item.language === question.language);
  return position < 0 ? null : position + 1;
}

export function scoreV1(questions: V1Question[], observations: V1Observation[]) {
  const byId = new Map<string, V1Observation>();
  const known = new Set(questions.map((q) => q.id));
  for (const observation of observations) {
    if (!known.has(observation.id)) throw new Error(`Unexpected observation: ${observation.id}`);
    if (byId.has(observation.id)) throw new Error(`Duplicate observation: ${observation.id}`);
    byId.set(observation.id, observation);
  }
  const summarize = (selected: V1Question[]) => {
    const positive = selected.filter((q) => q.answerable);
    const negative = selected.filter((q) => !q.answerable);
    const completed = selected.filter((q) => byId.get(q.id)?.outcome === 'ok');
    const completedPositive = completed.filter((q) => q.answerable);
    const completedNegative = completed.filter((q) => !q.answerable);
    const hits = (k: number) => positive.filter((q) => { const rank = goldRank(q, byId.get(q.id)); return rank !== null && rank <= k; }).length;
    const accepted = (q: V1Question) => (byId.get(q.id)?.items.length ?? 0) > 0;
    const refused = completedPositive.filter((q) => !accepted(q)).length;
    const errors = selected.filter((q) => { const o = byId.get(q.id); return o && o.outcome !== 'ok'; });
    return {
      planned: selected.length, attempted: selected.filter((q) => byId.has(q.id)).length,
      completed: completed.length, missing: selected.filter((q) => !byId.has(q.id)).length,
      requestErrors: errors.length,
      upstreamErrorResponses: errors.filter((q) => [502, 503, 504].includes(byId.get(q.id)?.status ?? 0)).length,
      answerable: positive.length, unanswerable: negative.length,
      // Ranking denominators include request failures and missing observations.
      hitAt1: rate(hits(1), positive.length), hitAt5: rate(hits(5), positive.length), hitAt10: rate(hits(10), positive.length),
      mrr: positive.length ? positive.reduce((sum, q) => sum + (1 / (goldRank(q, byId.get(q.id)) ?? Infinity)), 0) / positive.length : null,
      // Error responses are not refusals and do not enter these denominators.
      falseRejection: rate(refused, completedPositive.length),
      falseAcceptance: rate(completedNegative.filter(accepted).length, completedNegative.length),
      acceptedWithoutGold: completedPositive.filter((q) => accepted(q) && goldRank(q, byId.get(q.id)) === null).length,
      latencyAllAttempts: latencySummary(selected.flatMap((q) => byId.has(q.id) ? [byId.get(q.id)!.elapsedMs] : [])),
      latencyCompleted: latencySummary(completed.map((q) => byId.get(q.id)!.elapsedMs)),
    };
  };
  const pairs = new Map<string, V1Question[]>();
  for (const q of questions) pairs.set(q.pairId, [...(pairs.get(q.pairId) ?? []), q]);
  const positivePairs = [...pairs.values()].filter((pair) => pair.length === 2 && pair.every((q) => q.answerable));
  const hit = (q: V1Question) => { const rank = goldRank(q, byId.get(q.id)); return rank !== null && rank <= 5; };
  return {
    overall: summarize(questions),
    byLanguage: { en: summarize(questions.filter((q) => q.language === 'en')), fr: summarize(questions.filter((q) => q.language === 'fr')) },
    bySplit: { calibration: summarize(questions.filter((q) => q.split === 'calibration')), holdout: summarize(questions.filter((q) => q.split === 'holdout')) },
    paired: {
      answerablePairs: positivePairs.length,
      bothHitAt5: rate(positivePairs.filter((pair) => pair.every(hit)).length, positivePairs.length),
      onlyEnglishHitAt5: positivePairs.filter((pair) => pair.some((q) => q.language === 'en' && hit(q)) && pair.some((q) => q.language === 'fr' && !hit(q))).length,
      onlyFrenchHitAt5: positivePairs.filter((pair) => pair.some((q) => q.language === 'fr' && hit(q)) && pair.some((q) => q.language === 'en' && !hit(q))).length,
    },
  };
}

export interface ScoreObservation { id: string; bestScore: number }
export interface ScoreProvenance { backend: Backend; corpusRevision: string; parserVersion: string; encoderModel: string; scorePolicyId: string }
/** Calibrate only on raw pre-refusal scores; a serving response that already
 * passed a floor cannot reveal the score distribution below that floor. */
export function calibrateThreshold(questions: V1Question[], scores: ScoreObservation[], provenance: ScoreProvenance) {
  if (!provenance.corpusRevision || !provenance.parserVersion || !provenance.encoderModel || !provenance.scorePolicyId) throw new Error('Complete score provenance is required');
  const calibration = questions.filter((q) => q.split === 'calibration' && q.status !== 'unverified');
  if (scores.some((s) => questions.some((q) => q.id === s.id && q.split === 'holdout'))) throw new Error('Holdout scores cannot select a threshold');
  const byId = new Map<string, number>();
  for (const score of scores) {
    if (!calibration.some((q) => q.id === score.id) || !Number.isFinite(score.bestScore) || byId.has(score.id)) throw new Error(`Invalid calibration score: ${score.id}`);
    byId.set(score.id, score.bestScore);
  }
  if (calibration.some((q) => !byId.has(q.id))) throw new Error('Calibration scores are incomplete');
  if (!calibration.some((q) => q.answerable) || !calibration.some((q) => !q.answerable)) throw new Error('Both answerability classes are required');
  if (calibration.some((q) => q.answerable && q.provenance.revision !== provenance.corpusRevision)) throw new Error('Score/source revision mismatch');
  const values = [...byId.values()];
  const thresholds = [...new Set([...values, ...values.map((s) => s + Math.max(Math.abs(s), 1) * Number.EPSILON)])].sort((a, b) => a - b);
  const sweep = thresholds.map((threshold) => {
    const positive = calibration.filter((q) => q.answerable);
    const negative = calibration.filter((q) => !q.answerable);
    return { threshold, falseAcceptance: rate(negative.filter((q) => byId.get(q.id)! >= threshold).length, negative.length), falseRejection: rate(positive.filter((q) => byId.get(q.id)! < threshold).length, positive.length) };
  });
  const selected = [...sweep].sort((a, b) => a.falseAcceptance.numerator - b.falseAcceptance.numerator || a.falseRejection.numerator - b.falseRejection.numerator || a.threshold - b.threshold)[0]!;
  return { provenance, rule: 'minimize calibration false accepts, then false rejects, then threshold; candidate only, never applied automatically', selected, sweep };
}
