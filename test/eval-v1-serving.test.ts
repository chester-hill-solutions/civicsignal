import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { InMemoryUsageLedger } from '@chester-hill-solutions/api-billing';
import { createPortabilityHandler } from '../services/api/handler';
import { RETRIEVAL_POLICY_VERSION } from '../src/corpora/retrieval-observation';
import type { CorpusContext } from '../src/corpora/types';
import raw from '../src/eval/data/v1-questions.json';
import { observedCalibration } from '../src/eval/v1-observed';
import { collectObservations, requestRetrieval, type TargetProvenance } from '../src/eval/v1-target';
import { validateV1Dataset } from '../src/eval/v1';

/** Real HTTP + serving handler + shared adapter + metering. Embeddings and
 * scores are deterministic fixtures, so this establishes the collector contract,
 * not real model quality or production performance. */
describe('20-case calibration serving-path contract', () => {
  it('collects refused and accepted language-filtered scores through the metered API', async () => {
    const dataset = validateV1Dataset(raw);
    const questions = dataset.questions.filter((q) => q.split === 'calibration');
    const lookup = new Map(questions.map((q, at) => [q.question, at]));
    const rows = questions.flatMap((q) => q.gold ? [{ id: q.gold.rowIds[0]!, corpus_id: 'statutes-canada', instrument: q.gold.act,
      section: q.gold.section, status: 'in-force', heading: 'Fixture', text: q.provenance.evidence,
      source_url: q.provenance.sourceUrl, jurisdiction: 'CA', in_force: true, language: q.language }] : []);
    const context: CorpusContext = {
      fetch, now: () => new Date(), corpusRevision: `${dataset.revision}:statutes-v2`,
      corpusAvailability: { 'statutes-canada': { available: true, reason: 'Fully seeded calibration fixture', revision: dataset.revision, parserVersion: 'statutes-v2', rowCount: rows.length } },
      db: { prepare: () => ({ bind: (...ids: unknown[]) => ({ async all<T>() { return { results: rows.filter((row) => ids.includes(row.id)) as T[] }; } }) }) },
      embedQuery: async (text) => { const at = lookup.get(text); if (at === undefined) throw new Error('Unknown fixture question'); return [at]; },
      vector: { async query(vector, _depth, filter) {
        const q = questions[vector[0]!]!;
        expect(filter?.['language']).toBe(q.language);
        return [{ id: q.gold?.rowIds[0] ?? 'irrelevant-row', score: q.answerable ? 0.9 : 0.4, metadata: {} }];
      } },
      // Fresh requests must bypass both operations.
      cache: { get: async () => { throw new Error('Unexpected fixture cache read'); }, put: async () => { throw new Error('Unexpected fixture cache write'); } },
    };
    const ledger = new InMemoryUsageLedger();
    const handler = createPortabilityHandler({ context, ledger, meter: { freeFuseLimit: 100, meterEventName: 'fixture' },
      authorize: async (request) => request.headers.get('authorization') === 'Bearer fixture-key'
        ? { id: 'fixture', plan: 'free', fuseLimit: 100, fuseSoftWarn: false } : new Response(null, { status: 401 }) });
    const server = createServer(async (request, response) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value);
      const result = await handler(new Request(`http://fixture${request.url}`, { method: request.method, headers }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No fixture server address');
      const collected = await collectObservations(questions, 2, (q) => requestRetrieval({ baseUrl: `http://127.0.0.1:${address.port}`,
        route: '/api/brief', key: 'fixture-key', limit: 10, timeoutMs: 5000, fresh: true }, q));
      const provenance: TargetProvenance = { backend: 'postgres', environment: 'local-fixture', deployment: 'fixture',
        corpusRevision: dataset.revision, parserVersion: 'statutes-v2', corpusAsOf: '2026-10-20', corpusLastRunAt: '2026-10-22T00:00:00Z',
        upstream: { revision: dataset.revision, committedAt: '2026-10-20T00:00:00Z', observedAt: '2026-10-22T00:00:00Z' },
        encoderModel: 'embeddinggemma-2-270m', encoderArtifact: 'deterministic fixture, not the model', encoderDimensions: 1,
        retrievalPolicy: `postgres-cosine:${RETRIEVAL_POLICY_VERSION}`, reranker: 'disabled',
        evidence: { source: 'local serving fixture', observedAt: '2026-10-22T00:00:00Z', note: 'Synthetic vectors/scores; no production accuracy or performance claim' } };
      const calibration = observedCalibration(dataset.questions, collected.observations, provenance);
      expect(calibration.ready, JSON.stringify(calibration.rejected)).toBe(true);
      expect(calibration.acceptedScores).toBe(20);
      expect(calibration.observations.filter((o) => o.bestScore < 0.81)).toHaveLength(8);
      expect(collected.observations.filter((o) => o.items.length === 0)).toHaveLength(8);
      expect((await ledger.peekMonthly('fixture', 100)).count).toBe(20);
      expect(JSON.stringify(collected.observations)).not.toContain('fixture-key');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
