import { attributionFor } from '@chester-hill-solutions/corpus';
import { z } from 'zod';
import { CANADA_GAZETTE } from '../corpora/policies';
import { gazetteRecordId } from '../corpora/gazette';
import { sourceFeedOperation } from './source-feed-openapi';
import {
  GAZETTE_ERROR_CODES, GAZETTE_PATHS,
  GazetteErrorSchema, GazetteRecordSchema, GazetteSearchSchema,
  GazetteAnyLookupResponseSchema, GazetteAnySearchResponseSchema,
} from './gazette-contract';

const example = {
  id: gazetteRecordId({ part: 'I', language: 'en', issueDate: '2026-04-25', volume: 160, issueNumber: 17 }, 'reg1'), part: 'I', language: 'en',
  issueDate: '2026-04-25', volume: 160, issueNumber: 17, kind: 'proposal',
  title: 'Order Amending the Export Control List',
  citationUrl: 'https://gazette.gc.ca/rp-pr/p1/2026/2026-04-25/html/reg1-eng.html',
  source: CANADA_GAZETTE.publisher,
  redistribution: 'metadata-only', attribution: attributionFor(CANADA_GAZETTE),
} satisfies z.input<typeof GazetteRecordSchema>;

function jsonSchema(schema: z.ZodType, input = false) {
  const { $schema, ...document } = z.toJSONSchema(schema, { io: input ? 'input' : 'output' });
  return document;
}

function response(description: string, schema: z.ZodType, exampleValue?: unknown) {
  return { description, content: { 'application/json': { schema: jsonSchema(schema),
    ...(exampleValue === undefined ? {} : { example: exampleValue }) } } };
}

export function gazetteOpenApi() {
  const errors = Object.fromEntries(Object.entries(GAZETTE_ERROR_CODES).map(([status, codes]) => [status,
    response(`Request failed with ${status}.`, GazetteErrorSchema.extend({ code: z.enum(codes) }))]));
  const queryExamples: Record<keyof typeof GazetteSearchSchema.shape, string | number> = {
    topic: 'export control', part: 'I', language: 'en', editionType: 'regular', since: '2026-04-20', until: '2026-04-26', limit: 20,
  };
  const parameters = Object.entries(GazetteSearchSchema.shape).map(([field, schema]) => ({
    name: field, in: 'query', required: !schema.isOptional(), schema: jsonSchema(schema, true),
    example: queryExamples[field as keyof typeof queryExamples],
  }));
  const searchErrors = { ...errors };
  delete searchErrors['404'];
  const coverageExample = { part: 'I', language: 'en', available: true,
    issues: [{ issueDate: '2026-04-25', volume: 160, issueNumber: 17, recordCount: 22 }] };
  return {
    openapi: '3.1.0',
    info: { title: 'CivicSignal Canada Gazette API', version: '0.1.0',
      description: 'Metadata-only search of Canada Gazette Parts I and II. Responses include explicit edition coverage. The API returns titles, dates, identifiers and official links; it does not return Gazette article or instrument text.' },
    servers: [{ url: '/' }],
    security: [{ workspaceKey: [] }],
    components: { securitySchemes: { workspaceKey: { type: 'http', scheme: 'bearer',
      description: 'Workspace API key with the civicsignal.retrieve capability.' } } },
    paths: {
      '/api/gazette/changes': sourceFeedOperation('gazette'),
      [GAZETTE_PATHS.search]: { get: {
        operationId: 'searchCanadaGazette', summary: 'Search Canada Gazette metadata',
        description: 'Search record titles in a selected language and optional Gazette part and inclusive publication date range. Omit editionType or set it to regular for regular editions; set it to extra to search separately numbered extra editions. Coverage reports persisted issue dates for each requested part. A valid search consumes one workspace unit.',
        parameters,
        responses: { 200: response('Metadata records and per-part coverage.', GazetteAnySearchResponseSchema,
          { items: [example], count: 1, coverage: [coverageExample] }), ...searchErrors },
      } },
      [`${GAZETTE_PATHS.search}/{id}`]: { get: {
        operationId: 'getCanadaGazetteRecord', summary: 'Look up a Gazette record by ID',
        description: 'Resolve an ID returned by search and return the current metadata and official source link. The lookup includes coverage for the record’s issue. A successful lookup consumes one workspace unit.',
        parameters: [{ name: 'id', in: 'path', required: true,
          schema: jsonSchema(GazetteRecordSchema.shape.id, true), example: example.id }],
        responses: { 200: response('Metadata record and issue coverage.', GazetteAnyLookupResponseSchema,
          { item: example, coverage: coverageExample }), ...errors },
      } },
    },
    'x-source-policy': { redistribution: CANADA_GAZETTE.redistribution,
      attribution: attributionFor(CANADA_GAZETTE) },
  };
}
