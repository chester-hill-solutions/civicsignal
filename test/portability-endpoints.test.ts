import { describe, expect, it, vi } from 'vitest';
import { InMemoryUsageLedger } from '@chester-hill-solutions/api-billing';
import { createPortabilityHandler } from '../services/api/handler';

function fixture() {
  const ledger = new InMemoryUsageLedger();
  const query = vi.fn(async () => [{ id: 'test', score: 0.9, metadata: {} }]);
  const handler = createPortabilityHandler({ context: { vector: { query }, fetch, now: () => new Date() }, ledger,
    meter: { freeFuseLimit: 1, meterEventName: 'test' },
    authorize: async () => ({ id: 'preserved_customer', plan: 'free', fuseLimit: 1, fuseSoftWarn: false }) });
  const send = (body: string) => handler(new Request('https://example.test/api/match', { method: 'POST', body }));
  const count = async () => (await ledger.peekMonthly('preserved_customer', 1)).count;
  const valid = JSON.stringify({ vector: Array.from({ length: 768 }, (_, at) => at ? 0 : 1) });
  return { send, query, count, valid };
}

describe('Bun portability billing boundary', () => {
  it('applies the Postgres floor to the eligible provisions on the brief route', async () => {
    const ledger = new InMemoryUsageLedger();
    const provisions = [
      { id: 'strong', instrument: 'Test Act', section: '1', text: 'A rule about notice.' },
      { id: 'weak', instrument: 'Test Act', section: '2', text: 'A rule about payment.' },
    ];
    const handler = createPortabilityHandler({
      context: {
        now: () => new Date(), fetch, corpusRevision: 'fixture-revision',
        corpusAvailability: { 'statutes-canada': { available: true, reason: 'Fixture' } },
        db: { prepare: () => ({ bind: (...ids: unknown[]) => ({
          async all<T>() {
            return { results: provisions.filter((row) => ids.includes(row.id)).map((row) => ({
              ...row, corpus_id: 'statutes-canada', jurisdiction: 'CA', in_force: true, language: 'en',
              source_url: `https://example.test/act/${row.section}`,
            })) as T[] };
          },
        }) }) },
        embedQuery: async () => [1],
        vector: { async query() {
          return [{ id: 'strong', score: 0.95, metadata: {} }, { id: 'weak', score: 0.75, metadata: {} }];
        } },
      },
      ledger,
      meter: { freeFuseLimit: 1, meterEventName: 'test' },
      authorize: async () => ({ id: 'preserved_customer', plan: 'free', fuseLimit: 1, fuseSoftWarn: false }),
    });

    const response = await handler(new Request('https://example.test/api/brief?topic=test+rule&keyword=payment&language=en'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      legislation: [],
      retrieval: [{
        backend: 'postgres-cosine', preRefusalTopScore: 0.95, vectorFloor: 0.81, decision: 'refuse', resultCount: 0,
      }],
    });
    expect((await ledger.peekMonthly('preserved_customer', 1)).count).toBe(1);
  });

  it('does not consume a unit for malformed bodies, invalid vectors or failed retrieval', async () => {
    const test = fixture();
    expect((await test.send('{')).status).toBe(400);
    expect((await test.send(JSON.stringify({ vector: [1] }))).status).toBe(400);
    test.query.mockRejectedValueOnce(new Error('private database detail'));
    const failed = await test.send(test.valid);
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('private database detail');
    expect(await test.count()).toBe(0);
  });
  it('counts success once and refuses exhausted calls before the expensive work', async () => {
    const test = fixture();
    expect((await test.send(test.valid)).status).toBe(200);
    expect((await test.send(test.valid)).status).toBe(429);
    expect(await test.count()).toBe(1);
    expect(test.query).toHaveBeenCalledTimes(1);
  });
});
