import type { MeterConfig, MeteredCustomer, UsageLedger } from '@chester-hill-solutions/api-billing';
import { BillableDenied, runBillableWork } from '../../src/metering';
import { buildBrief } from '../../src/routes/brief';
import { parseQuery } from '../../src/routes/query';
import { parseMatchRequest } from '../../src/routes/chat';
import { assertV1StatuteQuery, loadCorpusAvailability, UnsupportedCoverageError } from '../../src/corpora/registry';
import { postgresStatutesCorpus } from '../../src/corpora/postgres-adapters';
import type { CorpusContext } from '../../src/corpora/types';
import { ScopeParseError } from '../../src/corpora/scope';
import { readJsonBody, RequestInputError } from '../../src/http';
import { observeRetrievalContext, type RetrievalObservation } from '../../src/corpora/retrieval-observation';

/** Undeployed portability handler. Cloudflare remains the production entry point. */
export function createPortabilityHandler(options: {
  context: CorpusContext;
  ledger: UsageLedger;
  meter: MeterConfig;
  authorize: (request: Request) => Promise<MeteredCustomer | Response>;
}) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const correlationId = crypto.randomUUID();
    const retrieval: RetrievalObservation[] = [];
    try {
      if (url.pathname === '/health') return Response.json({ ok: true, plane: 'portability' });
      if (url.pathname !== '/api/brief' && url.pathname !== '/api/match') {
        return Response.json({ code: 'NOT_FOUND' }, { status: 404 });
      }
      const method = url.pathname === '/api/match' ? 'POST' : 'GET';
      if (request.method !== method) return Response.json({ code: 'METHOD_NOT_ALLOWED' }, { status: 405, headers: { Allow: method } });
      const customer = await options.authorize(request);
      if (customer instanceof Response) return customer;
      const availability = options.context.corpusAvailability ?? loadCorpusAvailability(options.context);
      const observed = observeRetrievalContext({ ...options.context, corpusAvailability: availability,
        onRetrieval: (observation) => { retrieval.push(observation); options.context.onRetrieval?.(observation); },
        retrievalCacheMode: request.headers.get('x-civicsignal-evaluation') === 'fresh' ? 'bypass' : 'default',
        corpusRevision: options.context.corpusRevision ?? Promise.resolve(availability).then((value) => {
          const state = value['statutes-canada'];
          return state?.revision ? `${state.revision}:${state.parserVersion ?? 'legacy'}` : 'unknown';
        }) });
      let work: () => Promise<unknown>;
      if (url.pathname === '/api/match') {
        const parsed = parseMatchRequest(await readJsonBody(request));
        if (!options.context.vector) return Response.json({ code: 'RETRIEVAL_UNAVAILABLE' }, { status: 503 });
        work = async () => {
          const matches = await options.context.vector!.query(parsed.vector, parsed.topK ?? 10);
          return { matches, count: matches.length, corpus: 'statutes-canada' };
        };
      } else {
        const query = parseQuery(url);
        assertV1StatuteQuery(query);
        if (!query.topic && !query.keywords?.length && !(query.act && query.section)) {
          throw new RequestInputError('Supply a topic, keywords or an exact act and section.');
        }
        work = () => buildBrief({ ...query, citation: query.act && query.section ? { act: query.act, section: query.section } : undefined },
          observed.ctx, [postgresStatutesCorpus]);
      }
      const body = await runBillableWork(customer, options.meter, options.ledger, work);
      return Response.json({ ...body as Record<string, unknown>, retrieval: observed.retrieval }, { headers: { 'x-correlation-id': correlationId } });
    } catch (error) {
      if (error instanceof BillableDenied) return Response.json({ ...error.outcome.body, correlationId, retrieval }, { status: error.outcome.status });
      if (error instanceof RequestInputError || error instanceof ScopeParseError || error instanceof UnsupportedCoverageError) {
        return Response.json({ code: error instanceof UnsupportedCoverageError ? error.code : 'INVALID_ARGUMENT', message: error.message, correlationId, retrieval },
          { status: error instanceof ScopeParseError ? 400 : error.status });
      }
      console.error(JSON.stringify({ event: 'portability_request_failed', correlationId,
        errorType: error instanceof Error ? error.name : 'unknown' }));
      return Response.json({ code: 'UPSTREAM_UNAVAILABLE', message: 'The request could not complete. Retry later.', correlationId, retrieval }, { status: 502 });
    }
  };
}
