import { CORPUS_POLICIES } from '../corpora/policies';
import { corsHeaders } from '../http';
import type { Env } from '../types';

/**
 * Machine-readable discovery.
 *
 * An agent should be able to learn what this service covers, what it costs, how to
 * authenticate and what its errors mean without reading prose. Everything a caller
 * needs is published so that nothing has to be scraped.
 */

export interface Capabilities {
  product: string;
  description: string;
  baseUrl: string;
  version: string;
  pricing: {
    model: string;
    freeMonthlyAllowance: number;
    unitPriceUsd: number;
    billing: string;
    note: string;
  };
  coverage: {
    corpusId: string;
    title: string;
    publisher: string;
    licence: string;
    licenceUrl: string;
    redistribution: string;
    attribution: string;
    conditions: string[];
  }[];
  auth: {
    serverKeys: string;
    browserKeys: string;
    oauth: string;
    header: string;
  };
  endpoints: { path: string; description: string }[];
  mcp: { url: string; transport: string; tools: { name: string; description: string }[] };
  errors: { code: string; meaning: string }[];
}

export function buildCapabilities(env: Env, origin: string): Capabilities {
  const baseUrl = (env.PUBLIC_API_BASE_URL ?? origin).replace(/\/$/, '');
  return {
    product: env.PRODUCT_NAME ?? 'CivicSignal',
    description:
      'Situational awareness for Canada. One call returns what is in the news about a topic, how coverage tone is moving, ' +
      'which statutes are in force, what bills are moving, and what Parliament has said — each cited to its official source.',
    baseUrl,
    version: '0.1.0',
    pricing: {
      model: 'metered',
      freeMonthlyAllowance: 1000,
      unitPriceUsd: 0.005,
      billing: 'prepaid credits; no subscription',
      note:
        'Free allowance resets each UTC calendar month and is shared across the workspace. ' +
        'Errors never count. Failed lookups become account credit.',
    },
    coverage: CORPUS_POLICIES.map((p) => ({
      corpusId: p.id,
      title: p.title,
      publisher: p.publisher,
      licence: p.licence,
      licenceUrl: p.licenceUrl,
      redistribution: p.redistribution,
      attribution: p.attribution,
      conditions: p.conditions,
    })),
    auth: {
      serverKeys: 'Authorization: Bearer sk_…',
      browserKeys: 'Authorization: Bearer pk_…',
      oauth: `${baseUrl}/auth.md`,
      header: 'Authorization',
    },
    endpoints: [
      { path: '/api/brief', description: 'The join: news, tone, statutes, bills and debate for one topic.' },
      { path: '/api/statutes', description: 'Statutes and regulations in force, with section text.' },
      { path: '/api/news', description: 'News items and the tone series for a topic.' },
      { path: '/api/bills', description: 'Bills and their stage.' },
      { path: '/api/debates', description: 'Cited debate passages.' },
    ],
    mcp: {
      url: `${baseUrl}/mcp`,
      transport: 'streamable-http',
      tools: [
        { name: 'brief_topic', description: 'One call: everything known about a topic in Canada.' },
        { name: 'statute_lookup', description: 'Statutes and regulations in force.' },
        { name: 'debate_citations', description: 'Cited passages from the House of Commons.' },
      ],
    },
    errors: [
      { code: 'KEY_REQUIRED', meaning: 'No API key was presented.' },
      { code: 'KEY_INVALID', meaning: 'The key is not recognised.' },
      { code: 'RATE_LIMIT_EXCEEDED', meaning: 'Too many requests for this key or IP.' },
      { code: 'FUSE_EXCEEDED', meaning: 'The workspace monthly allowance is exhausted.' },
      { code: 'INVALID_ARGUMENT', meaning: 'Fix the request and retry.' },
      { code: 'UNSUPPORTED_COVERAGE', meaning: 'The corpus does not cover this request — never a silent zero.' },
    ],
  };
}

export function capabilitiesResponse(env: Env, origin: string, correlationId: string): Response {
  return new Response(JSON.stringify(buildCapabilities(env, origin), null, 2), {
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      ...corsHeaders(env, null, correlationId),
    },
  });
}

export function llmsTxt(env: Env, origin: string): string {
  const baseUrl = (env.PUBLIC_API_BASE_URL ?? origin).replace(/\/$/, '');
  return `# ${env.PRODUCT_NAME ?? 'CivicSignal'}

> Situational awareness for Canada. Resolve any topic into what is being reported, how
> coverage tone is moving, which statutes are in force, what bills are moving, and what
> Parliament has said.

A metered HTTP API and a remote MCP server. Coverage is Canadian and federal, with
French and English source material, refreshed continuously.

## Documentation

- [Agent guide](${baseUrl}/docs/agents.md): connect over MCP and make a first brief.
- [Authentication](${baseUrl}/auth.md): credentials, scopes, and the free allowance.
- [API reference](${baseUrl}/docs): interactive reference for every route.

## Machine-readable

- [Capabilities, price and coverage](${baseUrl}/.well-known/civicsignal.json): what is covered, what it costs, how to authenticate, and the error codes.
- [Licence register](${baseUrl}/docs/licence-register.md): the reproduction regime of every corpus, and what that means for output.

## Endpoints

- Brief: ${baseUrl}/api/brief?topic=housing
- Statutes: ${baseUrl}/api/statutes?topic=housing
- News and tone: ${baseUrl}/api/news?topic=housing
- Bills: ${baseUrl}/api/bills?topic=housing
- Debate citations: ${baseUrl}/api/debates?topic=housing

## MCP

Add \`${baseUrl}/mcp\` to your MCP client. Three tools: \`brief_topic\`, \`statute_lookup\`,
\`debate_citations\`.

## Reproduction

Statutes and regulations are reproduced under the Open Government Licence - Canada.
Debates are Crown copyright and are quoted as short excerpts with citations, never
republished in full. News is headline and link only. Every item links to its official
source, and every response carries the attribution its licence requires.
`;
}
