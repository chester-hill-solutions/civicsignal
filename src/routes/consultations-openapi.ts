import { z } from 'zod';
import {
  ConsultationCoverageSchema, ConsultationLookupResponseSchema, ConsultationSearchResponseSchema,
} from '../corpora/consultations';
import { CONSULTATIONS_API_PATH, CONSULTATIONS_OPENAPI_PATH, ConsultationCoverageQuery,
  ConsultationLookupQuery, ConsultationSearchQuery } from './consultations';
import { SOURCE_FEED_ERROR_CODES, SourceFeedErrorSchema } from './source-feed-contract';

function response(description: string, schema: z.ZodType) {
  const { $schema, ...document } = z.toJSONSchema(schema);
  return { description, content: { 'application/json': { schema: document } } };
}

function queryParameters(shape: Record<string, z.ZodType>) {
  return Object.entries(shape).map(([name, schema]) => ({
    name, in: 'query', required: !schema.safeParse(undefined).success,
    schema: z.toJSONSchema(schema, { io: 'input' }),
  }));
}

const errors = Object.fromEntries(Object.entries(SOURCE_FEED_ERROR_CODES).map(([status, codes]) => [status,
  response(`The request failed with HTTP ${status}.`, SourceFeedErrorSchema.extend({ code: z.enum(codes) }))]));
const idParameter = { in: 'path', name: 'id', required: true,
  schema: { type: 'string', pattern: '^[a-z0-9.-]+_[a-z0-9.-]+$' } };

export function consultationsOpenApi() {
  const paths = {
    [CONSULTATIONS_OPENAPI_PATH]: { get: { operationId: 'getConsultationsOpenApi',
      summary: 'Discover the federal consultations API', security: [],
      responses: { 200: { description: 'OpenAPI 3.1 contract document.',
        content: { 'application/json': { schema: { type: 'object' } } } } } } },
    [CONSULTATIONS_API_PATH]: { get: { operationId: 'searchConsultations',
      summary: 'Search Government of Canada consultations',
      description: 'Searches the selected language edition for a literal phrase. Results are ranked with title matches first and descriptions are capped at 400 characters. State is computed from inclusive UTC start and end dates at asOf.',
      parameters: queryParameters(ConsultationSearchQuery.shape),
      responses: { 200: response('Matching consultations.', ConsultationSearchResponseSchema), ...errors } } },
    [`${CONSULTATIONS_API_PATH}/coverage`]: { get: { operationId: 'getConsultationCoverage',
      summary: 'Inspect consultation catalogue coverage',
      parameters: queryParameters(ConsultationCoverageQuery.shape),
      responses: { 200: response('Catalogue coverage and completeness counts.', ConsultationCoverageSchema), ...errors } } },
    [`${CONSULTATIONS_API_PATH}/{id}`]: { get: { operationId: 'getConsultation',
      summary: 'Look up a consultation and its revisions',
      description: 'When the optional local notice store is configured, the response includes only participation notice editions matching the current catalogue revision, consultation ID, and language. Fetched sections include their original heading, source citation, and a verbatim bounded excerpt.',
      parameters: [idParameter, ...queryParameters(ConsultationLookupQuery.shape)],
      responses: { 200: response('Current consultation record and newest-first revision history.', ConsultationLookupResponseSchema), ...errors } } },
  };
  return { openapi: '3.1.0', info: { title: 'CivicSignal Government of Canada consultations', version: '0.1.0' },
    components: { securitySchemes: { workspaceKey: { type: 'http', scheme: 'bearer',
      description: 'Workspace key with civicsignal.retrieve.' } } },
    security: [{ workspaceKey: [] }], paths };
}
