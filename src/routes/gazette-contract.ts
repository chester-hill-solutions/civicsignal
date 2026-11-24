import { z } from 'zod';
import { GazetteMetadataSchema } from '../corpora/gazette';

export const GAZETTE_PATHS = { search: '/api/gazette' } as const;
export const GAZETTE_OPENAPI_PATH = '/api/gazette/openapi.json';

const date = z.iso.date();
const issue = z.strictObject({
  issueDate: date,
  volume: z.number().int().positive(),
  issueNumber: z.number().int().positive(),
  recordCount: z.number().int().nonnegative(),
});

export const GazetteSearchSchema = z.strictObject({
  topic: z.string().trim().min(1).max(300).describe('Words or phrase matched against Gazette metadata.'),
  part: z.enum(['I', 'II']).optional().describe('Gazette part; omit to search both parts.'),
  language: z.enum(['en', 'fr']).describe('Language of the published edition.'),
  since: date.optional().describe('First publication date to include.'),
  until: date.optional().describe('Last publication date to include.'),
  limit: z.number().int().min(1).max(100).default(20).describe('Maximum number of records.'),
}).refine(({ since, until }) => !since || !until || since <= until, {
  path: ['until'], message: 'until must be on or after since.',
});

export const GazetteRecordSchema = GazetteMetadataSchema.extend({
  source: z.string().min(1),
  redistribution: z.literal('metadata-only'),
  attribution: z.string().min(1),
});

export const GazetteCoverageSchema = z.strictObject({
  part: z.enum(['I', 'II']),
  language: z.enum(['en', 'fr']),
  available: z.boolean(),
  issues: z.array(issue),
});

export const GazetteSearchResponseSchema = z.strictObject({
  items: z.array(GazetteRecordSchema).max(100),
  count: z.number().int().min(0).max(100),
  coverage: z.array(GazetteCoverageSchema).min(1).max(2),
});

export const GazetteLookupResponseSchema = z.strictObject({
  item: GazetteRecordSchema,
  coverage: GazetteCoverageSchema,
});

export const GAZETTE_ERROR_CODES = {
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

export const GazetteErrorSchema = z.strictObject({
  code: z.enum(Object.values(GAZETTE_ERROR_CODES).flat()),
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

export type GazetteSearchRequest = z.output<typeof GazetteSearchSchema>;
export type GazetteRecordResponse = z.output<typeof GazetteRecordSchema>;
export type GazetteCoverage = z.output<typeof GazetteCoverageSchema>;
export type GazetteSearchResponse = z.output<typeof GazetteSearchResponseSchema>;
export type GazetteLookupResponse = z.output<typeof GazetteLookupResponseSchema>;
