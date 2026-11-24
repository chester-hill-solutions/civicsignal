import { z } from 'zod';
import { WRITTEN_QUESTION_ERROR_CODES, WRITTEN_QUESTIONS_PATHS, WrittenQuestionCoverageResponseSchema,
  WrittenQuestionErrorSchema, WrittenQuestionLookupResponseSchema, WrittenQuestionSearchResponseSchema,
  WrittenQuestionSearchSchema, WrittenQuestionChunksResponseSchema } from './written-questions-contract';

function jsonSchema(schema: z.ZodType, input = false) {
  const { $schema, ...document } = z.toJSONSchema(schema, { io: input ? 'input' : 'output' });
  return document;
}

function response(description: string, schema: z.ZodType, exampleValue?: unknown) {
  return { description, content: { 'application/json': { schema: jsonSchema(schema),
    ...(exampleValue === undefined ? {} : { example: exampleValue }) } } };
}

export function writtenQuestionOpenApi() {
  const errors = Object.fromEntries(Object.entries(WRITTEN_QUESTION_ERROR_CODES).map(([status, codes]) => [status,
    response(`Request failed with ${status}.`, WrittenQuestionErrorSchema.extend({ code: z.enum(codes) }))]));
  const searchErrors = { ...errors };
  delete searchErrors['404'];
  const queryExamples: Record<keyof typeof WrittenQuestionSearchSchema.shape, string | number> = {
    query: 'rural water funding', language: 'en', session: '45-1', kind: 'reply', limit: 20,
  };
  const parameters = Object.entries(WrittenQuestionSearchSchema.shape).map(([field, schema]) => ({
    name: field, in: 'query', required: !schema.isOptional(), schema: jsonSchema(schema, true),
    example: queryExamples[field as keyof typeof queryExamples],
  }));
  return {
    openapi: '3.1.0',
    info: { title: 'CivicSignal House Written Questions API', version: '0.1.0',
      description: 'Search and look up materialized House of Commons written questions and answer passages. Results carry the publication language and exact official source URL. Coverage counts only locally materialized records; they do not certify that a full source inventory has been acquired. Empty or unavailable documents remain visible in exact lookups.' },
    servers: [{ url: '/' }], security: [{ workspaceKey: [] }],
    components: { securitySchemes: { workspaceKey: { type: 'http', scheme: 'bearer',
      description: 'Workspace API key with the civicsignal.retrieve capability.' } } },
    paths: {
      [WRITTEN_QUESTIONS_PATHS.search]: { get: {
        operationId: 'searchWrittenQuestions', summary: 'Search questions and answer passages', parameters,
        description: 'Full text search in one official-language edition. A match is a verbatim question or reply/attachment passage and includes its exact official citation URL. Results include the questioner metadata where available. Coverage basis is limited to records materialized in this preview. A valid search consumes one workspace unit.',
        responses: { 200: response('Matching question or answer passages.', WrittenQuestionSearchResponseSchema), ...searchErrors },
      } },
      [`${WRITTEN_QUESTIONS_PATHS.search}/{session}/{number}/{language}`]: { get: {
        operationId: 'getWrittenQuestion', summary: 'Look up one question and all answer documents',
        description: 'Return the published question, source metadata and every recorded response document, including empty documents and acquisition gaps. `state=not-found` means this language edition is not materialized in the local preview. A successful retrieval consumes one workspace unit.',
        parameters: [
          { name: 'session', in: 'path', required: true, schema: { type: 'string', pattern: '^\\d{1,2}-\\d{1,2}$' }, example: '45-1' },
          { name: 'number', in: 'path', required: true, schema: { type: 'integer', minimum: 1 }, example: 1010 },
          { name: 'language', in: 'path', required: true, schema: { type: 'string', enum: ['en', 'fr'] }, example: 'en' },
        ],
        responses: { 200: response('Question record, document list and explicit availability state.', WrittenQuestionLookupResponseSchema), ...errors },
      } },
      [`${WRITTEN_QUESTIONS_PATHS.search}/coverage`]: { get: {
        operationId: 'getWrittenQuestionCoverage', summary: 'Read materialized written-question coverage',
        parameters: [{ name: 'session', in: 'query', required: false, schema: { type: 'string', pattern: '^\\d{1,2}-\\d{1,2}$' }, example: '45-1' }],
        description: 'Counts question and document availability states by session and language. Counts describe only rows materialized in the preview database and cannot establish that all listed source questions have been acquired. A successful retrieval consumes one workspace unit.',
        responses: { 200: response('Recorded row counts by session and language.', WrittenQuestionCoverageResponseSchema), ...searchErrors },
      } },
      [`${WRITTEN_QUESTIONS_PATHS.search}/{session}/{number}/{language}/chunks`]: { get: {
        operationId: 'getWrittenQuestionTextChunks', summary: 'Read bounded text chunks from an answer document',
        parameters: [
          { name: 'session', in: 'path', required: true, schema: { type: 'string', pattern: '^\\d{1,2}-\\d{1,2}$' } },
          { name: 'number', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
          { name: 'language', in: 'path', required: true, schema: { type: 'string', enum: ['en', 'fr'] } },
          { name: 'documentKey', in: 'query', required: true, schema: { type: 'string', minLength: 1 } },
          { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0 } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 20 } },
        ],
        description: 'Read up to 20 text chunks of at most 8,192 characters. Use this endpoint to retrieve later text from a large answer document. The language path filters the question record edition; shared bilingual PDF text may be indexed for both editions. `fileLanguage` reports source file metadata when available.',
        responses: { 200: response('Bounded answer text page with source attribution and citation.', WrittenQuestionChunksResponseSchema), ...errors },
      } },
    },
  };
}
