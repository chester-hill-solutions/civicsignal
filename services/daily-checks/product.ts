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
  return new DurableObjectUsageLedger(env.API_KEY_USAGE).peekMonthly(workspace, 1000).then(result => {
    if (result.unavailable) throw new Error('Workspace usage unavailable.');
    return result.count;
  });
}

export type ProductClient = ReturnType<typeof verificationClient>;
export type Trace = { requests: ProductClient['requests']; before: number | null; after: number | null };
export type UsageMode = 'metered' | 'free';

export class ProductCheckFailure extends Error {
  constructor(readonly trace: Trace, readonly stage: 'meter' | 'product' | 'usage', cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Product verification failed.', { cause });
  }
}

/** Preserve the authenticated request trace even when a later reference or meter check fails. */
export async function observeProduct<T>(env: ProductEnv, mode: UsageMode, check: (client: ProductClient) => Promise<T>) {
  const client = verificationClient(env);
  let before: number | null = null, after: number | null = null;
  let stage: ProductCheckFailure['stage'] = 'meter';
  try {
    before = await count(env);
    stage = 'product';
    const result = await check(client);
    stage = 'meter';
    after = await count(env);
    stage = 'usage';
    const expected = mode === 'free' ? 0 : client.requests.length;
    if (!client.requests.length || after - before !== expected) throw new Error('Workspace usage differs from successful product retrievals.');
    return { result, requests: client.requests, before, after };
  } catch (error) {
    if (stage === 'product') after = await count(env).catch(() => null);
    throw new ProductCheckFailure({ requests:client.requests, before, after }, stage, error);
  }
}

export function metered<T>(env: ProductEnv, check: (read: ProductClient['read']) => Promise<T>) {
  return observeProduct(env, 'metered', client => check(client.read));
}
