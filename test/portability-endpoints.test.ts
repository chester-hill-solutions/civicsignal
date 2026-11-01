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
