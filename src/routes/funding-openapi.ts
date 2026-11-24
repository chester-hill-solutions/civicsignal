import { z } from 'zod';
import { FundingCatalogueCoverage, FundingLookupResponse, FundingSearchResponse, FundingVersionsResponse } from '../corpora/funding';
import { FundingCoverageQuery, FundingListQuery, FundingLookupQuery, FundingVersionsQuery,
  FUNDING_API_PATH, FUNDING_OPENAPI_PATH } from './funding';
import { SOURCE_FEED_ERROR_CODES, SourceFeedErrorSchema } from './source-feed-contract';

function response(description: string, schema: z.ZodType) {
  const { $schema, ...document } = z.toJSONSchema(schema);
  return { description, content: { 'application/json': { schema: document } } };
}
function queryParameters(shape: Record<string, z.ZodType>) {
  return Object.entries(shape).map(([name, schema]) => ({ name, in: 'query', required: !schema.safeParse(undefined).success,
    schema: z.toJSONSchema(schema, { io: 'input' }) }));
}
const errors = Object.fromEntries(Object.entries(SOURCE_FEED_ERROR_CODES).map(([status, codes]) => [status,
  response(`The request failed with HTTP ${status}.`, SourceFeedErrorSchema.extend({ code: z.enum(codes) }))]));
const idParameter = { in: 'path', name: 'id', required: true,
  schema: { type: 'string', pattern: '^(nserc|esdc)-[a-z0-9]+(?:-[a-z0-9]+)*$' } };

export function fundingOpenApi() {
  const paths = {
    [FUNDING_OPENAPI_PATH]: { get: { operationId: 'getFundingOpenApi', summary: 'Discover the funding programme API',
      security: [],
      responses: { 200: { description: 'OpenAPI 3.1 contract document.', content: { 'application/json': { schema: { type: 'object' } } } } } } },
    [FUNDING_API_PATH]: { get: { operationId: 'searchFundingProgrammes', summary: 'Search current funding programme records',
      description: 'Requires source and language. Search performs a case and accent insensitive literal match over indexed title, status, and cited section text. Each result includes the matching cited section and a snippet capped at 260 characters; when only title or status matched, the programme page is cited. Status values are open, closed, upcoming, ongoing, invitation-only, or unknown. Pagination uses offset (default 0) and limit (default 25, maximum 100); send the returned revision on the next request to reject pages after an inventory refresh.',
      parameters: queryParameters(FundingListQuery.shape),
      responses: { 200: response('Current programme editions, with citation for each match.', FundingSearchResponse), ...errors } } },
    [`${FUNDING_API_PATH}/coverage`]: { get: { operationId: 'getFundingCoverage', summary: 'Inspect a publisher inventory',
      description: 'Requires source. Returns both index URLs, observation time, inventory revision, counts per language split between published searchable editions and metadata-only editions, and known coverage gaps. Empty categories are represented by zero counts; the gaps array may be empty.',
      parameters: queryParameters(FundingCoverageQuery.shape),
      responses: { 200: response('Observed inventory coverage.', FundingCatalogueCoverage), ...errors } } },
    [`${FUNDING_API_PATH}/{id}`]: { get: { operationId: 'getFundingProgramme', summary: 'Look up a programme edition',
      description: 'The source is derived from the nserc- or esdc- identifier prefix. An unknown identifier in a published source inventory returns item=null. statusText may also be null when the publisher gives no status wording. Exact lookup returns all captured cited sections.',
      parameters: [idParameter, ...queryParameters(FundingLookupQuery.shape)],
      responses: { 200: response('Current edition or null when it is absent.', FundingLookupResponse), ...errors } } },
    [`${FUNDING_API_PATH}/{id}/versions`]: { get: { operationId: 'listFundingProgrammeVersions', summary: 'List observed programme history',
      description: 'Returns added, changed, and removed observations for one identifier and language, newest first. A removed event retains the last observed edition. Offset defaults to 0 and limit to 25 (maximum 100); include the response revision on subsequent pages to reject pagination after the inventory changes.',
      parameters: [idParameter, ...queryParameters(FundingVersionsQuery.shape)],
      responses: { 200: response('Paged version history.', FundingVersionsResponse), ...errors } } },
  };
  return { openapi: '3.1.0', info: { title: 'CivicSignal funding programmes', version: '0.1.0' },
    components: { securitySchemes: { workspaceKey: { type: 'http', scheme: 'bearer', description: 'Workspace key with civicsignal.retrieve.' } } },
    security: [{ workspaceKey: [] }], paths };
}
