import { describe, expect, it, vi } from 'vitest';
import { DurableUsageLedger } from '../src/spine/usage-ledger';
import type { Env } from '../src/spine/env';

const now = Date.UTC(2026, 10, 8);
function fixture(reply: (url: URL, method: string) => Response) {
  const names: string[] = [];
  const requests: { path: string; method: string }[] = [];
  const env = {
    API_KEY_USAGE: {
      idFromName(name: string) { names.push(name); return name; },
      get() {
        return { fetch: async (input: string, init?: { method?: string }) => {
          const url = new URL(input);
          const method = init?.method ?? 'GET';
          requests.push({ path: url.pathname, method });
          return reply(url, method);
        } };
      },
    },
  } as unknown as Env;
  return { ledger: new DurableUsageLedger(env), names, requests };
}

describe('shared monthly counter host integration', () => {
  it('peeks through GET /consume without incrementing and keeps the customer identity', async () => {
    let count = 0;
    const { ledger, names, requests } = fixture((url, method) => {
      const limit = Number(url.searchParams.get('limit'));
      const allowed = count < limit;
      if (method === 'POST' && allowed) count++;
      return Response.json({ allowed, count, limit, month: '2026-11' });
    });
    expect((await ledger.peekMonthly('customer-a', 1, now)).count).toBe(0);
    expect((await ledger.consumeMonthly('customer-a', 1, now)).allowed).toBe(true);
    expect((await ledger.peekMonthly('customer-a', 1, now)).count).toBe(1);
    expect((await ledger.consumeMonthly('customer-a', 1, now)).allowed).toBe(false);
    expect(count).toBe(1);
    expect(requests).toEqual([
      { path: '/consume', method: 'GET' }, { path: '/consume', method: 'POST' },
      { path: '/consume', method: 'GET' }, { path: '/consume', method: 'POST' },
    ]);
    expect(names).toEqual(Array(4).fill('customer:customer-a'));
  });

  it.each([
    ['HTTP failure', () => Response.json({ allowed: true, count: 1, limit: 1, month: '2026-11' }, { status: 503 })],
    ['malformed success', () => Response.json({ allowed: 'yes', count: 1, limit: 1, month: '2026-11' })],
    ['wrong billing period', () => Response.json({ allowed: true, count: 1, limit: 1, month: '2026-10' })],
  ])('fails closed for hard limits on %s', async (_label, reply) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await fixture(reply).ledger.consumeMonthly('customer-a', 1, now)).allowed).toBe(false);
    } finally { warn.mockRestore(); }
  });

  it('preserves unlimited availability on unavailable storage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await fixture(() => new Response(null, { status: 503 })).ledger.consumeMonthly('customer-a', 0, now)).allowed).toBe(true);
      const missing = new DurableUsageLedger({} as Env);
      expect((await missing.consumeMonthly('customer-a', 1, now)).allowed).toBe(false);
      expect((await missing.consumeMonthly('customer-a', 0, now)).allowed).toBe(true);
    } finally { warn.mockRestore(); }
  });
});
