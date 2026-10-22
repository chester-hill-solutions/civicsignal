import { authorizeServerKey, httpStatusForKeyDenial } from "./spine/api-keys";
import { billableDenialResponse, recordSuccessfulBillable, type BillableAuthContext } from './spine/billing';
import { buildBrief, type BriefRequest } from './routes/brief';
import { CORPUSES_BY_ID } from './corpora/registry';
import { emitCorpusItem } from "@chester-hill-solutions/corpus";
import { policyFor } from './corpora/policies';
import { capabilitiesResponse, llmsTxt } from './routes/capabilities';
import { createCivicSignalMcpHandler } from './mcp/server';
import { corsHeaders, errorResponse, jsonResponse, newCorrelationId } from './http';
import type { Env } from './types';
import { parseScope, ScopeParseError } from './corpora/scope';
import { parseQuery } from './routes/query';
import {
  BYOK_KEY_HEADER,
  BYOK_PROVIDER_HEADER,
  chatErrorResponse,
  parseChatRequest,
  parseMatchRequest,
  runChat,
} from './routes/chat';
import { VectorizeIndex, type VectorIndex, type VectorizeBinding } from './vector-index';
import { loadActTitles } from './corpora/act-titles';
import { parseCitation } from '@chester-hill-solutions/corpus';
import type { CorpusContext, CorpusQuery } from './corpora/types';

/**
 * The worker entry.
 *
 * One shape for every route: authenticate the key, run the query, and only then
 * record a billable unit. A request that fails is never billed; a request that
 * succeeds is billed exactly once.
 */

const CORPUS_ROUTES: Record<string, string> = {
  '/api/statutes': 'statutes-canada',
  '/api/debates': 'hansard-federal',
  '/api/bills': 'bills-canada',
};

/**
 * The usage counter, as a Durable Object.
 *
 * It has to be a Durable Object rather than a key-value store, because the
 * counter has to be exact. KV is eventually consistent and rate-limits writes
 * to about one a second per key, so under real traffic a KV counter would both
 * undercount and throttle.
 *
 * The class comes from the house's metering package rather than being written
 * here, so the fuse's behaviour is the same in every product that uses it. The
 * spine's client calls `/usage/consume` and `/usage/peek`, and the object's
 * `POST` and `GET` are exactly those two operations.
 */
export { ApiKeyUsageDO } from '@chester-hill-solutions/api-billing/durable-object';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const correlationId = newCorrelationId();
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, origin, correlationId) });
    }

    try {
      if (url.pathname === '/health') {
        return jsonResponse({ ok: true, product: env.PRODUCT_NAME ?? 'CivicSignal' }, env, origin, correlationId);
      }

      if (url.pathname === '/.well-known/civicsignal.json') {
        return capabilitiesResponse(env, url.origin, correlationId);
      }

      if (url.pathname === '/llms.txt') {
        return new Response(llmsTxt(env, url.origin), {
          headers: { 'content-type': 'text/plain; charset=UTF-8', ...corsHeaders(env, origin, correlationId) },
        });
      }

      if (url.pathname === '/mcp') {
        const handler = createCivicSignalMcpHandler({
          request,
          env,
          ctx: corpusContext(env),
        });
        return await handler.fetch(request);
      }

      if (url.pathname === '/api/chat') {
        return await handleChat(request, env, ctx, url, correlationId, origin);
      }

      if (url.pathname === '/api/match') {
        return await handleMatch(request, env, ctx, url, correlationId, origin);
      }

      if (url.pathname === '/api/brief' || url.pathname === '/api/news' || Object.hasOwn(CORPUS_ROUTES, url.pathname)) {
        return await handleApi(request, env, ctx, url, correlationId, origin);
      }

      return errorResponse('NOT_FOUND', `No route for ${url.pathname}`, env, origin, correlationId, 404);
    } catch (err: unknown) {
      console.error(`[${correlationId}] unhandled error`, err);
      return errorResponse('UNEXPECTED_ERROR', 'Unexpected error', env, origin, correlationId, 500);
    }
  },
};

/**
 * The BYOK chat surface.
 *
 * The caller's key arrives in a header, goes to the caller's provider, and is
 * nowhere else: not logged, not persisted, not in the usage ledger, not in an error.
 * The CivicSignal key still authorises and bills the *retrieval*.
 */
async function handleChat(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  correlationId: string,
  origin: string | null,
): Promise<Response> {
  const auth = await authorizeServerKey(env, request);
  if (!auth.ok) {
    const status = auth.reason ? httpStatusForKeyDenial(auth.reason) : 401;
    return errorResponse(
      auth.reason ?? 'KEY_REQUIRED',
      auth.message ?? 'A Server API key is required.',
      env,
      origin,
      correlationId,
      status,
    );
  }
  if (!auth.key || !auth.customer) {
    return errorResponse('KEY_INVALID', 'The key is not recognised.', env, origin, correlationId, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('INVALID_ARGUMENT', 'The body must be JSON.', env, origin, correlationId, 400);
  }

  const byokKey = request.headers.get(BYOK_KEY_HEADER) ?? '';
  const byokProvider = request.headers.get(BYOK_PROVIDER_HEADER) ?? 'anthropic';

  try {
    const result = await runChat(
      {
        env,
        byokKey,
        byokProvider,
        retrieve: async (briefRequest) => {
          const titles = await loadActTitles(env);
          const citation =
            briefRequest.topic && titles.length > 0
              ? parseCitation(briefRequest.topic, titles)?.citation
              : undefined;
          return buildBrief({ ...briefRequest, citation }, corpusContext(env));
        },
      },
      parseChatRequest(body),
    );

    // The retrieval is billable; the generation is the caller's.
    const billed = await recordSuccessfulBillable(env, { key: auth.key, customer: auth.customer }, {
      waitUntil: (task) => ctx.waitUntil(task),
    });
    if (!billed.allowed) {
      return billableDenialResponse(billed, correlationId, corsHeaders(env, origin, correlationId));
    }

    return jsonResponse(
      {
        answer: result.answer,
        provider: result.provider,
        model: result.model,
        scope: result.scope,
        cited: result.cited,
      },
      env,
      origin,
      correlationId,
    );
  } catch (err: unknown) {
    return chatErrorResponse(err, env, origin, correlationId);
  }
}

/**
 * Bring your own vector.
 *
 * The client embeds the query — in a browser, with a public Apache 2.0 model — and
 * sends the vector. The server never sees the text. What comes back is the cited
 * rows, passed through the licence gate on the way out.
 */
async function handleMatch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  correlationId: string,
  origin: string | null,
): Promise<Response> {
  const auth = await authorizeServerKey(env, request);
  if (!auth.ok) {
    const status = auth.reason ? httpStatusForKeyDenial(auth.reason) : 401;
    return errorResponse(
      auth.reason ?? 'KEY_REQUIRED',
      auth.message ?? 'A Server API key is required.',
      env,
      origin,
      correlationId,
      status,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('INVALID_ARGUMENT', 'The body must be JSON.', env, origin, correlationId, 400);
  }
  const parsed = parseMatchRequest(body);
  if (parsed.vector.length === 0) {
    return errorResponse('INVALID_ARGUMENT', 'A query vector is required.', env, origin, correlationId, 400);
  }

  const index = vectorIndexFor(env);
  if (!index) {
    return errorResponse(
      'UNSUPPORTED_COVERAGE',
      'Vector search is not configured for this deployment.',
      env,
      origin,
      correlationId,
      501,
    );
  }

  const topK = Math.min(Math.max(parsed.topK ?? 10, 1), 50);
  const matches = await index.query(parsed.vector, topK);

  const billed = await recordSuccessfulBillable(env, { key: auth.key!, customer: auth.customer! }, {
    waitUntil: (task) => ctx.waitUntil(task),
  });
  if (!billed.allowed) {
    return billableDenialResponse(billed, correlationId, corsHeaders(env, origin, correlationId));
  }

  return jsonResponse(
    { matches, count: matches.length, corpus: parsed.corpus ?? 'statutes-canada' },
    env,
    origin,
    correlationId,
  );
}

function vectorIndexFor(env: Env): VectorIndex | undefined {
  const binding = (env as { VECTORIZE?: VectorizeBinding }).VECTORIZE;
  return binding ? new VectorizeIndex(binding) : undefined;
}

function corpusContext(env: Env): CorpusContext {
  const vector = vectorIndexFor(env);
  const embedQuery = queryEmbedderFor(env);
  return {
    db: env.CIVIC_DB,
    fetch,
    now: () => new Date(),
    ...(vector ? { vector } : {}),
    ...(embedQuery ? { embedQuery } : {}),
    // The key for the inference gateway. Without it the search keeps the cosine
    // order and the floor, which is the behaviour of every deployment before
    // this one.
    ...(env.JEV_KEY ? { jev: { key: env.JEV_KEY } } : {}),
    // The cache, when the namespace is bound. The signature carries no KV, so
    // the retrieval code stays free of Cloudflare and the tests supply a Map.
    // `act-titles.ts` uses the same namespace for the same reason.
    ...(env.CIVIC_CACHE
      ? {
          cache: {
            get: (key: string) => env.CIVIC_CACHE!.get(key, 'json'),
            put: (key: string, value: unknown, ttlSeconds: number) =>
              env.CIVIC_CACHE!.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds }),
          },
        }
      : {}),
  };
}

/**
 * The embedder for a question, in the corpus's vector space.
 *
 * The corpus is embedded with **EmbeddingGemma 2**, served from the
 * `.litertlm` artefact — the same file the browser runs — so a question is
 * embedded by that same service, and the two are in the same space by
 * construction rather than approximately.
 *
 * The model and its instruction travel together, and this is the only place
 * that decides. A hosted model would be a second decision: bge-m3 takes no task
 * instruction, and the `task: search result` prefix belongs to EmbeddingGemma,
 * so putting one in front of the other would put the query in a slightly
 * different place from every document in the index.
 */
function queryEmbedderFor(env: Env): ((text: string) => Promise<number[]>) | undefined {
  const encoderUrl = env.ENCODER_URL;
  const encoderToken = env.ENCODER_TOKEN;
  if (encoderToken && (env.ENCODER_SERVICE || encoderUrl)) {
    return async (text: string) => {
      const url = encoderUrl ? `${encoderUrl.replace(/\/$/, '')}/embed-query` : 'https://encoder/embed-query';
      const request = new Request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${encoderToken}`,
        },
        body: JSON.stringify({ texts: [text] }),
      });
      // The service binding is the direct call; the address is the fallback for
      // a deployment that has one and not the other.
      const response = env.ENCODER_SERVICE
        ? await env.ENCODER_SERVICE.fetch(request)
        : await fetch(request);
      if (!response.ok) {
        // The URL and the body, because "the encoder refused: 404" is not a
        // diagnosis. A 404 from the wrong address and a 404 from the wrong path
        // look identical until the address is in the message.
        throw new Error(
          `the encoder refused ${response.status} at ${url}: ${(await response.text()).slice(0, 200)}`,
        );
      }
      const body = (await response.json()) as { vectors?: number[][] };
      const vector = body.vectors?.[0];
      if (!vector) throw new Error('the encoder returned no vector');
      return vector;
    };
  }

  // The hosted model, for a deployment that has no encoder service. It is a
  // different model in a different space, so it is only ever right when the
  // corpus was embedded with it too.
  const ai = env.AI;
  if (!ai) return undefined;
  return async (text: string) => {
    const result = await ai.run(QUERY_EMBEDDING_MODEL, { text: [text] });
    const vector = await firstVector(result);
    if (!vector) {
      throw new Error('the embedding model returned no vector');
    }
    return vector;
  };
}

/**
 * The vector, whatever shape the model answered in.
 *
 * **The Workers AI binding and the REST API do not answer in the same shape,
 * and neither does every model.** For a text-embedding model the binding
 * returns the raw result — `{ data: [[…]] }` — rather than a `Response`, so
 * there is nothing to call `.json()` on. The REST API wraps the same thing in
 * `{ result: { data: [[…]] } }`, and some models answer with
 * `{ data: [{ embedding: […] }] }` instead.
 *
 * So all three shapes are accepted, and a `Response` is read as JSON first.
 * The error this prevents is a confusing one: `response.json is not a
 * function`, in the middle of a search, with nothing in the message to say
 * which of the shapes was expected.
 */
async function firstVector(result: unknown): Promise<number[] | undefined> {
  let payload: unknown = result;
  if (result && typeof (result as { json?: unknown }).json === 'function') {
    payload = await (result as Response).json();
  }
  const candidate = payload as { data?: unknown; result?: { data?: unknown } };
  const data = candidate?.data ?? candidate?.result?.data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const first = data[0];
  if (Array.isArray(first)) return first as number[];
  if (first && typeof first === 'object' && 'embedding' in first) {
    return (first as { embedding: number[] }).embedding;
  }
  return undefined;
}

/** The model the corpus's vectors were made with. */
const QUERY_EMBEDDING_MODEL = '@cf/baai/bge-m3';

async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  correlationId: string,
  origin: string | null,
): Promise<Response> {
  const auth = await authorizeServerKey(env, request);
  if (!auth.ok) {
    const status = auth.reason ? httpStatusForKeyDenial(auth.reason) : 401;
    return errorResponse(
      auth.reason ?? 'KEY_REQUIRED',
      auth.message ?? 'A Server API key is required.',
      env,
      origin,
      correlationId,
      status,
    );
  }
  if (!auth.key || !auth.customer) {
    return errorResponse('KEY_INVALID', 'The key is not recognised.', env, origin, correlationId, 401);
  }

  const billing: BillableAuthContext = { key: auth.key, customer: auth.customer };
  const query = parseQuery(url);
  let body: unknown;
  try {
    // A citation is a key, not a similarity. If the question names a section, it is
    // resolved structurally and that provision leads the answer, rather than being
    // ranked against 191,000 sections by a search index.
    const citation = await resolveCitationFromTopic(query.topic, env);
    body = await runQuery(url.pathname, query, env, citation);
  } catch (err: unknown) {
    if (err instanceof ScopeParseError) {
      return errorResponse('INVALID_ARGUMENT', err.message, env, origin, correlationId, 400);
    }
    throw err;
  }

  const billed = await recordSuccessfulBillable(env, billing, {
    waitUntil: (task) => ctx.waitUntil(task),
  });
  if (!billed.allowed) {
    return billableDenialResponse(billed, correlationId, corsHeaders(env, origin, correlationId));
  }

  return jsonResponse(body, env, origin, correlationId);
}

/**
 * Resolve a citation out of the question, if the question names one.
 *
 * Returns undefined when there is no citation, or when the section does not exist —
 * a citation that names a section the instrument does not have is wrong, and the
 * nearest section would be worse than no answer.
 */
async function resolveCitationFromTopic(
  topic: string | undefined,
  env: Env,
): Promise<{ act: string; section: string } | undefined> {
  if (!topic) return undefined;
  const titles = await loadActTitles(env);
  if (titles.length === 0) return undefined;
  const match = parseCitation(topic, titles);
  if (!match) return undefined;
  return { act: match.citation.act, section: match.citation.section };
}

async function runQuery(
  pathname: string,
  query: CorpusQuery,
  env: Env,
  citation?: { act: string; section: string },
): Promise<unknown> {
  const corpusContextValue = corpusContext(env);

  if (pathname === '/api/brief') {
    const brief = await buildBrief({ ...(query as BriefRequest), citation }, corpusContextValue);
    return brief;
  }

  if (pathname === '/api/news') {
    const brief = await buildBrief(
      { ...(query as BriefRequest), include: ['news-canada', 'gdelt'] },
      corpusContextValue,
    );
    return { news: brief.news, sentiment: brief.sentiment, coverage: brief.coverage, attribution: brief.attribution };
  }

  const corpusId = CORPUS_ROUTES[pathname];
  if (!corpusId) {
    return { error: 'NOT_FOUND' };
  }
  const corpus = CORPUSES_BY_ID.get(corpusId);
  if (!corpus) {
    return { error: 'UNSUPPORTED_COVERAGE', corpusId };
  }
  const raw = await corpus.retrieve(query, corpusContextValue);
  const policy = policyFor(corpus.id);
  const items = policy ? raw.map((r) => emitCorpusItem(policy, r)) : [];
  return { items, attribution: policy?.attribution ?? '' };
}

