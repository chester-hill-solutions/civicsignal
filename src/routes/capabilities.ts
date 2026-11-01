import { CORPUS_POLICIES } from '../corpora/policies';
import { loadCorpusAvailability } from '../corpora/registry';
import type { CorpusAvailabilityMap } from '../corpora/types';
import { ENCODER_CONTRACT, type EncoderContract } from '../encoder';
import { corsHeaders } from '../http';
import type { Env } from '../types';

export interface Capabilities {
  encoder: EncoderContract;
  product: string;
  description: string;
  baseUrl: string;
  version: string;
  pricing: {
    model: string;
    freeMonthlyAllowance: number;
    unitPriceUsd: number | null;
    billing: string;
    note: string;
  };
  coverage: {
    corpusId: string; title: string; publisher: string; licence: string; licenceUrl: string;
    redistribution: string; attribution: string; conditions: string[];
    rowCount: number; revision?: string; parserVersion?: string; asOf?: string; lastRunAt?: string;
  }[];
  unavailableCoverage: { corpusId: string; title: string; reason: string }[];
  auth: { serverKeys: string; browserKeys: string; oauth: string; header: string; capability: string };
  endpoints: { path: string; description: string }[];
  scopes: { parameter: string; format: string; values: string[]; note: string }[];
  mcp: { url: string; transport: string; tools: { name: string; description: string }[] };
  errors: { code: string; meaning: string }[];
}

/** Only verified, populated v1 corpora appear as supported coverage. */
export function buildCapabilities(env: Env, origin: string, availability: CorpusAvailabilityMap = {}): Capabilities {
  const baseUrl = (env.PUBLIC_API_BASE_URL ?? origin).replace(/\/$/, '');
  const statutes = availability['statutes-canada'];
  const populated = Boolean(env.CIVIC_DB && statutes?.available);
  const semantic = populated && Boolean(env.VECTORIZE && env.ENCODER_TOKEN && (env.ENCODER_SERVICE || env.ENCODER_URL));
  const endpoints: Capabilities['endpoints'] = [];
  const tools: Capabilities['mcp']['tools'] = [];
  if (populated) {
    endpoints.push({ path: '/api/brief', description: 'Federal statute brief with explicit unavailable and excluded coverage. Exact citations are resolved structurally.' });
    endpoints.push({ path: '/api/changes', description: 'Bounded, paginated metadata for observed statute corpus changes; no full text.' });
    tools.push({ name: 'cite_provision', description: 'Resolve a federal statute provision exactly, including repealed provisions.' });
    tools.push({ name: 'statute_changes', description: 'Read observed federal statute corpus changes, with source citations and provenance.' });
  }
  if (semantic) {
    endpoints.push({ path: '/api/statutes', description: 'Search current federal statutes and regulations by topic in English or French.' });
    endpoints.push({ path: '/api/chat', description: 'Cited federal statute chat using the caller\'s generation key. Retrieval uses the CivicSignal key.' });
    tools.push({ name: 'brief_topic', description: 'A federal statute brief; news, debate, bills, coverage tone and geography are unavailable in v1.' });
    tools.push({ name: 'statute_lookup', description: 'Search the current federal statute corpus in English or French.' });
  }
  if (populated && env.VECTORIZE) {
    endpoints.push({ path: '/api/match', description: 'Nearest vector matches using the published 768-dimension encoder contract; matches do not assert answerability.' });
  }
  return {
    product: env.PRODUCT_NAME ?? 'CivicSignal',
    description: 'Cited retrieval of Canadian federal statutes and regulations in English and French. Corpus changes report observed source updates. News, debates, bills, provincial law, coverage tone and geographic filtering are unavailable in v1.',
    baseUrl, version: '1.0.0-rc', encoder: ENCODER_CONTRACT,
    pricing: {
      model: 'metered successful retrievals', freeMonthlyAllowance: Number(env.FREE_MONTHLY_ALLOWANCE ?? 1000),
      unitPriceUsd: null, billing: 'Workspace usage ledger; paid pricing is determined by the configured billing plan.',
      note: 'One unit per successful HTTP retrieval or MCP retrieval tool call. Validation and retrieval failures, plus MCP initialization, discovery and notifications, consume no units. A lost usage acknowledgement can return USAGE_UNAVAILABLE with uncertain:true and operationId after a unit was committed. Monthly allowance is shared across workspace keys.',
    },
    coverage: CORPUS_POLICIES.filter((policy) => policy.id === 'statutes-canada' && populated).map((policy) => ({
      corpusId: policy.id, title: policy.title, publisher: policy.publisher, licence: policy.licence,
      licenceUrl: policy.licenceUrl, redistribution: policy.redistribution, attribution: policy.attribution,
      conditions: policy.conditions, rowCount: statutes!.rowCount ?? 0, revision: statutes!.revision,
      parserVersion: statutes!.parserVersion, asOf: statutes!.asOf, lastRunAt: statutes!.lastRunAt,
    })),
    unavailableCoverage: CORPUS_POLICIES.filter((policy) => policy.id !== 'statutes-canada' || !populated).map((policy) => ({
      corpusId: policy.id, title: policy.title,
      reason: policy.id === 'statutes-canada' ? statutes?.reason ?? 'A non-empty published corpus has not been verified.' : 'No production ingestion is available for this corpus in v1.',
    })),
    auth: {
      serverKeys: 'Authorization: Bearer <workspace API key>', browserKeys: 'Public pk_ keys are not accepted. Keep server keys out of public browser code.',
      oauth: 'OAuth is not exposed by this v1 service.', header: 'Authorization', capability: 'civicsignal.retrieve',
    },
    endpoints, scopes: [{ parameter: 'scope', format: 'topic or jurisdiction:CA', values: ['topic', 'jurisdiction:CA'],
      note: 'Only the current Canadian federal corpus is supported. Provincial, riding, municipality and region filtering are rejected. Use the change feed for dated source changes.' }],
    mcp: { url: `${baseUrl}/mcp`, transport: 'streamable-http', tools },
    errors: [
      { code: 'KEY_REQUIRED', meaning: 'No Bearer API key was presented.' },
      { code: 'KEY_INVALID', meaning: 'The API key is unknown or revoked.' },
      { code: 'CAPABILITY_REQUIRED', meaning: 'The key does not permit corpus retrieval.' },
      { code: 'FUSE_EXCEEDED', meaning: 'The workspace monthly allowance is exhausted.' },
      { code: 'USAGE_UNAVAILABLE', meaning: 'Usage could not be confirmed. When uncertain:true, a unit may already be committed; retain operationId and month for reconciliation.' },
      { code: 'INVALID_ARGUMENT', meaning: 'Fix the request and retry.' },
      { code: 'UNSUPPORTED_COVERAGE', meaning: 'This corpus, date filter or geography is unavailable; no retrieval is billed.' },
      { code: 'RETRIEVAL_UNAVAILABLE', meaning: 'The required retrieval backend is unavailable.' },
    ],
  };
}

export async function capabilitiesResponse(env: Env, origin: string, correlationId: string): Promise<Response> {
  const availability = await loadCorpusAvailability({ db: env.CIVIC_DB, fetch, now: () => new Date() });
  return new Response(JSON.stringify(buildCapabilities(env, origin, availability), null, 2), {
    headers: { 'content-type': 'application/json; charset=UTF-8', ...corsHeaders(env, null, correlationId) },
  });
}

export function llmsTxt(env: Env, origin: string): string {
  const baseUrl = (env.PUBLIC_API_BASE_URL ?? origin).replace(/\/$/, '');
  return `# ${env.PRODUCT_NAME ?? 'CivicSignal'}

> Cited retrieval of Canadian federal statutes and regulations, in English and French.

This v1 provides authenticated, metered HTTP and MCP retrieval. Use
[live capabilities](${baseUrl}/.well-known/civicsignal.json) for verified corpus
population, revision, freshness and configured routes. A configured database alone
does not establish that a corpus is populated.

News, debate, bills, provincial law, coverage tone and geographic distribution are
unavailable in v1. Riding, municipality, region and provincial filters are rejected.
Statute search uses the current published corpus; it does not provide historical
versions or legal advice. Source revision dates are not a guarantee of legal currency.

The MCP endpoint is \`${baseUrl}/mcp\`. Use \`cite_provision\` when a question names
a provision. Where semantic retrieval is configured, \`statute_lookup\` and
\`brief_topic\` search federal law. \`statute_changes\` and \`${baseUrl}/api/changes\`
return paginated metadata for observed corpus changes, without full provision text.
See live capabilities for which tools are available on this deployment.

Send \`Authorization: Bearer <workspace API key>\` with capability
\`civicsignal.retrieve\`. Public browser keys and OAuth are unavailable. A successful
retrieval consumes one workspace unit. Validation and retrieval failures, plus MCP
bookkeeping, consume no units. A lost usage acknowledgement can return
\`USAGE_UNAVAILABLE\` with \`uncertain:true\` after a unit was committed. Retain its
\`operationId\` and \`month\` for reconciliation; a new request is a new operation.
BYOK chat additionally requires \`X-CivicSignal-BYOK-Provider\` and
\`X-CivicSignal-BYOK-Key\`. The generation key is sent only to that provider.

Statutes and regulations are reproduced under the Open Government Licence - Canada.
Every result carries its source citation and attribution. This is not an official
version of the law; consult the linked official source.
`;
}
