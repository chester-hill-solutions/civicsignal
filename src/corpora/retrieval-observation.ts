import { z } from 'zod';
import { ENCODER_CONTRACT } from '../encoder';
import type { CorpusContext, CorpusQuery } from './types';

const providerStatus = z.enum(['not-called', 'ok', 'error', 'disabled']);
/** Public, bounded metadata only. No question, candidate text, key or exception. */
export const retrievalObservationSchema = z.object({
  version: z.literal(1), corpusId: z.literal('statutes-canada'),
  backend: z.enum(['vectorize', 'postgres-cosine']), revision: z.string().max(64).nullable(), parserVersion: z.string().max(120).nullable(),
  policy: z.string().max(120), encoderModel: z.string().max(120),
  mode: z.enum(['exact', 'rerank', 'vector-floor', 'unavailable']),
  decision: z.enum(['answer', 'web', 'refuse', 'error', 'unavailable']),
  languageFilter: z.string().max(16).nullable(), preRefusalTopScore: z.number().finite().nullable(),
  scoreSource: z.enum(['computed', 'cached', 'none']), scoredAt: z.string().datetime().nullable(),
  vectorFloor: z.number().finite().nullable(), candidateCount: z.number().int().nonnegative(), resultCount: z.number().int().nonnegative(),
  cache: z.enum(['disabled', 'miss', 'hit', 'stale', 'bypass']), fallback: z.boolean(),
  providers: z.object({ encoder: providerStatus, vector: providerStatus, reranker: providerStatus, rows: providerStatus }),
  elapsedMs: z.number().finite().nonnegative(),
});
export type RetrievalObservation = z.infer<typeof retrievalObservationSchema>;
export type RetrievalBackend = RetrievalObservation['backend'];
export const RETRIEVAL_POLICY_VERSION = 'federal-authority-v3-observed';

export async function retrievalTrace(ctx: CorpusContext, query: CorpusQuery, backend: RetrievalBackend,
  mode: RetrievalObservation['mode'], floor: number | null) {
  const started = performance.now();
  const revision = await Promise.resolve(ctx.corpusRevision).catch(() => undefined);
  const revisionKey = revision && revision !== 'unknown' ? revision : null;
  const separator = revisionKey?.indexOf(':') ?? -1;
  const observation: RetrievalObservation = {
    version: 1, corpusId: 'statutes-canada', backend,
    revision: separator >= 0 ? revisionKey!.slice(0, separator) : revisionKey,
    parserVersion: separator >= 0 ? revisionKey!.slice(separator + 1) : null,
    policy: `${backend}:${RETRIEVAL_POLICY_VERSION}`, encoderModel: ENCODER_CONTRACT.model,
    mode, decision: 'unavailable', languageFilter: query.language?.toLowerCase() ?? null,
    preRefusalTopScore: null, scoreSource: 'none', scoredAt: null,
    vectorFloor: floor, candidateCount: 0, resultCount: 0,
    cache: mode === 'exact' || ctx.retrievalCacheMode === 'bypass' ? 'bypass' : ctx.cache ? 'miss' : 'disabled', fallback: false,
    providers: { encoder: 'not-called', vector: 'not-called', reranker: ctx.jev?.key ? 'not-called' : 'disabled', rows: 'not-called' }, elapsedMs: 0,
  };
  return {
    revisionKey,
    observation,
    async provider<T>(name: keyof RetrievalObservation['providers'], work: () => Promise<T>): Promise<T> {
      try { const value = await work(); observation.providers[name] = 'ok'; return value; }
      catch (error) { observation.providers[name] = 'error'; throw error; }
    },
    cached(origin: unknown) {
      observation.cache = 'hit';
      const parsed = retrievalObservationSchema.safeParse(origin);
      if (parsed.success && parsed.data.revision === observation.revision && parsed.data.backend === backend &&
          parsed.data.parserVersion === observation.parserVersion &&
          parsed.data.policy === observation.policy && parsed.data.languageFilter === observation.languageFilter &&
          parsed.data.encoderModel === observation.encoderModel) {
        observation.mode = parsed.data.mode;
        observation.preRefusalTopScore = parsed.data.preRefusalTopScore;
        observation.scoreSource = parsed.data.preRefusalTopScore === null ? 'none' : 'cached';
        observation.scoredAt = parsed.data.scoredAt;
        observation.candidateCount = parsed.data.candidateCount;
        observation.fallback = parsed.data.fallback;
      }
    },
    result<T extends unknown[]>(items: T, decision: RetrievalObservation['decision'] = items.length ? 'answer' : 'refuse'): T {
      observation.decision = decision;
      observation.resultCount = items.length;
      return items;
    },
    emit() {
      observation.elapsedMs = performance.now() - started;
      // An optional diagnostics consumer must not change billing or retrieval.
      try { ctx.onRetrieval?.(retrievalObservationSchema.parse(observation)); }
      catch { console.error(JSON.stringify({ event: 'retrieval_observer_failed' })); }
    },
  };
}

/** Isolate observations per HTTP request or MCP tool invocation, even when a
 * context is reused. Consumers receive only metadata produced by the adapter. */
export function observeRetrievalContext(context: CorpusContext) {
  const retrieval: RetrievalObservation[] = [];
  const ctx: CorpusContext = { ...context, onRetrieval: (observation) => {
    retrieval.push(observation);
    context.onRetrieval?.(observation);
  } };
  return { ctx, retrieval };
}
