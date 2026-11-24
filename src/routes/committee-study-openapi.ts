import { z } from 'zod';
import { CommitteeStudyBriefSchema, CommitteeStudyLanguageSchema } from '../corpora/committee-study';
import {
  CommitteeCorpusCoverageSchema,
  CommitteeCorpusPageSchema,
  CommitteeCorpusSearchResponseSchema,
  CommitteeDetailResponseSchema,
  CommitteePassagesResponseSchema,
} from '../corpora/committee-corpus';
import { SOURCE_FEED_ERROR_CODES, SourceFeedErrorSchema } from './source-feed-contract';
import { COMMITTEE_STUDY_BRIEF_PATH } from './committee-study';
import { COMMITTEE_CORPUS_PATH } from './committee-corpus';

function jsonSchema(schema: z.ZodType) {
  const { $schema, ...document } = z.toJSONSchema(schema);
  return document;
}

function response(description: string, schema: z.ZodType) {
  return { description, content: { 'application/json': { schema: jsonSchema(schema) } } };
}

const sessionParameter = { in: 'path', name: 'session', required: true, schema: { type: 'string', pattern: '^\\d{1,2}-\\d{1,2}$' } };
const committeeParameter = { in: 'path', name: 'committeeId', required: true, schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,99}$' } };
const documentParameter = { in: 'path', name: 'documentId', required: true, schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,99}$' } };
const languageParameter = { in: 'query', name: 'language', required: true, schema: { type: 'string', enum: ['en', 'fr'] } };
const paginationParameters = [
  { in: 'query', name: 'offset', required: false, schema: { type: 'integer', minimum: 0 } },
  { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
];
const detailResponses = {
  200: response('The cited record and its paged parent and child relationships.', CommitteeDetailResponseSchema),
  ...Object.fromEntries(Object.entries(SOURCE_FEED_ERROR_CODES).map(([status, codes]) => [status,
    response(`The request failed with HTTP ${status}.`, SourceFeedErrorSchema.extend({ code: z.enum(codes) }))])),
};
const corpusErrors = Object.fromEntries(Object.entries(SOURCE_FEED_ERROR_CODES).map(([status, codes]) => [status,
  response(`The request failed with HTTP ${status}.`, SourceFeedErrorSchema.extend({ code: z.enum(codes) }))]));

export function committeeStudyOpenApi() {
  return {
    openapi: '3.1.0',
    info: { title: 'CivicSignal committee corpus and study preview', version: '0.2.0' },
    security: [{ workspaceKey: [] }],
    components: {
      securitySchemes: {
        workspaceKey: {
          type: 'http', scheme: 'bearer',
          description: 'Workspace key with civicsignal.retrieve.',
        },
      },
    },
    paths: {
      [`${COMMITTEE_CORPUS_PATH}/openapi.json`]: {
        get: {
          operationId: 'getCommitteeOpenApi',
          summary: 'Discover the committee API contract',
          responses: { 200: { description: 'OpenAPI 3.1 contract document.', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      [`${COMMITTEE_CORPUS_PATH}/search`]: {
        get: {
          operationId: 'searchCommitteeCorpus',
          summary: 'Search committee records and passages',
          description: 'Searches privately indexed text in one language edition. Metadata-only records can match but never disclose indexed body text. Only records explicitly permitted for excerpt delivery return at most 400 characters per hit.',
          parameters: [
            { in: 'query', name: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 256 } },
            languageParameter,
            { in: 'query', name: 'session', required: false, schema: { type: 'string', pattern: '^\\d{1,2}-\\d{1,2}$' } },
            { in: 'query', name: 'chamber', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'committeeId', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'studyId', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'kind', required: false, schema: { type: 'string' } },
            ...paginationParameters,
          ],
          responses: {
            200: response('Cited matches, published credits and parent references, with text subject to delivery rights.', CommitteeCorpusSearchResponseSchema),
            ...corpusErrors,
          },
        },
      },
      [`${COMMITTEE_CORPUS_PATH}/coverage`]: {
        get: {
          operationId: 'getCommitteeCorpusCoverage',
          summary: 'Inspect committee corpus coverage',
          description: 'Returns the snapshot cutoff, counts by committee, chamber, language, kind and status, and a paged list of stored, pending, unavailable or removed records.',
          parameters: [
            { in: 'query', name: 'session', required: false, schema: { type: 'string', default: '45-1' } },
            { in: 'query', name: 'chamber', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'committeeId', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'language', required: false, schema: { type: 'string', enum: ['en', 'fr'] } },
            { in: 'query', name: 'kind', required: false, schema: { type: 'string' } },
            ...paginationParameters,
          ],
          responses: { 200: response('Counts, cutoff and paginated outstanding record identifiers.', CommitteeCorpusCoverageSchema), ...corpusErrors },
        },
      },
      [`${COMMITTEE_CORPUS_PATH}/{session}`]: {
        get: {
          operationId: 'listSessionCommittees', summary: 'List committees in a session',
          parameters: [sessionParameter, { ...languageParameter, required: false }, ...paginationParameters],
          responses: { 200: response('Paged committee directory records.', CommitteeCorpusPageSchema), ...corpusErrors },
        },
      },
      [`${COMMITTEE_CORPUS_PATH}/{session}/{committeeId}`]: {
        get: {
          operationId: 'getCommitteeRecord', summary: 'Inspect a committee and traverse relationships',
          parameters: [sessionParameter, committeeParameter, languageParameter, ...paginationParameters],
          responses: detailResponses,
        },
      },
      [`${COMMITTEE_CORPUS_PATH}/{session}/{committeeId}/studies`]: {
        get: {
          operationId: 'listCommitteeStudies', summary: 'List studies for a committee',
          parameters: [sessionParameter, committeeParameter, { ...languageParameter, required: false }, ...paginationParameters],
          responses: { 200: response('Paged study records for the committee.', CommitteeCorpusPageSchema), ...corpusErrors },
        },
      },
      [`${COMMITTEE_CORPUS_PATH}/{session}/{committeeId}/studies/{studyId}`]: {
        get: {
          operationId: 'getCommitteeStudy', summary: 'Inspect a study',
          parameters: [sessionParameter, committeeParameter, { in: 'path', name: 'studyId', required: true, schema: { type: 'string' } }, languageParameter, ...paginationParameters],
          responses: detailResponses,
        },
      },
      [`${COMMITTEE_CORPUS_PATH}/{session}/{committeeId}/meetings`]: {
        get: {
          operationId: 'listCommitteeMeetings', summary: 'List meetings for a committee',
          parameters: [sessionParameter, committeeParameter, { ...languageParameter, required: false }, ...paginationParameters],
          responses: { 200: response('Paged meeting records for the committee.', CommitteeCorpusPageSchema), ...corpusErrors },
        },
      },
      [`${COMMITTEE_CORPUS_PATH}/{session}/{committeeId}/meetings/{meetingId}`]: {
        get: {
          operationId: 'getCommitteeMeeting', summary: 'Inspect a meeting',
          parameters: [sessionParameter, committeeParameter, { in: 'path', name: 'meetingId', required: true, schema: { type: 'string' } }, languageParameter, ...paginationParameters],
          responses: detailResponses,
        },
      },
      [`${COMMITTEE_CORPUS_PATH}/{session}/documents/{documentId}`]: {
        get: {
          operationId: 'getCommitteeDocument', summary: 'Inspect publication metadata and relationships',
          parameters: [sessionParameter, documentParameter, languageParameter, ...paginationParameters],
          responses: detailResponses,
        },
      },
      [`${COMMITTEE_CORPUS_PATH}/{session}/documents/{documentId}/passages`]: {
        get: {
          operationId: 'listCommitteePassages', summary: 'List cited passages',
          description: 'Text is null for metadata-only or unknown delivery rights. Excerpt delivery is capped at 400 characters per passage.',
          parameters: [sessionParameter, documentParameter, languageParameter, ...paginationParameters],
          responses: { 200: response('Ordered passages with locations, speaker credits and official citations.', CommitteePassagesResponseSchema), ...corpusErrors },
        },
      },
      [COMMITTEE_STUDY_BRIEF_PATH]: {
        get: {
          operationId: 'getHouseEnviFreshwaterStudyBrief',
          summary: 'View the House ENVI freshwater study record',
          description: 'A bilingual historical preview of selected official study milestones, with citations and the source publisher. Events and response status are evaluated as of the requested date; the response deadline is 120 calendar days after presentation.',
          parameters: [
            { in: 'query', name: 'language', required: true, schema: z.toJSONSchema(CommitteeStudyLanguageSchema) },
            { in: 'query', name: 'asOf', required: false, schema: { type: 'string', format: 'date' }, description: 'Historical view date. Defaults to the packet coverage date; dates after known coverage are rejected.' },
          ],
          responses: {
            200: response('Localized study events, citations, and time-sensitive government response status.', CommitteeStudyBriefSchema),
            ...Object.fromEntries(Object.entries(SOURCE_FEED_ERROR_CODES).map(([status, codes]) => [status,
              response(`The request failed with HTTP ${status}.`, SourceFeedErrorSchema.extend({ code: z.enum(codes) }))])),
          },
        },
      },
    },
  };
}
