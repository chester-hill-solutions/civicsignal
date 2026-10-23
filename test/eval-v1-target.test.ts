import { createServer, type RequestListener, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import raw from '../src/eval/data/v1-questions.json';
import { retrievalTrace } from '../src/corpora/retrieval-observation';
import { validateV1Dataset } from '../src/eval/v1';
import { balancedSchedule, collectObservations, corpusFreshness, requestRetrieval, targetProvenanceSchema, type TargetProvenance } from '../src/eval/v1-target';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});
const question = validateV1Dataset(raw).questions[0]!;
async function target(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return { baseUrl: `http://127.0.0.1:${address.port}`, route: '/api/statutes' as const, timeoutMs: 5000, limit: 10, key: 'fixture-only-key' };
}

describe('v1 actual HTTP transport', () => {
  it('balances the measured request mix across language and answerability', () => {
    const schedule = balancedSchedule(validateV1Dataset(raw).questions.filter((q) => q.status !== 'unverified'), 20);
    expect(schedule.filter((q) => q.answerable)).toHaveLength(10);
    expect(schedule.filter((q) => q.language === 'fr')).toHaveLength(10);
    expect(new Set(schedule.slice(0, 4).map((q) => `${q.answerable}:${q.language}`)).size).toBe(4);
  });
  it('uses the serving statute route, exact question and explicit language', async () => {
    const running = await target((request, response) => {
      const url = new URL(request.url!, 'http://fixture');
      expect(url.pathname).toBe('/api/statutes');
      expect(url.searchParams.get('topic')).toBe(question.question);
      expect(url.searchParams.get('language')).toBe(question.language);
      expect(request.headers.authorization).toBe('Bearer fixture-only-key');
      response.setHeader('content-type', 'application/json');
      response.setHeader('x-correlation-id', 'fixture-request');
      response.end(JSON.stringify({ items: [{ id: question.gold!.rowIds[0], language: question.language }] }));
    });
    const result = await requestRetrieval(running, question);
    expect(result.outcome).toBe('ok');
    expect(result.items).toEqual([{ id: question.gold!.rowIds[0], language: question.language }]);
    expect(result.correlationId).toBe('fixture-request');
    expect(JSON.stringify(result)).not.toContain('fixture-only-key');
    expect(result.elapsedMs).toBeGreaterThan(0);
  });
  it('keeps HTTP failures distinct from a successful empty refusal', async () => {
    const running = await target((_request, response) => {
      response.statusCode = 503;
      response.end(JSON.stringify({ code: 'ENCODER_UNAVAILABLE' }));
    });
    const result = await requestRetrieval(running, question);
    expect(result.outcome).toBe('http-error');
    expect(result.errorCode).toBe('ENCODER_UNAVAILABLE');
  });
  it('requests fresh execution and retains safe provider observations on HTTP failure', async () => {
    const trace = await retrievalTrace({ fetch, now: () => new Date(), corpusRevision: 'source:statutes-v2' }, question, 'vectorize', 'vector-floor', 0.62);
    trace.observation.decision = 'error';
    trace.observation.providers.encoder = 'error';
    const running = await target((request, response) => {
      expect(request.headers['x-civicsignal-evaluation']).toBe('fresh');
      response.statusCode = 503;
      response.end(JSON.stringify({ code: 'UPSTREAM_UNAVAILABLE', retrieval: [trace.observation] }));
    });
    const result = await requestRetrieval({ ...running, fresh: true }, question);
    expect(result.outcome).toBe('http-error');
    expect(result.retrieval![0]).toMatchObject({ revision: 'source', parserVersion: 'statutes-v2', providers: { encoder: 'error' } });
  });
  it('does not treat an HTTP 200 with the wrong response shape as refusal', async () => {
    const running = await target((_request, response) => response.end(JSON.stringify({ items: 'broken' })));
    expect((await requestRetrieval(running, question)).outcome).toBe('invalid-response');
  });
  it('reports a redirect as a transport failure without sending credentials elsewhere', async () => {
    let forwarded = false;
    const sink = await target((_request, response) => { forwarded = true; response.end('{}'); });
    const running = await target((_request, response) => { response.writeHead(302, { location: sink.baseUrl }); response.end(); });
    expect((await requestRetrieval(running, question)).outcome).toBe('transport-error');
    expect(forwarded).toBe(false);
  });
  it('measures a running target under the requested concurrency without dropping jobs', async () => {
    let requests = 0;
    const running = await target((_request, response) => { requests++; response.end(JSON.stringify({ items: [] })); });
    const result = await collectObservations([question, question, question, question], 2, (q) => requestRetrieval(running, q));
    expect(requests).toBe(4);
    expect(result.observations).toHaveLength(4);
    expect(result.observations.every((o) => o.outcome === 'ok')).toBe(true);
    expect(result.completedRequestsPerSecond).toBeGreaterThan(0);
    // This is functional transport proof, not a production throughput assertion.
  });
});

describe('v1 corpus freshness provenance', () => {
  const provenance: TargetProvenance = {
    backend: 'vectorize', environment: 'production', deployment: 'test-version',
    corpusRevision: 'a'.repeat(40), parserVersion: 'statutes-v2', corpusAsOf: '2026-10-20', corpusLastRunAt: '2026-10-21T00:00:00Z',
    upstream: { revision: 'b'.repeat(40), committedAt: '2026-10-21T12:00:00Z', observedAt: '2026-10-22T00:00:00Z' },
    encoderModel: 'embeddinggemma-2-270m', encoderArtifact: 'model-file', encoderDimensions: 768,
    retrievalPolicy: 'vectorize-federal-v2', reranker: 'jev-1.13',
    evidence: { source: 'operator DB/export observation', observedAt: '2026-10-22T00:00:00Z', note: 'Fixture provenance for arithmetic test only' },
  };
  it('requires model, deployment, corpus and upstream evidence', () => {
    expect(targetProvenanceSchema.safeParse({ backend: 'vectorize' }).success).toBe(false);
    expect(targetProvenanceSchema.parse(provenance)).toEqual(provenance);
  });
  it('reports revision lag separately from the last successful job age', () => {
    const result = corpusFreshness(provenance, new Date('2026-10-22T12:00:00Z'));
    expect(result.sameRevisionAsObservedUpstream).toBe(false);
    expect(result.corpusAgeHours).toBe(60);
    expect(result.lastRunAgeHours).toBe(36);
    expect(result.upstreamObservationAgeHours).toBe(12);
    expect(result.pendingRevisionAgeHours).toBe(24);
  });
});
