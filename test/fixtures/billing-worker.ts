import { DurableUsageLedger } from '../../src/spine/usage-ledger';
import type { Env } from '../../src/spine/env';
export { ApiKeyUsageDO } from '@chester-hill-solutions/api-billing/durable-object';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const ledger = new DurableUsageLedger(env);
    const args = [url.searchParams.get('customer') ?? 'fixture-a', 1, Date.UTC(2026, 10, 8)] as const;
    const result = request.method === 'POST'
      ? await ledger.consumeMonthly(...args)
      : await ledger.peekMonthly(...args);
    return Response.json(result);
  },
};
