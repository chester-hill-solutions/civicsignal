import { z } from 'zod';
import type { FeedSource } from '../corpora/source-feed';

export const SOURCE_FEED_PATHS = {
  gazette: '/api/gazette/changes',
  house: '/api/debates/house/changes',
  senate: '/api/debates/senate/changes',
} as const satisfies Record<FeedSource, string>;

export const SourceFeedQuerySchema = z.strictObject({
  language: z.enum(['en', 'fr']).describe('Language of the watched editions.'),
  topic: z.string().trim().min(1).max(300).optional()
    .describe('Optional literal phrase matched case and accent insensitively against either side of a change.'),
  part: z.enum(['I', 'II']).optional().describe('Gazette part. Omit to include both parts.'),
  limit: z.number().int().min(1).max(100).default(25).describe('Maximum number of changes.'),
  cursor: z.string().max(4096).optional().describe('Opaque continuation cursor returned by the previous response.'),
});

export const SourceFeedEventSchema = z.strictObject({
  id: z.number().int().positive(),
  kind: z.enum(['added', 'corrected', 'removed']),
  recordId: z.string().min(1),
  publicationDate: z.iso.date(),
  observedAt: z.iso.datetime(),
  citationUrl: z.url({ protocol: /^https$/ }),
  label: z.string(),
  editionId: z.string().min(1),
  part: z.enum(['I', 'II']).optional(),
  matches: z.strictObject({ before: z.boolean(), after: z.boolean() }).optional()
    .describe('When topic is supplied, indicates which side of a correction matches it.'),
});

export const SourceFeedEditionSchema = z.strictObject({
  editionId: z.string().min(1),
  part: z.enum(['I', 'II']).optional(),
  publicationDate: z.iso.date(),
  observedAt: z.iso.datetime(),
});

export const SourceFeedResponseSchema = z.strictObject({
  events: z.array(SourceFeedEventSchema).max(100),
  nextCursor: z.string().min(1),
  scope: z.strictObject({
    source: z.enum(['gazette', 'house', 'senate']),
    language: z.enum(['en', 'fr']),
    editions: z.array(SourceFeedEditionSchema).min(1),
    publisher: z.string().min(1),
    redistribution: z.enum(['metadata-only', 'cite-only']),
    attribution: z.string().min(1),
  }),
  hasMore: z.boolean().describe('Whether another cursor page may contain changes.'),
});

export const SOURCE_FEED_ERROR_CODES = {
  400: ['INVALID_ARGUMENT'],
  401: ['KEY_REQUIRED', 'KEY_INVALID'],
  403: ['WRONG_KEY_KIND', 'CAPABILITY_REQUIRED', 'WORKSPACE_DISABLED'],
  405: ['METHOD_NOT_ALLOWED'],
  429: ['FUSE_EXCEEDED'],
  501: ['UNSUPPORTED_COVERAGE'],
  502: ['UPSTREAM_UNAVAILABLE'],
  503: ['AUTH_UNAVAILABLE', 'RETRIEVAL_UNAVAILABLE', 'USAGE_UNAVAILABLE'],
} as const;

export const SourceFeedErrorSchema = z.strictObject({
  code: z.enum(Object.values(SOURCE_FEED_ERROR_CODES).flat()),
  error: z.string(),
  correlationId: z.string(),
  timestamp: z.number().int().optional(),
  retrieval: z.array(z.unknown()).max(0).optional(),
  count: z.number().int().optional(),
  limit: z.number().int().optional(),
  month: z.string().optional(),
  operationId: z.string().optional(),
  uncertain: z.boolean().optional(),
});

export type SourceFeedRequest = z.output<typeof SourceFeedQuerySchema>;
export type SourceFeedEvent = z.output<typeof SourceFeedEventSchema>;
export type SourceFeedResponse = z.output<typeof SourceFeedResponseSchema>;
