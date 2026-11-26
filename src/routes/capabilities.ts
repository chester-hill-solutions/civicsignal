import { CORPUS_POLICIES } from '../corpora/policies';
import { loadD1CorpusPublication } from '../corpora/registry';
import type { CorpusAvailabilityMap } from '../corpora/types';
import { ENCODER_CONTRACT, type EncoderContract } from '../encoder';
import { corsHeaders } from '../http';
import type { Env } from '../types';
import { discoveryContext, discoverSources, statuteSource, type DiscoverySource } from './discovery-sources';
import { apprenticeshipQuestions, type ResearchQuestion } from './discovery-questions';
import { AGENT_GUIDE, AUTH_GUIDE } from './agent-guides';

export interface Capabilities {
  sources: DiscoverySource[];
  researchQuestions: ResearchQuestion[];
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

function policyAvailable(id: string, sources: DiscoverySource[]) {
  return sources.some(source => source.status === 'available' && (source.id === id || (id === 'bills-canada' &&
    (source.id === 'bill-trace' || (source.id === 'parliament' && source.editions.some(row => row.scope.startsWith('bills/')))))));
}

/** Only verified, populated v1 corpora appear as supported coverage. */
function buildCapabilities(env: Env, origin: string, availability: CorpusAvailabilityMap, sources: DiscoverySource[]): Capabilities {
  const baseUrl = origin.replace(/\/$/, '');
  const statutes = availability['statutes-canada'];
  const populated = sources.some(source => source.id === 'statutes-canada' && source.status === 'available');
  const semantic = populated && Boolean(env.VECTORIZE && env.ENCODER_TOKEN && (env.ENCODER_SERVICE || env.ENCODER_URL));
  const endpoints: Capabilities['endpoints'] = [];
  const tools: Capabilities['mcp']['tools'] = [];
  if (populated) {
    endpoints.push({ path: '/api/statutes', description: semantic ? 'Look up a federal provision or search by topic.' : 'Look up an exact federal act and section.' });
    endpoints.push({ path: '/api/brief', description: 'Federal statute brief with explicit unavailable and excluded coverage. Exact citations are resolved structurally.' });
    endpoints.push({ path: '/api/changes', description: 'Bounded, paginated metadata for observed statute corpus changes; no full text.' });
    tools.push({ name: 'cite_provision', description: 'Resolve a federal statute provision exactly, including repealed provisions.' });
    tools.push({ name: 'statute_changes', description: 'Read observed federal statute corpus changes, with source citations and provenance.' });
  }
  if (semantic) {
    endpoints.push({ path: '/api/chat', description: 'Cited federal statute chat using the caller\'s generation key. Retrieval uses the CivicSignal key.' });
    tools.push({ name: 'brief_topic', description: 'Build a cited federal statute brief.' });
    tools.push({ name: 'statute_lookup', description: 'Search the current federal statute corpus in English or French.' });
  }
  if (populated && env.VECTORIZE) {
    endpoints.push({ path: '/api/match', description: 'Nearest vector matches using the published 768-dimension encoder contract; matches do not assert answerability.' });
  }
  const listed = new Set(endpoints.map(endpoint => endpoint.path));
  for (const source of sources) {
    for (const edition of source.editions) {
      const path = edition.request.split('?')[0];
      if (path && !listed.has(path)) {
        endpoints.push({ path, description: source.name + '. See sources for supported editions and examples.' });
        listed.add(path);
      }
    }
  }
  return {
    sources, researchQuestions: apprenticeshipQuestions(sources),
    product: env.PRODUCT_NAME ?? 'CivicSignal',
    description: 'Canadian federal policy research. Use sources for queryable editions, dates, example requests and API specifications on this deployment.',
    baseUrl, version: '1.0.0-rc', encoder: ENCODER_CONTRACT,
    pricing: {
      model: 'metered successful retrievals', freeMonthlyAllowance: Number(env.FREE_MONTHLY_ALLOWANCE ?? 1000),
      unitPriceUsd: null, billing: 'Workspace usage ledger; paid pricing is determined by the configured billing plan.',
      note: 'One unit per successful HTTP retrieval or MCP retrieval tool call. Validation and retrieval failures, plus MCP initialization, discovery and notifications, consume no units. A lost usage acknowledgement can return USAGE_UNAVAILABLE with uncertain:true and operationId after a unit was committed. Monthly allowance is shared across workspace keys.',
    },
    coverage: CORPUS_POLICIES.filter((policy) => policy.id === 'statutes-canada' && populated).map((policy) => ({
      corpusId: policy.id, title: policy.title, publisher: policy.publisher, licence: policy.licence,
      licenceUrl: policy.licenceUrl, redistribution: policy.redistribution, attribution: policy.attribution,
      conditions: policy.conditions, rowCount: statutes?.rowCount ?? 0, revision: statutes?.revision,
      parserVersion: statutes?.parserVersion, asOf: statutes?.asOf, lastRunAt: statutes?.lastRunAt,
    })),
    unavailableCoverage: CORPUS_POLICIES.filter(policy => !policyAvailable(policy.id, sources)).map((policy) => ({
      corpusId: policy.id, title: policy.title,
      reason: 'No queryable edition was verified on this deployment.',
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

export async function deploymentCapabilities(env: Env, origin: string): Promise<Capabilities> {
  const [publication, context] = await Promise.all([loadD1CorpusPublication(env.CIVIC_DB), discoveryContext(env)]);
  const [statutes, previews] = await Promise.all([statuteSource(context, publication.availability['statutes-canada']), discoverSources(context)]);
  return buildCapabilities(env, origin, publication.availability, [statutes, ...previews]);
}

export async function capabilitiesResponse(env: Env, origin: string, correlationId: string): Promise<Response> {
  return new Response(JSON.stringify(await deploymentCapabilities(env, origin), null, 2), {
    headers: { 'content-type': 'application/json; charset=UTF-8', ...corsHeaders(env, null, correlationId) },
  });
}

function sourceInstructions(source: DiscoverySource): string {
  if (source.status !== 'available') return `- ${source.name} (${source.status})`;
  const rows = source.editions.map(row => {
    const dates = [row.observedAt && 'observed ' + row.observedAt, row.publishedAt && 'published locally ' + row.publishedAt,
      row.coverageThrough && 'coverage through ' + row.coverageThrough, row.latestRecordDate && 'latest record ' + row.latestRecordDate];
    return `  - ${row.scope} (${row.language}), ${dates.filter(Boolean).join(', ') || 'freshness unknown'}. GET ${row.request}`;
  });
  return [`- ${source.name}. ${source.question}`, ...rows, ...(source.openapi ? ['  - OpenAPI: ' + source.openapi] : [])].join('\n');
}

export function llmsTxt(caps: Capabilities): string {
  return [`# ${caps.product}`, '',
    `Start with [live capabilities](${caps.baseUrl}/.well-known/civicsignal.json). Resolve request paths on this API origin.`,
    `[Agent guide](${caps.baseUrl}${AGENT_GUIDE}) and [authentication](${caps.baseUrl}${AUTH_GUIDE}).`,
    'Use only available editions. Dates describe the stored records. Recheck the official source for later changes.',
    'Discovery is public and free. Retrieval requires Authorization: Bearer <workspace API key> with civicsignal.retrieve.',
    caps.pricing.note, '', '## Sources', ...caps.sources.map(sourceInstructions), '', '## Research questions',
    ...caps.researchQuestions.flatMap(q => [`- ${q.question} (${q.status})`,
      ...q.steps.map(step => `  - ${step.instruction} GET ${step.request}`),
      ...(q.missingSources.length ? ['  - Missing coverage: ' + q.missingSources.join(', ')] : []), '  - ' + q.limits]),
    '', `Statute MCP tools at ${caps.mcp.url}: ${caps.mcp.tools.map(tool => tool.name).join(', ') || 'none available'}.`,
    ...(caps.endpoints.some(e => e.path === '/api/chat') ? ['Chat also requires X-CivicSignal-BYOK-Provider and X-CivicSignal-BYOK-Key.'] : []),
    'Consult each available source’s OpenAPI document for supported filters, lookup operations, and citation fields.', '',
  ].join('\n');
}
