import { afterEach, describe, expect, it, vi } from 'vitest';
import { statutesCorpus } from '../src/corpora/adapters';
import { postgresStatutesCorpus } from '../src/corpora/postgres-adapters';
import { observeRetrievalContext, rerankerFailureSchema, type RetrievalObservation } from '../src/corpora/retrieval-observation';
import type { CorpusContext } from '../src/corpora/types';

const row = { id: 'row-1', corpus_id: 'statutes-canada', act: 'Test Act', instrument: 'Test Act', section: '1', text: 'private-candidate-body', source_url: 'https://example.test/1', language: 'fr', in_force: 1 };
function jevResponse() {
  return Response.json({ answers: {
    c0: { type: 'noul', noul: 0.9 }, needs_federal_statute: { type: 'noul', noul: 1 },
    any_relevant: { type: 'noul', noul: 1 }, needs_provincial: { type: 'noul', noul: 0 },
    needs_court_decision: { type: 'noul', noul: 0 }, needs_foreign_law: { type: 'noul', noul: 0 },
    is_not_law: { type: 'noul', noul: 0 }, asks_published_figure: { type: 'noul', noul: 0 },
  } });
}
function fixture(score = 0.9) {
  const retrieval: RetrievalObservation[] = [];
  const rows = vi.fn();
  const vector = vi.fn(async () => [{ id: 'row-1', score, metadata: {} }]);
  const embedQuery = vi.fn(async () => [1]);
  const ctx: CorpusContext = { fetch, now: () => new Date(), corpusRevision: Promise.resolve('r1'),
    db: { prepare: () => ({ bind: () => ({ async all<T>() { rows(); return { results: [row] as T[] }; } }) }) },
    vector: { query: vector }, embedQuery, onRetrieval: (value) => retrieval.push(value) };
  return { ctx, retrieval, rows, vector, embedQuery };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('safe serving retrieval observations', () => {
  it('records the actual language-filtered score before a floor refusal without loading text', async () => {
    const f = fixture(0.2);
    expect(await statutesCorpus.retrieve({ topic: 'private-question', language: 'fr' }, f.ctx)).toEqual([]);
    expect(f.vector).toHaveBeenCalledWith([1], 25, { language: 'fr' });
    expect(f.rows).not.toHaveBeenCalled();
    expect(f.retrieval).toHaveLength(1);
    expect(f.retrieval[0]).toMatchObject({ backend: 'vectorize', revision: 'r1', mode: 'vector-floor', decision: 'refuse', languageFilter: 'fr', preRefusalTopScore: 0.2, scoreSource: 'computed', candidateCount: 1, resultCount: 0, providers: { encoder: 'ok', vector: 'ok', rows: 'not-called', reranker: 'disabled' } });
    expect(f.retrieval[0]!.scoredAt).not.toBeNull();
    expect(JSON.stringify(f.retrieval)).not.toContain('private-question');
  });
  it('records Postgres scores and its separate floor through the shared decision path', async () => {
    const f = fixture(0.7);
    await postgresStatutesCorpus.retrieve({ topic: 'private-question', language: 'fr' }, f.ctx);
    expect(f.retrieval[0]).toMatchObject({ backend: 'postgres-cosine', vectorFloor: 0.81, decision: 'refuse', preRefusalTopScore: 0.7 });
  });
  it('keeps source and parser revisions explicit while bypassing cache for evaluation', async () => {
    const f = fixture(0.2);
    const get = vi.fn(async () => null);
    const put = vi.fn(async () => {});
    f.ctx.corpusRevision = 'source-commit:statutes-v2';
    f.ctx.cache = { get, put };
    f.ctx.retrievalCacheMode = 'bypass';
    await statutesCorpus.retrieve({ topic: 'private-question', language: 'fr' }, f.ctx);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(f.retrieval[0]).toMatchObject({ revision: 'source-commit', parserVersion: 'statutes-v2', cache: 'bypass', scoreSource: 'computed' });
  });
  it.each(['HTTP error', 'invalid HTTP 200'])('makes a successful %s provider fallback visible without error text or credentials', async kind => {
    vi.stubGlobal('fetch', vi.fn(async () => kind === 'HTTP error'
      ? new Response('private-upstream-error', { status: 503 }) : Response.json(null)));
    const f = fixture();
    f.ctx.jev = { key: 'private-provider-key' };
    const items = await statutesCorpus.retrieve({ topic: 'private-question', language: 'fr' }, f.ctx);
    expect(items).toHaveLength(1);
    expect(f.retrieval[0]).toMatchObject({ mode: 'vector-floor', fallback: true, decision: 'answer', providers: { reranker: 'error' }, rerankerFailure: kind === 'HTTP error' ? { phase: 'upstream-http', upstreamStatus: 503 } : { phase: 'response-validation', upstreamStatus: 200, schemaReason: 'response-shape' } });
    expect(JSON.stringify(f.retrieval)).not.toMatch(/private-question|private-provider-key|private-candidate-body|private-upstream-error/);
  });
  it('discloses originating score provenance on cache hits and makes no new provider calls', async () => {
    const send = vi.fn(async () => jevResponse());
    vi.stubGlobal('fetch', send);
    const f = fixture();
    const cache = new Map<string, unknown>();
    f.ctx.jev = { key: 'private-provider-key' };
    f.ctx.cache = { get: async (key) => cache.get(key) ?? null, put: async (key, value) => { cache.set(key, value); } };
    await statutesCorpus.retrieve({ topic: 'private-question', language: 'fr' }, f.ctx);
    await statutesCorpus.retrieve({ topic: 'private-question', language: 'fr' }, f.ctx);
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.vector).toHaveBeenCalledTimes(1);
    expect(f.embedQuery).toHaveBeenCalledTimes(1);
    expect(f.retrieval[0]).toMatchObject({ cache: 'miss', mode: 'rerank', scoreSource: 'computed', preRefusalTopScore: 0.9 });
    expect(f.retrieval[1]).toMatchObject({ cache: 'hit', mode: 'rerank', scoreSource: 'cached', preRefusalTopScore: 0.9, providers: { encoder: 'not-called', vector: 'not-called', reranker: 'not-called', rows: 'ok' } });
    expect(f.retrieval[1]!.scoredAt).toBe(f.retrieval[0]!.scoredAt);
  });
  it.each(['d1', 'r2'])('records cached answer selection when %s hydration fails without inventing cached scores', async (stage) => {
    const send = vi.fn(async () => jevResponse());
    vi.stubGlobal('fetch', send);
    const f = fixture();
    const cache = new Map<string, unknown>();
    f.ctx.jev = { key: 'private-provider-key' };
    f.ctx.cache = { get: async (key) => cache.get(key) ?? null, put: async (key, value) => { cache.set(key, value); } };
    const query = { topic: 'private-question', language: 'fr' };
    await statutesCorpus.retrieve(query, f.ctx);
    if (stage === 'd1') f.rows.mockImplementation(() => { throw new Error('private-row-failure'); });
    else f.ctx.provisionTexts = { hydrate: async () => { throw new Error('private-row-failure'); } };

    await expect(statutesCorpus.retrieve(query, f.ctx)).rejects.toThrow('private-row-failure');
    expect(f.retrieval).toHaveLength(2);
    expect(f.retrieval[1]).toMatchObject({ cache: 'hit', decision: 'error', mode: 'vector-floor',
      scoreSource: 'none', preRefusalTopScore: null, scoredAt: null, candidateCount: 0, resultCount: 0,
      providers: { encoder: 'not-called', vector: 'not-called', reranker: 'not-called', rows: 'error' } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.vector).toHaveBeenCalledTimes(1);
    expect(f.embedQuery).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.retrieval)).not.toMatch(/private-question|private-row-failure|private-provider-key|private-candidate-body/);
  });
  it('keeps a selected answer with missing rows stale and performs the existing fresh search', async () => {
    const f = fixture();
    f.ctx.cache = { get: async () => ({ decision: 'answer', anyRelevant: 1, order: ['missing-row'] }), put: async () => {} };
    expect(await statutesCorpus.retrieve({ topic: 'private-question', language: 'fr' }, f.ctx)).toHaveLength(1);
    expect(f.vector).toHaveBeenCalledTimes(1);
    expect(f.embedQuery).toHaveBeenCalledTimes(1);
    expect(f.retrieval[0]).toMatchObject({ cache: 'stale', decision: 'answer', scoreSource: 'computed', preRefusalTopScore: 0.9 });
  });
  it.each([statutesCorpus, postgresStatutesCorpus])('observes exact lookups without inventing a vector score', async (corpus) => {
    const f = fixture();
    await corpus.retrieve({ act: 'Test Act', section: '1', language: 'fr' }, f.ctx);
    expect(f.retrieval[0]).toMatchObject({ mode: 'exact', decision: 'answer', preRefusalTopScore: null, scoreSource: 'none', vectorFloor: null, providers: { encoder: 'not-called', vector: 'not-called', rows: 'ok' } });
    expect(f.vector).not.toHaveBeenCalled();
  });
  it('observes a failed encoder exactly once and preserves the retrieval failure', async () => {
    const f = fixture();
    f.ctx.embedQuery = async () => { throw new Error('private-encoder-error'); };
    await expect(statutesCorpus.retrieve({ topic: 'private-question' }, f.ctx)).rejects.toThrow('private-encoder-error');
    expect(f.retrieval).toHaveLength(1);
    expect(f.retrieval[0]).toMatchObject({ decision: 'error', providers: { encoder: 'error', vector: 'not-called' } });
    expect(JSON.stringify(f.retrieval)).not.toContain('private-encoder-error');
  });
  it('isolates observations when contexts are reused across requests', async () => {
    const f = fixture();
    const first = observeRetrievalContext(f.ctx);
    const second = observeRetrievalContext(f.ctx);
    await statutesCorpus.retrieve({ act: 'Test Act', section: '1' }, first.ctx);
    expect(first.retrieval).toHaveLength(1);
    expect(second.retrieval).toHaveLength(0);
    expect(f.retrieval).toHaveLength(1);
  });
  it('does not let a diagnostics callback change a successful retrieval', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fixture();
    f.ctx.onRetrieval = () => { throw new Error('private-diagnostic-error'); };
    expect(await statutesCorpus.retrieve({ act: 'Test Act', section: '1' }, f.ctx)).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith('{"event":"retrieval_observer_failed"}');
  });
});


describe('bounded optional reranker failure observations', () => {
  it.each([
    {phase:'unexpected'}, {phase:'transport',upstreamStatus:99}, {phase:'transport',upstreamStatus:600},
    {phase:'transport',upstreamStatus:200.5}, {phase:'response-validation',missingCount:-1},
    {phase:'response-validation',missingCount:258}, {phase:'response-validation',rejectedCount:.5},
    {phase:'response-validation',schemaReason:'private-reason'}, {phase:'transport',message:'private-cause'},
  ])('rejects unbounded or unapproved failure metadata %#',value=>{
    expect(rerankerFailureSchema.safeParse(value).success).toBe(false);
  });
  it('includes only coarse schema counts while preserving vector fallback and result order',async()=>{
    const send=vi.fn(async()=>Response.json({answers:{c0:{type:'noul',noul:'private-invalid-score'}}}));vi.stubGlobal('fetch',send);
    const f=fixture();f.ctx.jev={key:'private-provider-key'};
    expect(await statutesCorpus.retrieve({topic:'private-question',language:'fr'},f.ctx)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.retrieval[0]).toMatchObject({mode:'vector-floor',fallback:true,providers:{reranker:'error'},rerankerFailure:{phase:'response-validation',upstreamStatus:200,schemaReason:'requested-answers',rejectedCount:1,missingCount:7}});
    expect(JSON.stringify(f.retrieval)).not.toMatch(/private|c0|needs_federal|any_relevant/);
  });
  it('keeps a throwing serving observer from changing provider fallback',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('private-provider-error',{status:503})));
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const f=fixture();f.ctx.jev={key:'private-provider-key'};f.ctx.onRetrieval=()=>{throw new Error('private-observer');};
    expect(await statutesCorpus.retrieve({topic:'private-question',language:'fr'},f.ctx)).toHaveLength(1);
    expect(f.vector).toHaveBeenCalledTimes(1);expect(f.rows).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);expect(console.error).toHaveBeenCalledWith('{"event":"retrieval_observer_failed"}');
  });
  it('omits failure metadata on a successful rerank and cache hit',async()=>{
    const send=vi.fn(async()=>jevResponse());vi.stubGlobal('fetch',send);const f=fixture(),cache=new Map<string,unknown>();
    f.ctx.jev={key:'private-provider-key'};f.ctx.cache={get:async k=>cache.get(k)??null,put:async(k,v)=>{cache.set(k,v);}};
    const query={topic:'private-question',language:'fr'};
    await statutesCorpus.retrieve(query,f.ctx);await statutesCorpus.retrieve(query,f.ctx);
    expect(send).toHaveBeenCalledTimes(1);expect(f.retrieval.map(x=>x.rerankerFailure)).toEqual([undefined,undefined]);
  });
});
