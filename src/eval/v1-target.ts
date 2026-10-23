import { z } from 'zod';
import type { V1Observation, V1Question } from './v1';
import { retrievalObservationSchema } from '../corpora/retrieval-observation';

export const targetProvenanceSchema = z.object({
  backend: z.enum(['vectorize', 'postgres', 'local-fixture']),
  environment: z.enum(['production', 'staging', 'local-fixture']),
  deployment: z.string().min(1), corpusRevision: z.string().regex(/^[a-f0-9]{40}$/),
  parserVersion: z.string().min(1),
  corpusAsOf: z.union([z.string().datetime(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).refine((value) => Number.isFinite(Date.parse(value)), 'Invalid corpus date'), corpusLastRunAt: z.string().datetime(),
  upstream: z.object({ revision: z.string().regex(/^[a-f0-9]{40}$/), committedAt: z.string().datetime(), observedAt: z.string().datetime() }),
  encoderModel: z.string().min(1), encoderArtifact: z.string().min(1), encoderDimensions: z.number().int().positive(),
  retrievalPolicy: z.string().min(1), reranker: z.string().min(1),
  evidence: z.object({ source: z.string().min(1), observedAt: z.string().datetime(), note: z.string().min(1) }),
});
export type TargetProvenance = z.infer<typeof targetProvenanceSchema>;

export interface HttpTarget { baseUrl: string; route: '/api/statutes' | '/api/brief'; key?: string; timeoutMs: number; limit: number; fresh?: boolean }
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Declare a balanced load rather than timing only the first positive cases. */
export function balancedSchedule(questions: V1Question[], count: number): V1Question[] {
  const buckets = [true, false].flatMap((answerable) => ['en', 'fr'].map((language) => questions.filter((q) => q.answerable === answerable && q.language === language)));
  if (buckets.some((bucket) => bucket.length === 0)) throw new Error('Benchmark needs both languages and answerability classes');
  return Array.from({ length: count }, (_, at) => buckets[at % buckets.length]![Math.floor(at / buckets.length) % buckets[at % buckets.length]!.length]!);
}

export async function requestRetrieval(target: HttpTarget, question: V1Question): Promise<V1Observation> {
  const started = performance.now();
  const base = { id: question.id, items: [], elapsedMs: 0 };
  const url = new URL(target.route, target.baseUrl);
  url.searchParams.set('topic', question.question);
  url.searchParams.set('language', question.language);
  url.searchParams.set('limit', String(target.limit));
  // No cache-busting question edits: that changes the legal query being scored.
  try {
    const response = await fetch(url, {
      headers: { ...(target.key ? { authorization: `Bearer ${target.key}` } : {}), ...(target.fresh ? { 'x-civicsignal-evaluation': 'fresh' } : {}) },
      signal: AbortSignal.timeout(target.timeoutMs), redirect: 'error',
    });
    const correlationId = response.headers.get('x-correlation-id') ?? undefined;
    let body: unknown;
    try { body = await response.json(); } catch { return { ...base, correlationId, elapsedMs: performance.now() - started, status: response.status, outcome: response.ok ? 'invalid-response' : 'http-error', errorCode: 'NON_JSON_RESPONSE' }; }
    const parsed = isObject(body) && body.retrieval !== undefined ? z.array(retrievalObservationSchema).max(8).safeParse(body.retrieval) : null;
    if (!response.ok) return { ...base, correlationId, retrieval: parsed?.success ? parsed.data : undefined, elapsedMs: performance.now() - started, status: response.status, outcome: 'http-error', errorCode: isObject(body) && typeof body.code === 'string' ? body.code : `HTTP_${response.status}` };
    const raw = isObject(body) ? body[target.route === '/api/brief' ? 'legislation' : 'items'] : undefined;
    if (!Array.isArray(raw) || raw.some((item) => !isObject(item) || typeof item.id !== 'string' || (item.language !== undefined && typeof item.language !== 'string'))) {
      return { ...base, correlationId, elapsedMs: performance.now() - started, status: response.status, outcome: 'invalid-response', errorCode: 'INVALID_RETRIEVAL_SHAPE' };
    }
    const items = raw.map((item: { id: string; language?: string }) => ({ id: item.id, language: item.language }));
    if (parsed && !parsed.success) return { ...base, correlationId, elapsedMs: performance.now() - started, status: response.status, outcome: 'invalid-response', errorCode: 'INVALID_RETRIEVAL_OBSERVATION' };
    return { id: question.id, items, correlationId, retrieval: parsed?.data, elapsedMs: performance.now() - started, status: response.status, outcome: 'ok' };
  } catch (error) {
    // Report exception type only. Never serialize Request/headers/credentials.
    return { ...base, elapsedMs: performance.now() - started, outcome: 'transport-error', errorCode: error instanceof Error ? error.name : 'TRANSPORT_ERROR' };
  }
}

export async function collectObservations<T>(jobs: T[], concurrency: number, request: (job: T) => Promise<V1Observation>) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Concurrency must be an integer from 1 to 32');
  const observations: V1Observation[] = new Array(jobs.length);
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (;;) {
      const position = next++;
      if (position >= jobs.length) return;
      observations[position] = await request(jobs[position]!);
    }
  }));
  const elapsedMs = performance.now() - started;
  return { observations, elapsedMs, attemptedRequestsPerSecond: jobs.length ? jobs.length / (elapsedMs / 1000) : null, completedRequestsPerSecond: jobs.length ? observations.filter((o) => o.outcome === 'ok').length / (elapsedMs / 1000) : null };
}

export function corpusFreshness(provenance: TargetProvenance, measuredAt: Date) {
  return {
    evidenceSource: 'operator-supplied metadata; not inferred from HTTP 200 or latency',
    sameRevisionAsObservedUpstream: provenance.corpusRevision === provenance.upstream.revision,
    corpusAgeHours: (measuredAt.getTime() - Date.parse(provenance.corpusAsOf)) / 3_600_000,
    lastRunAgeHours: (measuredAt.getTime() - Date.parse(provenance.corpusLastRunAt)) / 3_600_000,
    upstreamObservationAgeHours: (measuredAt.getTime() - Date.parse(provenance.upstream.observedAt)) / 3_600_000,
    // Newer upstream with older served corpus gives a lower bound, not a
    // measured ingest delay: the deployment has not caught up yet.
    pendingRevisionAgeHours: provenance.corpusRevision === provenance.upstream.revision ? null : (measuredAt.getTime() - Date.parse(provenance.upstream.committedAt)) / 3_600_000,
  };
}
