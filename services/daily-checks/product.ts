import { DurableObjectUsageLedger } from '@chester-hill-solutions/api-billing/durable-object';
import { z } from 'zod';

export interface ProductEnv {
  PRODUCT: Fetcher;
  DAILY_CHECK_KEY: string;
  API_KEY_USAGE: DurableObjectNamespace;
}

const workspace = 'stage-daily-checks';

export function verificationClient(env: ProductEnv) {
  const requests: { path: string; status: number; correlationId: string }[] = [];
  async function request(path: string, authenticated: boolean) {
    const response = await env.PRODUCT.fetch('https://daily.internal' + path,
      { headers: authenticated ? { authorization: 'Bearer ' + env.DAILY_CHECK_KEY } : {} });
    const correlationId = response.headers.get('x-correlation-id');
    if (!correlationId) throw new Error('Product response lacks a correlation ID for ' + path);
    requests.push({ path, status: response.status, correlationId });
    return response;
  }
  async function read(path: string, params?: Record<string, string>) {
    const response = await request(path + (params ? '?' + new URLSearchParams(params) : ''), true);
    if (!response.ok) {
      const result = z.object({ code: z.string().regex(/^[A-Z][A-Z_0-9]{0,63}$/) })
        .safeParse(await response.json().catch(() => null));
      const code = result.success ? result.data.code : 'UNCLASSIFIED';
      const language = params?.language ? ' ' + params.language : '';
      throw new Error(`Product request ${requests.length} failed (${response.status} ${code}): ${path}${language} [${response.headers.get('x-correlation-id')}]`);
    }
    return await response.json() as unknown;
  }
  return { request, read, requests };
}

export function count(env: ProductEnv) {
  return new DurableObjectUsageLedger(env.API_KEY_USAGE).peekMonthly(workspace, 1000).then(result => result.count);
}

export async function metered<T>(env: ProductEnv, check: (read: ReturnType<typeof verificationClient>['read']) => Promise<T>) {
  const client = verificationClient(env), before = await count(env);
  const result = await check(client.read);
  const after = await count(env);
  if (!client.requests.length || after - before !== client.requests.length) throw new Error('Workspace usage differs from successful product retrievals.');
  return { result, requests: client.requests, before, after };
}
