import { z } from 'zod';
import { hansardSourceIdPattern, hansardSpeechIdPattern, type HansardChamber } from '../corpora/hansard';
import { HANSARD_FEDERAL, HANSARD_SENATE } from '../corpora/policies';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../corpora/types';

export const HANSARD_PATHS = {
  house: '/api/debates/house',
  senate: '/api/debates/senate',
} as const satisfies Record<HansardChamber, string>;
export const HANSARD_OPENAPI_PATH = '/api/debates/openapi.json';

const edition = z.enum(['en', 'fr']);
const sittingDate = z.iso.date();

export const HansardSearchSchema = z.strictObject({
  topic: z.string().trim().min(1).max(300).describe('Literal phrase, matched without regard to accents or case.'),
  language: edition.describe('Language of the published transcript edition.'),
  since: sittingDate.optional().describe('First sitting date to include.'),
  until: sittingDate.optional().describe('Last sitting date to include.'),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe('Maximum number of results.'),
}).refine(({ since, until }) => !since || !until || since <= until, {
  path: ['until'], message: 'until must be on or after since.',
});

export function hansardSpeechIdSchema(chamber?: HansardChamber) {
  return z.string().max(256).regex(hansardSpeechIdPattern(chamber)).describe('Speech ID returned by search.');
}

const fields = {
  language: edition,
  sittingId: z.string().regex(hansardSourceIdPattern),
  interventionId: z.string().regex(hansardSourceIdPattern),
  sittingDate,
  speaker: z.string().min(1),
  party: z.string().min(1).optional(),
  citationUrl: z.url({ protocol: /^https$/ }),
  source: z.string().min(1),
  redistribution: z.literal('cite-only'),
  attribution: z.string().min(1),
};

export const HansardSpeechSchema = z.discriminatedUnion('chamber', [
  z.strictObject({ ...fields, chamber: z.literal('house'), corpusId: z.literal('hansard-federal'),
    id: hansardSpeechIdSchema('house'), citationGranularity: z.literal('intervention'),
    excerpt: z.string().min(1).max(HANSARD_FEDERAL.excerptMaxChars) }),
  z.strictObject({ ...fields, chamber: z.literal('senate'), corpusId: z.literal('hansard-senate'),
    id: hansardSpeechIdSchema('senate'), citationGranularity: z.literal('section'),
    excerpt: z.string().min(1).max(HANSARD_SENATE.excerptMaxChars) }),
]);

export const HansardSearchResponseSchema = z.strictObject({
  items: z.array(HansardSpeechSchema).max(MAX_LIMIT),
  count: z.number().int().min(0).max(MAX_LIMIT),
});

export const HansardLookupResponseSchema = z.strictObject({ item: HansardSpeechSchema });

export const HANSARD_ERROR_CODES = {
  400: ['INVALID_ARGUMENT'],
  401: ['KEY_REQUIRED', 'KEY_INVALID'],
  403: ['WRONG_KEY_KIND', 'CAPABILITY_REQUIRED', 'WORKSPACE_DISABLED'],
  404: ['NOT_FOUND'],
  405: ['METHOD_NOT_ALLOWED'],
  429: ['FUSE_EXCEEDED'],
  501: ['UNSUPPORTED_COVERAGE'],
  502: ['UPSTREAM_UNAVAILABLE'],
  503: ['AUTH_UNAVAILABLE', 'RETRIEVAL_UNAVAILABLE', 'USAGE_UNAVAILABLE'],
} as const;

export const HansardErrorSchema = z.strictObject({
  code: z.enum(Object.values(HANSARD_ERROR_CODES).flat()),
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

export type HansardSearchRequest = z.output<typeof HansardSearchSchema>;
export type HansardSpeech = z.output<typeof HansardSpeechSchema>;
export type HansardSearchResponse = z.output<typeof HansardSearchResponseSchema>;
export type HansardLookupResponse = z.output<typeof HansardLookupResponseSchema>;
export type HansardError = z.output<typeof HansardErrorSchema>;
