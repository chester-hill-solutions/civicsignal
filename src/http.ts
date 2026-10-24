import type { Env } from './types';
import type { RetrievalObservation } from './corpora/retrieval-observation';
import { isByokProvider, type GenerationFailure } from './byok';

/** CORS + security headers, in one place so every route agrees. */
export function resolveCorsOrigin(
  env: Env,
  origin: string | null,
): { allowOrigin: string; allowCredentials: boolean } {
  const allowlist = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (allowlist.length === 0) {
    return { allowOrigin: origin ?? '*', allowCredentials: false };
  }
  if (origin && allowlist.includes(origin)) {
    return { allowOrigin: origin, allowCredentials: true };
  }
  return { allowOrigin: allowlist[0] ?? '*', allowCredentials: false };
}

export function securityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
  };
}

export function corsHeaders(
  env: Env,
  origin: string | null,
  correlationId: string,
): Record<string, string> {
  const cors = resolveCorsOrigin(env, origin);
  return {
    'Access-Control-Allow-Origin': cors.allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Accept, Content-Type, Authorization, X-Api-Key, X-Correlation-ID, X-CivicSignal-BYOK-Provider, X-CivicSignal-BYOK-Key, X-CivicSignal-Evaluation, Mcp-Method, Mcp-Name, Mcp-Protocol-Version',
    'Vary': 'Origin',
    'Access-Control-Max-Age': '86400',
    ...(cors.allowCredentials ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
    'X-Correlation-ID': correlationId,
    ...securityHeaders(),
  };
}

/** A malformed or oversized caller body, safe to expose without logging input. */
export class RequestInputError extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) {
    super(message);
    this.name = 'RequestInputError';
  }
}

/** Bound bytes before decoding JSON, including when Content-Length is absent or false. */
export async function readJsonBody(request: Request, maxBytes = 128 * 1024): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length !== null && Number(length) > maxBytes) {
    throw new RequestInputError(`The request body must not exceed ${maxBytes} bytes.`, 413);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RequestInputError('The body must be JSON.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RequestInputError(`The request body must not exceed ${maxBytes} bytes.`, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
  } catch {
    throw new RequestInputError('The body must be valid UTF-8 JSON.');
  }
}

export function jsonResponse(
  body: unknown,
  env: Env,
  origin: string | null,
  correlationId: string,
  status = 200,
): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      ...corsHeaders(env, origin, correlationId),
    },
  });
}

export function errorResponse(
  code: string,
  message: string,
  env: Env,
  origin: string | null,
  correlationId: string,
  status = 400,
  retrieval?: readonly RetrievalObservation[],
  generation?: GenerationFailure,
): Response {
  // Copy only the bounded public contract, never Error fields or provider data.
  const phases: readonly GenerationFailure['phase'][] = ['request-serialization','transport','upstream-http','response-body',
    'response-parse','timeout','cancelled','response-validation'];
  const safeGeneration = generation && isByokProvider(generation.provider) && phases.includes(generation.phase)
    ? { generation: { provider: generation.provider, phase: generation.phase,
      ...(typeof generation.upstreamStatus === 'number' && Number.isInteger(generation.upstreamStatus) &&
        generation.upstreamStatus >= 100 && generation.upstreamStatus <= 599 ? { upstreamStatus: generation.upstreamStatus } : {}) } }
    : {};
  return jsonResponse(
    { error: message, code, correlationId, timestamp: Date.now(), ...(retrieval ? { retrieval } : {}), ...safeGeneration },
    env,
    origin,
    correlationId,
    status,
  );
}

export function newCorrelationId(): string {
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}
