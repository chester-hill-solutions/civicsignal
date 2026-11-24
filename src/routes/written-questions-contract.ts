import { z } from 'zod';
import {
  WrittenQuestionLanguageSchema, WrittenQuestionPassageSchema, WrittenQuestionRecordSchema,
  WrittenQuestionDocumentSchema, WrittenQuestionSearchKindSchema, WrittenQuestionAttributionSchema,
} from '../corpora/written-questions';

export const WRITTEN_QUESTIONS_PATHS = { search: '/api/written-questions' } as const;
export const WRITTEN_QUESTIONS_OPENAPI_PATH = '/api/written-questions/openapi.json';

const session = z.string().trim().regex(/^\d{1,2}-\d{1,2}$/u);
const questionNumber = z.number().int().positive();
const limit = z.number().int().min(1).max(100);

export const WrittenQuestionSearchSchema = z.strictObject({
  query: z.string().trim().min(1).max(256).describe('Words or quoted phrases matched in question or answer passage text.'),
  language: WrittenQuestionLanguageSchema.describe('Language of the question/record edition. A bilingual archival PDF can contribute shared text to both editions; per-file language is reported separately.'),
  session: session.optional().describe('Parliament-session key, such as 45-1.'),
  kind: WrittenQuestionSearchKindSchema.optional().describe('Limit matches to questions, reply sections, cover pages or attachments.'),
  limit: limit.default(20).describe('Maximum number of matching passages.'),
});

export const WrittenQuestionLookupResponseSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('not-found'), session, number: questionNumber, language: WrittenQuestionLanguageSchema,
  }),
  z.strictObject({
    state: z.literal('found'), question: WrittenQuestionRecordSchema, documents: z.array(WrittenQuestionDocumentSchema),
    answerState: z.enum(['available', 'partial', 'pending', 'gap', 'no-reply']),
  }),
]);

export const WrittenQuestionSearchResponseSchema = z.strictObject({
  items: z.array(WrittenQuestionPassageSchema).max(100),
  count: z.number().int().min(0).max(100),
  language: WrittenQuestionLanguageSchema,
  coverageBasis: z.literal('materialized-records'),
});

export const WrittenQuestionChunksResponseSchema = z.strictObject({
  session, number: questionNumber, language: WrittenQuestionLanguageSchema,
  documentKey: z.string().min(1), citationUrl: z.url({ protocol: /^https$/ }),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), attribution: WrittenQuestionAttributionSchema,
  fileLanguage: z.enum(['b', 'e', 'f']).nullable(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(20),
  total: z.number().int().nonnegative(), hasMore: z.boolean(),
  chunks: z.array(z.strictObject({ index: z.number().int().nonnegative(), text: z.string().min(1) })).max(20),
});

export const WrittenQuestionCoverageRowSchema = z.strictObject({
  session, language: WrittenQuestionLanguageSchema, questions: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(), pending: z.number().int().nonnegative(),
  questionGaps: z.number().int().nonnegative(), searchableReplies: z.number().int().nonnegative(),
  storedReplies: z.number().int().nonnegative(), replyGaps: z.number().int().nonnegative(),
  searchableAttachments: z.number().int().nonnegative(), storedAttachments: z.number().int().nonnegative(),
  attachmentGaps: z.number().int().nonnegative(),
});

export const WrittenQuestionCoverageResponseSchema = z.strictObject({
  coverage: z.array(WrittenQuestionCoverageRowSchema),
  basis: z.literal('materialized-records'),
});

export const WRITTEN_QUESTION_ERROR_CODES = {
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

export const WrittenQuestionErrorSchema = z.strictObject({
  code: z.enum(Object.values(WRITTEN_QUESTION_ERROR_CODES).flat()), error: z.string(), correlationId: z.string(),
  timestamp: z.number().int().optional(), retrieval: z.array(z.unknown()).max(0).optional(),
  count: z.number().int().optional(), limit: z.number().int().optional(), month: z.string().optional(),
  operationId: z.string().optional(), uncertain: z.boolean().optional(),
});

export type WrittenQuestionSearchRequest = z.output<typeof WrittenQuestionSearchSchema>;
export type WrittenQuestionLookupResponse = z.output<typeof WrittenQuestionLookupResponseSchema>;
export type WrittenQuestionSearchResponse = z.output<typeof WrittenQuestionSearchResponseSchema>;
export type WrittenQuestionChunksResponse = z.output<typeof WrittenQuestionChunksResponseSchema>;
export type WrittenQuestionCoverageResponse = z.output<typeof WrittenQuestionCoverageResponseSchema>;
