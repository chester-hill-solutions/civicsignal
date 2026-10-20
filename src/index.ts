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

function corpusContext(env: Env): CorpusContext {
  return { db: env.CIVIC_DB, fetch, now: () => new Date() };
}

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

function parseQuery(url: URL): CorpusQuery {
  const topic = url.searchParams.get('topic') ?? undefined;
  const keywords = url.searchParams.getAll('keyword').filter(Boolean);
  const jurisdiction = url.searchParams.get('jurisdiction') ?? undefined;
  const riding = url.searchParams.get('riding') ?? undefined;
  const since = url.searchParams.get('since') ?? undefined;
  const until = url.searchParams.get('until') ?? undefined;
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  const scope = parseScope(url.searchParams.get('scope'));
  return { topic, keywords, jurisdiction, riding, since, until, limit, scope };
}
