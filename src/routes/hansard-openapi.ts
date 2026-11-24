import { attributionFor } from '@chester-hill-solutions/corpus';
import { z } from 'zod';
import { sourceFeedOperation } from './source-feed-openapi';
import { hansardPolicy, type HansardChamber } from '../corpora/hansard';
import {
  HANSARD_ERROR_CODES, HANSARD_PATHS, HansardErrorSchema, HansardLookupResponseSchema,
  HansardSearchResponseSchema, HansardSearchSchema, hansardSpeechIdSchema, type HansardSpeech,
} from './hansard-contract';

const exampleSpeech = {
  house: {
    id: 'hansard:en:45-1-109:13463397', chamber: 'house', corpusId: 'hansard-federal', language: 'en',
    sittingId: '45-1-109', interventionId: '13463397', sittingDate: '2026-04-23', speaker: 'Example Member',
    citationUrl: 'https://www.ourcommons.ca/DocumentViewer/en/45-1/house/sitting-109/hansard#Int-13463397',
    citationGranularity: 'intervention', excerpt: 'We discussed the proposed railway connection.',
  },
  senate: {
    id: 'senate-hansard:fr:45-1-67:8-1', chamber: 'senate', corpusId: 'hansard-senate', language: 'fr',
    sittingId: '45-1-67', interventionId: '8-1', sittingDate: '2026-04-23', speaker: 'La sénatrice Exemple',
    citationUrl: 'https://sencanada.ca/fr/content/sen/chamber/451/debates/067db_2026-04-23-f#8',
    citationGranularity: 'section', excerpt: 'Le réseau ferroviaire relierait les deux villes.',
  },
} as const satisfies Record<HansardChamber, Omit<HansardSpeech, 'source' | 'redistribution' | 'attribution'>>;

const errorDescriptions: Record<keyof typeof HANSARD_ERROR_CODES, string> = {
  400: 'Invalid search parameters or speech ID.',
  401: 'Missing, invalid, or revoked workspace API key.',
  403: 'Workspace or API key lacks access.',
  404: 'No speech with this ID in the requested edition.',
  405: 'This operation uses GET.',
  429: 'Workspace monthly allowance exhausted.',
  501: 'Hansard preview is disabled.',
  502: 'Retrieval could not complete.',
  503: 'Authorization, the requested edition, or usage confirmation is unavailable.',
};

function jsonSchema(schema: z.ZodType, input = false) {
  const { $schema, ...document } = z.toJSONSchema(schema, { io: input ? 'input' : 'output' });
  return document;
}

function response(description: string, schema: z.ZodType, example?: unknown) {
  return { description, content: { 'application/json': { schema: jsonSchema(schema),
    ...(example === undefined ? {} : { example }) } } };
}

function operations(chamber: HansardChamber) {
  const path = HANSARD_PATHS[chamber];
  const name = chamber === 'house' ? 'House of Commons' : 'Senate';
  const suffix = chamber === 'house' ? 'House' : 'Senate';
  const policy = hansardPolicy(chamber);
  const item: HansardSpeech = { ...exampleSpeech[chamber], source: policy.publisher,
    redistribution: 'cite-only', attribution: attributionFor(policy) };
  const failures = Object.fromEntries(Object.entries(HANSARD_ERROR_CODES).map(([key, codes]) => [key,
    response(errorDescriptions[Number(key) as keyof typeof HANSARD_ERROR_CODES], HansardErrorSchema.extend({ code: z.enum(codes) }))]));
  const { '404': notFound, ...searchFailures } = failures;
  const examples: Record<keyof typeof HansardSearchSchema.shape, string | number> = {
    topic: chamber === 'house' ? 'railway' : 'réseau', language: item.language, since: item.sittingDate, until: item.sittingDate, limit: 10,
  };
  const parameters = Object.entries(HansardSearchSchema.shape).map(([field, schema]) => ({
    name: field, in: 'query', required: !schema.isOptional(), schema: jsonSchema(schema, true),
    example: examples[field as keyof typeof examples],
  }));

  return {
    [`${path}/changes`]: sourceFeedOperation(chamber),
    [path]: { get: {
      operationId: `search${suffix}Hansard`, summary: `Search ${name} Hansard`,
      description: 'Search attributed excerpts in one edition. Dates are inclusive and since must precede or equal until. Results are ordered by sitting date, then speech ID, newest first. A valid search with no matches returns an empty list and consumes one workspace unit.',
      parameters,
      responses: { 200: response('Cited excerpts. The example uses synthetic text.', HansardSearchResponseSchema,
        { items: [item], count: 1 }), ...searchFailures },
    } },
    [`${path}/{speechId}`]: { get: {
      operationId: `get${suffix}HansardSpeech`, summary: `Look up a ${name} Hansard speech`,
      description: 'Resolve an ID returned by search and return its current excerpt and citation. A successful lookup consumes one workspace unit.',
      parameters: [{ name: 'speechId', in: 'path', required: true, schema: jsonSchema(hansardSpeechIdSchema(chamber), true), example: item.id }],
      responses: { 200: response('Cited excerpt. The example uses synthetic text.', HansardLookupResponseSchema, { item }),
        ...searchFailures, 404: notFound },
    } },
  };
}

export function hansardOpenApi() {
  return {
    openapi: '3.1.0',
    info: { title: 'CivicSignal Hansard API', version: '0.1.0',
      description: 'An opt-in preview of House and Senate Hansard. House links open individual interventions. Senate links open transcript sections, and structural corrections can shift Senate speech IDs.' },
    servers: [{ url: '/' }],
    security: [{ workspaceKey: [] }],
    components: { securitySchemes: { workspaceKey: { type: 'http', scheme: 'bearer',
      description: 'Workspace API key with the civicsignal.retrieve capability.' } } },
    paths: { ...operations('house'), ...operations('senate') },
  };
}
