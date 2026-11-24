import { z } from 'zod';
import type { FeedSource } from '../corpora/source-feed';
import { CANADA_GAZETTE, HANSARD_FEDERAL, HANSARD_SENATE } from '../corpora/policies';
import {
  SOURCE_FEED_ERROR_CODES, SourceFeedErrorSchema, SourceFeedQuerySchema, SourceFeedResponseSchema,
} from './source-feed-contract';

const names: Record<FeedSource, string> = {
  gazette: 'Canada Gazette', house: 'House of Commons debates', senate: 'Senate debates',
};
const policies = { gazette: CANADA_GAZETTE, house: HANSARD_FEDERAL, senate: HANSARD_SENATE } as const;

function jsonSchema(schema: z.ZodType, input = false) {
  const { $schema, ...document } = z.toJSONSchema(schema, { io: input ? 'input' : 'output' });
  return document;
}

function response(description: string, schema: z.ZodType, example?: unknown) {
  return { description, content: { 'application/json': { schema: jsonSchema(schema),
    ...(example === undefined ? {} : { example }) } } };
}

export function sourceFeedOperation(source: FeedSource) {
  const displayName = names[source];
  const params = Object.entries(SourceFeedQuerySchema.shape)
    .filter(([name]) => source === 'gazette' || name !== 'part')
    .map(([name, schema]) => ({
      name, in: 'query', required: name === 'language', schema: jsonSchema(schema, true),
      ...(name === 'language' ? { example: 'en' } : {}),
      ...(name === 'topic' ? { example: 'railway' } : {}),
      ...(name === 'part' ? { example: 'I' } : {}),
      ...(name === 'limit' ? { example: 25 } : {}),
    }));
  const feedPolicy = policies[source];
  const errors = Object.fromEntries(Object.entries(SOURCE_FEED_ERROR_CODES).map(([status, codes]) => [status,
    response(`The request failed with HTTP ${status}.`, SourceFeedErrorSchema.extend({ code: z.enum(codes) }))]));
  const example = {
    events: [{ id: 204, kind: 'corrected', recordId: 'example-record', publicationDate: '2026-04-25',
      observedAt: '2026-04-26T12:00:00.000Z', citationUrl: 'https://example.gc.ca/record',
      label: 'Example record title', editionId: '2026-04-25', ...(source === 'gazette' ? { part: 'I' } : {}),
      matches: { before: true, after: true } }],
    nextCursor: 'opaque-cursor',
    scope: { source, language: 'en', editions: [{ editionId: '2026-04-25',
      ...(source === 'gazette' ? { part: 'I' } : {}), publicationDate: '2026-04-25', observedAt: '2026-04-26T12:00:00.000Z' }],
      publisher: feedPolicy.publisher, redistribution: feedPolicy.redistribution, attribution: feedPolicy.attribution },
    hasMore: false,
  };
  return { get: {
    operationId: `get${source === 'gazette' ? 'Gazette' : source === 'house' ? 'House' : 'Senate'}Changes`,
    summary: `Watch ${displayName} changes`,
    description: `Read a stable, ascending feed of added, corrected, and removed metadata from locally observed ${displayName} editions. Supply language and optionally a literal topic. Topic matching folds case and accents and checks either the before or after metadata; response events never include the matching text. Cursors are bound to this database journal and the source, language, Gazette part, and folded topic filters. Each successful response, including an empty poll, consumes one workspace unit. Invalid arguments and retrieval failures consume no units. Missing requested edition coverage returns 503; an available edition with no changes returns 200 with an empty events array. ${source === 'gazette' ? 'Omitting part requests both Gazette parts, so both must have coverage.' : ''}`,
    parameters: params,
    responses: {
      200: response('Changes, current edition coverage, source attribution, and a continuation cursor.', SourceFeedResponseSchema, example),
      ...errors,
    },
  } };
}
