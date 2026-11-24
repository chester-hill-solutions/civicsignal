import { authenticateRequest, AccessError } from './access';
import { runBillableChat, runBillableRetrieval, BillableDenied } from './metering';
import { billableDenialResponse } from '@chester-hill-solutions/api-billing';
import { buildBrief, type BriefRequest } from './routes/brief';
import { CORPUSES_BY_ID, assertV1StatuteQuery, loadD1CorpusPublication, UnsupportedCoverageError, type D1CorpusPublication } from './corpora/registry';
import { emitCorpusItem, parseCitation } from '@chester-hill-solutions/corpus';
import { policyFor } from './corpora/policies';
import { capabilitiesResponse, deploymentCapabilities, llmsTxt } from './routes/capabilities';
import { agentLandingResponse } from './routes/agent-landing';
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
import { GenerationFailureError } from './byok';
import { hansardDatabase, matchHansardRoute, parseHansardRequest, runHansardRequest } from './routes/hansard';
import { HANSARD_OPENAPI_PATH } from './routes/hansard-contract';
import { hansardOpenApi } from './routes/hansard-openapi';
import { gazetteDatabase, matchGazetteRoute, parseGazetteRequest, runGazetteRequest } from './routes/gazette';
import { GAZETTE_OPENAPI_PATH } from './routes/gazette-contract';
import { BILL_OPENAPI_PATH, prepareBillBrief } from './routes/bill-trace';
import { billTraceOpenApi } from './routes/bill-trace-openapi';
import { COMMITTEE_OPENAPI_PATH, prepareCommitteeStudyBrief } from './routes/committee-study';
import { prepareCommitteeCorpus } from './routes/committee-corpus';
import { committeeStudyOpenApi } from './routes/committee-study-openapi';
import { gazetteOpenApi } from './routes/gazette-openapi';
import { matchSourceFeed, parseSourceFeedRequest, readSourceFeed } from './routes/source-feed';
import { matchWrittenQuestionRoute, parseWrittenQuestionRequest, runWrittenQuestionRequest, writtenQuestionDatabase } from './routes/written-questions';
import { WRITTEN_QUESTIONS_OPENAPI_PATH } from './routes/written-questions-contract';
import { writtenQuestionOpenApi } from './routes/written-questions-openapi';

import { prepareFunding, FUNDING_OPENAPI_PATH } from './routes/funding';
import { fundingOpenApi } from './routes/funding-openapi';
import { prepareConsultations, CONSULTATIONS_OPENAPI_PATH } from './routes/consultations';
import { consultationsOpenApi } from './routes/consultations-openapi';
import { PARLIAMENT_OPENAPI_PATH, prepareParliamentCatalogue } from './routes/parliament-catalogue';
import { parliamentCatalogueOpenApi } from './routes/parliament-catalogue-openapi';

import { prepareGeds } from './routes/geds';
import { buildGedsOpenApi, GEDS_OPENAPI_PATH } from './geds/openapi';

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
      if (['/', '/health', '/.well-known/civicsignal.json', '/llms.txt', HANSARD_OPENAPI_PATH, GAZETTE_OPENAPI_PATH, BILL_OPENAPI_PATH, COMMITTEE_OPENAPI_PATH, FUNDING_OPENAPI_PATH, CONSULTATIONS_OPENAPI_PATH, PARLIAMENT_OPENAPI_PATH, GEDS_OPENAPI_PATH, WRITTEN_QUESTIONS_OPENAPI_PATH].includes(url.pathname)) {
        requireMethod(request, 'GET');
        return publicGet(url, env, origin, correlationId);
      }
      if (url.pathname === '/mcp') {
        const identity = await authenticateRequest(env, request);
        const publication = await loadD1CorpusPublication(env.CIVIC_DB);
        const handler = createCivicSignalMcpHandler({
          request, env, ctx: corpusContext(env, publication, observe, fresh),
          runRetrieval: (work) => runBillableRetrieval(env, identity, () => readPublishedStatutes(env, publication, work), {
            waitUntil: (task) => ctx.waitUntil(task),
          }),
        });
        return await handler.fetch(request);
      }
      const preview = matchPreview(url);
      const isApi = preview !== undefined || isRetrievalPath(url.pathname);
      if (!isApi && url.pathname !== '/api/chat' && url.pathname !== '/api/match') {
        return errorResponse('NOT_FOUND', `No route for ${url.pathname}`, env, origin, correlationId, 404);
      }
      requireMethod(request, isApi ? 'GET' : 'POST');
      const identity = await authenticateRequest(env, request);
      const waitUntil = (task: Promise<unknown>) => ctx.waitUntil(task);
      if (preview) {
        const work = preview(env);
        const body = await runBillableRetrieval(env, identity, work, { waitUntil });
        return jsonResponse(body, env, origin, correlationId);
      }
      let body: unknown;
      if (url.pathname === '/api/chat') {
        const parsed = parseChatRequest(await readJsonBody(request));
        const byokKey = request.headers.get(BYOK_KEY_HEADER) ?? '';
        const byokProvider = request.headers.get(BYOK_PROVIDER_HEADER) ?? parsed.provider ?? 'anthropic';
        body = await runBillableChat(env, identity, (reserveGeneration) => runChat({
          env, byokKey, byokProvider, reserveGeneration,
          retrieve: (briefRequest) => briefFor(briefRequest, env, observe, fresh),
        }, parsed), { waitUntil });
      } else if (url.pathname === '/api/match') {
        const parsed = parseMatchRequest(await readJsonBody(request));
        if (!env.VECTORIZE) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Vector retrieval is unavailable.', 503);
        const index = new VectorizeIndex(env.VECTORIZE);
        const matches = await runBillableRetrieval(env, identity,
          async () => readPublishedStatutes(env, await loadD1CorpusPublication(env.CIVIC_DB),
            () => index.query(parsed.vector, parsed.topK ?? 10)), { waitUntil });
        body = { matches, count: matches.length, corpus: parsed.corpus ?? 'statutes-canada' };
      } else if (url.pathname === '/api/changes') {
        const query = parseChangesQuery(url);
        body = await runBillableRetrieval(env, identity, async () => {
          const publication = await loadD1CorpusPublication(env.CIVIC_DB);
          return readPublishedStatutes(env, publication, () => readStatuteChanges(query, corpusContext(env, publication)));
        }, { waitUntil });
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
      return errorResponse('UPSTREAM_UNAVAILABLE', 'The request could not complete. Retry later.', env, origin, correlationId, 502, retrieval,
        error instanceof GenerationFailureError ? error : undefined);
    }
  },
};

function requireMethod(request: Request, expected: string): void {
  if (request.method !== expected) throw new AccessError('METHOD_NOT_ALLOWED', `Use ${expected} for this route.`, 405);
}

function isRetrievalPath(path: string): boolean {
  return ['/api/brief', '/api/news', '/api/changes'].includes(path) || Object.hasOwn(CORPUS_ROUTES, path);
}

function matchPreview(url: URL): ((env: Env) => () => Promise<unknown>) | undefined {
  const brief = prepareFunding(url) ?? prepareConsultations(url) ?? prepareGeds(url) ?? prepareParliamentCatalogue(url) ?? prepareBillBrief(url) ?? prepareCommitteeStudyBrief(url) ?? prepareCommitteeCorpus(url);
  if (brief) return brief;
  const source = matchSourceFeed(url.pathname);
  if (source) return (env) => {
    const db = source === 'gazette' ? gazetteDatabase(env) : hansardDatabase(env);
    const query = parseSourceFeedRequest(source, url);
    return () => readSourceFeed(db, { source, query });
  };
  const writtenQuestion = matchWrittenQuestionRoute(url.pathname);
  if (writtenQuestion) return (env) => {
    const db = writtenQuestionDatabase(env);
    const request = parseWrittenQuestionRequest(writtenQuestion, url);
    return () => runWrittenQuestionRequest(db, request);
  };
  const hansard = matchHansardRoute(url.pathname);
  if (hansard) return (env) => {
    const db = hansardDatabase(env);
    const request = parseHansardRequest(hansard, url);
    return () => runHansardRequest(db, request);
  };
  const gazette = matchGazetteRoute(url.pathname);
  if (gazette) return (env) => {
    const db = gazetteDatabase(env);
    const request = parseGazetteRequest(gazette, url);
    return () => runGazetteRequest(db, request);
  };
  return undefined;
}

async function publicGet(url: URL, env: Env, origin: string | null, correlationId: string): Promise<Response> {
  switch (url.pathname) {
    case '/': return agentLandingResponse(correlationId, await deploymentCapabilities(env, url.origin));
    case '/health': return jsonResponse({ ok: true, product: env.PRODUCT_NAME ?? 'CivicSignal' }, env, origin, correlationId);
    case '/.well-known/civicsignal.json': return capabilitiesResponse(env, url.origin, correlationId);
    case GEDS_OPENAPI_PATH: return jsonResponse(buildGedsOpenApi(url.origin, env.PRODUCT_NAME), env, origin, correlationId);
    case FUNDING_OPENAPI_PATH: return jsonResponse(fundingOpenApi(), env, origin, correlationId);
    case CONSULTATIONS_OPENAPI_PATH: return jsonResponse(consultationsOpenApi(), env, origin, correlationId);
    case PARLIAMENT_OPENAPI_PATH: return jsonResponse(parliamentCatalogueOpenApi(), env, origin, correlationId);
    case BILL_OPENAPI_PATH: return jsonResponse(billTraceOpenApi(), env, origin, correlationId);
    case COMMITTEE_OPENAPI_PATH: return jsonResponse(committeeStudyOpenApi(), env, origin, correlationId);
    case HANSARD_OPENAPI_PATH: return jsonResponse(hansardOpenApi(), env, origin, correlationId);
    case GAZETTE_OPENAPI_PATH: return jsonResponse(gazetteOpenApi(), env, origin, correlationId);
    case WRITTEN_QUESTIONS_OPENAPI_PATH: return jsonResponse(writtenQuestionOpenApi(), env, origin, correlationId);
    default: return new Response(llmsTxt(await deploymentCapabilities(env, url.origin)), {
      headers: { 'content-type': 'text/plain; charset=UTF-8', ...corsHeaders(env, origin, correlationId) },
    });
  }
}

function corpusContext(env: Env, publication: D1CorpusPublication, onRetrieval?: (observation: RetrievalObservation) => void, fresh = false): CorpusContext {
  const embedQuery = queryEmbedderFor(env);
  const textMode = parseCorpusTextMode(env.CORPUS_TEXT_MODE);
  if (textMode !== 'd1' && (!env.CIVIC_DB || !env.CORPORA)) {
    throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Verified provision text storage is unavailable.', 503);
  }
  const statutes = publication.availability['statutes-canada'];
  const cacheKey = (key: string) => `${key}:generation:${publication.generation}`;
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
    ...(env.HYBRID_SEARCH === 'on' ? { hybrid: { key: env.SEARCH_ZEN_KEY, bucket: env.CORPORA } } : {}),
    corpusAvailability: publication.availability,
    corpusRevision: statutes?.available ? `${statutes.revision}:${statutes.parserVersion}` : 'unknown',
    ...(env.CIVIC_CACHE ? { cache: {
      get: (key: string) => env.CIVIC_CACHE!.get(cacheKey(key), 'json'),
      put: async (key: string, value: unknown, ttlSeconds: number) => {
        await checkPublication(env, publication);
        await env.CIVIC_CACHE!.put(cacheKey(key), JSON.stringify(value), { expirationTtl: ttlSeconds });
      },
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
  if (!query.topic && !query.keywords?.length && !query.citation && !(query.act && query.section)) {
    throw new RequestInputError('Supply a topic, keywords or an exact act and section.');
  }
  const publication = await loadD1CorpusPublication(env.CIVIC_DB);
  return readPublishedStatutes(env, publication, async () => {
    const context = corpusContext(env, publication, onRetrieval, fresh);
    let citation = query.citation ?? (query.act && query.section ? { act: query.act, section: query.section } : undefined);
    if (!citation && query.topic) {
      const titles = await loadActTitles(env, `${context.corpusRevision}:${publication.generation}`);
      if (titles.length) citation = parseCitation(query.topic, titles)?.citation;
    }
    if (!citation && (query.topic || query.keywords?.length) && (!context.vector || !context.embedQuery)) {
      throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Semantic retrieval is unavailable.', 503);
    }
    return buildBrief({ ...query, citation }, context);
  });
}

async function runQuery(pathname: string, query: CorpusQuery, env: Env, onRetrieval?: (observation: RetrievalObservation) => void, fresh = false): Promise<unknown> {
  if (pathname === '/api/brief') return briefFor(query, env, onRetrieval, fresh);
  if (pathname === '/api/news') {
    throw new UnsupportedCoverageError('News retrieval is unavailable in v1.');
  }
  const corpus = CORPUSES_BY_ID.get(CORPUS_ROUTES[pathname]!);
  if (!corpus) throw new AccessError('UNSUPPORTED_COVERAGE', 'The requested corpus is unavailable.', 501);
  assertV1StatuteQuery(query);
  if (!corpus.supports(query)) throw new RequestInputError('Supply a topic, keywords or an exact act and section.');
  const publication = await loadD1CorpusPublication(env.CIVIC_DB);
  return readPublishedStatutes(env, publication, async () => {
    const context = corpusContext(env, publication, onRetrieval, fresh);
    if (!query.act && (!context.vector || !context.embedQuery)) {
      throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Semantic retrieval is unavailable.', 503);
    }
    const raw = await corpus.retrieve(query, context);
    const policy = policyFor(corpus.id);
    return { items: policy ? raw.map((item) => emitCorpusItem(policy, item)) : [], attribution: policy?.attribution ?? '' };
  });
}

async function readPublishedStatutes<T>(env: Env, publication: D1CorpusPublication, read: () => Promise<T>): Promise<T> {
  const pinned = publication.availability['statutes-canada'];
  if (!pinned?.available) {
    throw new AccessError('RETRIEVAL_UNAVAILABLE', pinned?.reason ?? 'The published statute corpus is unavailable.', 503);
  }
  const result = await read();
  await checkPublication(env, publication);
  return result;
}

async function checkPublication(env: Env, publication: D1CorpusPublication): Promise<void> {
  const pinned = publication.availability['statutes-canada'];
  const checked = await loadD1CorpusPublication(env.CIVIC_DB);
  const current = checked.availability['statutes-canada'];
  if (!pinned?.available || !current?.available || checked.generation !== publication.generation ||
    current.revision !== pinned.revision || current.parserVersion !== pinned.parserVersion) {
    throw new AccessError('RETRIEVAL_UNAVAILABLE', 'The corpus changed during this request. Retry later.', 503);
  }
}
