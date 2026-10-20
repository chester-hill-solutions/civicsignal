import type { Env } from './types';

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
      'Accept, Content-Type, Authorization, X-Api-Key, X-Correlation-ID, Mcp-Method, Mcp-Name, Mcp-Protocol-Version',
    'Access-Control-Max-Age': '86400',
    ...(cors.allowCredentials ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
    'X-Correlation-ID': correlationId,
    ...securityHeaders(),
  };
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
): Response {
  return jsonResponse(
    { error: message, code, correlationId, timestamp: Date.now() },
    env,
    origin,
    correlationId,
    status,
  );
}

export function newCorrelationId(): string {
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}
