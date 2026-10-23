import { authenticateRequest, AccessError } from './access';
import { runBillableRetrieval, BillableDenied } from './metering';
import { billableDenialResponse } from '@chester-hill-solutions/api-billing';
import { buildBrief, type BriefRequest } from './routes/brief';
import { CORPUS_ID } from './ingest/corpus-rows';
import { CORPUSES_BY_ID, assertV1StatuteQuery, loadCorpusAvailability, UnsupportedCoverageError } from './corpora/registry';
import { emitCorpusItem, parseCitation } from '@chester-hill-solutions/corpus';
import { policyFor } from './corpora/policies';
import { capabilitiesResponse, llmsTxt } from './routes/capabilities';
import { createCivicSignalMcpHandler } from './mcp/server';
import { corsHeaders, errorResponse, jsonResponse, newCorrelationId, readJsonBody, RequestInputError } from './http';
import type { Env } from './types';
import { ScopeParseError } from './corpora/scope';
import { parseQuery } from './routes/query';
import { BYOK_KEY_HEADER, BYOK_PROVIDER_HEADER, parseChatRequest, parseMatchRequest, runChat } from './routes/chat';
import { VectorizeIndex } from './vector-index';
import { loadActTitles } from './corpora/act-titles';
import { ENCODER_CONTRACT } from './encoder';
import type { CorpusContext, CorpusQuery } from './corpora/types';
import { parseChangesQuery, readStatuteChanges } from './routes/changes';
import type { RetrievalObservation } from './corpora/retrieval-observation';
import { createR2ProvisionTextStore, parseCorpusTextMode } from './corpora/text-store';

export { ApiKeyUsageDO } from '@chester-hill-solutions/api-billing/durable-object';

const CORPUS_ROUTES: Record<string, string> = {
  '/api/statutes': 'statutes-canada',
  '/api/debates': 'hansard-federal',
  '/api/bills': 'bills-canada',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const correlationId = newCorrelationId();
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const retrieval: RetrievalObservation[] = [];
    const observe = (observation: RetrievalObservation) => { retrieval.push(observation); };
    const fresh = request.headers.get('X-CivicSignal-Evaluation') === 'fresh';
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, origin, correlationId) });
    }
    try {
      if (['/health', '/.well-known/civicsignal.json', '/llms.txt'].includes(url.pathname)) {
        requireMethod(request, 'GET');
        if (url.pathname === '/health') return jsonResponse({ ok: true, product: env.PRODUCT_NAME ?? 'CivicSignal' }, env, origin, correlationId);
        if (url.pathname === '/.well-known/civicsignal.json') return capabilitiesResponse(env, url.origin, correlationId);
        return new Response(llmsTxt(env, url.origin), {
          headers: { 'content-type': 'text/plain; charset=UTF-8', ...corsHeaders(env, origin, correlationId) },
        });
      }
      if (url.pathname === '/mcp') {
        const identity = await authenticateRequest(env, request);
        const handler = createCivicSignalMcpHandler({
          request, env, ctx: corpusContext(env, observe, fresh),
          runRetrieval: (work) => runBillableRetrieval(env, identity, work, {
            waitUntil: (task) => ctx.waitUntil(task),
          }),
        });
        return await handler.fetch(request);
      }
      const isApi = url.pathname === '/api/brief' || url.pathname === '/api/news' || url.pathname === '/api/changes' || Object.hasOwn(CORPUS_ROUTES, url.pathname);
      if (!isApi && url.pathname !== '/api/chat' && url.pathname !== '/api/match') {
        return errorResponse('NOT_FOUND', `No route for ${url.pathname}`, env, origin, correlationId, 404);
      }
      requireMethod(request, isApi ? 'GET' : 'POST');
      const identity = await authenticateRequest(env, request);
      const waitUntil = (task: Promise<unknown>) => ctx.waitUntil(task);
      let body: unknown;
      if (url.pathname === '/api/chat') {
        const parsed = parseChatRequest(await readJsonBody(request));
        const byokKey = request.headers.get(BYOK_KEY_HEADER) ?? '';
        const byokProvider = request.headers.get(BYOK_PROVIDER_HEADER) ?? parsed.provider ?? 'anthropic';
        body = await runBillableRetrieval(env, identity, () => runChat({
          env, byokKey, byokProvider,
          retrieve: (briefRequest) => briefFor(briefRequest, env, observe, fresh),
        }, parsed), { waitUntil });
      } else if (url.pathname === '/api/match') {
        const parsed = parseMatchRequest(await readJsonBody(request));
        if (!env.VECTORIZE) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Vector retrieval is unavailable.', 503);
        await requirePublishedStatutes(corpusContext(env));
        const index = new VectorizeIndex(env.VECTORIZE);
        const matches = await runBillableRetrieval(env, identity,
          () => index.query(parsed.vector, parsed.topK ?? 10), { waitUntil });
        body = { matches, count: matches.length, corpus: parsed.corpus ?? 'statutes-canada' };
      } else if (url.pathname === '/api/changes') {
        const query = parseChangesQuery(url);
        const context = corpusContext(env);
        await requirePublishedStatutes(context);
        body = await runBillableRetrieval(env, identity, () => readStatuteChanges(query, context), { waitUntil });
      } else {
        const query = parseQuery(url);
        body = await runBillableRetrieval(env, identity, () => runQuery(url.pathname, query, env, observe, fresh), { waitUntil });
      }
      return jsonResponse({ ...(body as Record<string, unknown>), retrieval }, env, origin, correlationId);
    } catch (error: unknown) {
      if (error instanceof BillableDenied) {
        return billableDenialResponse({ ...error.outcome, body: { ...error.outcome.body, retrieval } }, correlationId, corsHeaders(env, origin, correlationId));
      }
      if (error instanceof AccessError || error instanceof UnsupportedCoverageError) {
        const response = errorResponse(error.code, error.message, env, origin, correlationId, error.status, retrieval);
        if (error.status === 401) response.headers.set('WWW-Authenticate', 'Bearer realm="CivicSignal"');
        return response;
      }
      if (error instanceof RequestInputError || error instanceof ScopeParseError) {
        return errorResponse('INVALID_ARGUMENT', error.message, env, origin, correlationId,
          error instanceof RequestInputError ? error.status : 400, retrieval);
      }
      console.error(JSON.stringify({ correlationId, event: 'request_failed', route: url.pathname,
        errorType: error instanceof Error ? error.name : 'unknown' }));
      return errorResponse('UPSTREAM_UNAVAILABLE', 'The request could not complete. Retry later.', env, origin, correlationId, 502, retrieval);
    }
  },
};

function requireMethod(request: Request, expected: string): void {
  if (request.method !== expected) throw new AccessError('METHOD_NOT_ALLOWED', `Use ${expected} for this route.`, 405);
}

function corpusContext(env: Env, onRetrieval?: (observation: RetrievalObservation) => void, fresh = false): CorpusContext {
  const embedQuery = queryEmbedderFor(env);
  const textMode = parseCorpusTextMode(env.CORPUS_TEXT_MODE);
  if (textMode !== 'd1' && (!env.CIVIC_DB || !env.CORPORA)) {
    throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Verified provision text storage is unavailable.', 503);
  }
  return {
    db: env.CIVIC_DB,
    fetch,
    now: () => new Date(),
    onRetrieval,
    ...(fresh ? { retrievalCacheMode: 'bypass' as const } : {}),
    ...(textMode !== 'd1' ? { provisionTexts: createR2ProvisionTextStore(env.CIVIC_DB!, env.CORPORA!, textMode) } : {}),
    ...(env.VECTORIZE ? { vector: new VectorizeIndex(env.VECTORIZE) } : {}),
    ...(embedQuery ? { embedQuery } : {}),
    ...(env.JEV_KEY ? { jev: { key: env.JEV_KEY } } : {}),
    // Read the revision within this request. A global promise can belong to a
    // different binding or request, and can preserve an obsolete revision.
    corpusRevision: env.CIVIC_DB
      ? env.CIVIC_DB.prepare('SELECT commit_sha, parser_version FROM corpus_state WHERE corpus_id = ?').bind(CORPUS_ID)
          .first<{ commit_sha: string; parser_version: string | null }>()
          .then((row) => row ? `${row.commit_sha}:${row.parser_version ?? 'legacy'}` : 'unknown').catch(() => 'unknown')
      : Promise.resolve('unknown'),
    ...(env.CIVIC_CACHE ? { cache: {
      get: (key: string) => env.CIVIC_CACHE!.get(key, 'json'),
      put: (key: string, value: unknown, ttlSeconds: number) => env.CIVIC_CACHE!.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds }),
    } } : {}),
  };
}

function queryEmbedderFor(env: Env): ((text: string) => Promise<number[]>) | undefined {
  const encoderUrl = env.ENCODER_URL;
  const encoderToken = env.ENCODER_TOKEN;
  if (!encoderToken || (!env.ENCODER_SERVICE && !encoderUrl)) return undefined;
  return async (text: string) => {
    const request = new Request(encoderUrl ? `${encoderUrl.replace(/\/$/, '')}/embed-query` : 'https://encoder/embed-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${encoderToken}` },
      body: JSON.stringify({ texts: [text] }),
      signal: AbortSignal.timeout(60_000),
    });
    const response = env.ENCODER_SERVICE ? await env.ENCODER_SERVICE.fetch(request) : await fetch(request);
    if (!response.ok) throw new Error('The encoder refused the request.');
    const body = (await response.json()) as { vectors?: unknown[] };
    const vector = body.vectors?.[0];
    if (!Array.isArray(vector) || vector.length !== ENCODER_CONTRACT.dimensions ||
      !vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error('The encoder returned an invalid vector.');
    }
    return vector as number[];
  };
}

async function briefFor(query: BriefRequest, env: Env, onRetrieval?: (observation: RetrievalObservation) => void, fresh = false) {
  assertV1StatuteQuery(query);
  const context = corpusContext(env, onRetrieval, fresh);
  await requirePublishedStatutes(context);
  if (!query.topic && !query.keywords?.length && !query.citation && !(query.act && query.section)) {
    throw new RequestInputError('Supply a topic, keywords or an exact act and section.');
  }
  const titles = await loadActTitles(env);
  const citation = query.citation ?? (query.act && query.section ? { act: query.act, section: query.section } : undefined)
    ?? (query.topic && titles.length ? parseCitation(query.topic, titles)?.citation : undefined);
  if (!citation && (query.topic || query.keywords?.length) && (!context.vector || !context.embedQuery)) {
    throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Semantic retrieval is unavailable.', 503);
  }
  return buildBrief({ ...query, citation }, context);
}

async function runQuery(pathname: string, query: CorpusQuery, env: Env, onRetrieval?: (observation: RetrievalObservation) => void, fresh = false): Promise<unknown> {
  if (pathname === '/api/brief') return briefFor(query, env, onRetrieval, fresh);
  if (pathname === '/api/news') {
    throw new UnsupportedCoverageError('News retrieval is unavailable in v1.');
  }
  const corpus = CORPUSES_BY_ID.get(CORPUS_ROUTES[pathname]!);
  if (!corpus) throw new AccessError('UNSUPPORTED_COVERAGE', 'The requested corpus is unavailable.', 501);
  const context = corpusContext(env, onRetrieval, fresh);
  assertV1StatuteQuery(query);
  await requirePublishedStatutes(context);
  if (!corpus.supports(query)) throw new RequestInputError('Supply a topic, keywords or an exact act and section.');
  if (corpus.id === 'statutes-canada' && !query.act && (!context.vector || !context.embedQuery)) {
    throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Semantic retrieval is unavailable.', 503);
  }
  const raw = await corpus.retrieve(query, context);
  const policy = policyFor(corpus.id);
  return { items: policy ? raw.map((item) => emitCorpusItem(policy, item)) : [], attribution: policy?.attribution ?? '' };
}

async function requirePublishedStatutes(context: CorpusContext): Promise<void> {
  const availability = await loadCorpusAvailability(context);
  if (!availability['statutes-canada']?.available) {
    throw new AccessError('RETRIEVAL_UNAVAILABLE', 'No non-empty statute revision is available.', 503);
  }
}
