import { z } from 'zod';
import { BillBriefSchema, BillLanguageSchema } from '../corpora/bill-trace';
import { BILL_BRIEF_PATH } from './bill-trace';
import { SOURCE_FEED_ERROR_CODES, SourceFeedErrorSchema } from './source-feed-contract';

function response(description: string, schema: z.ZodType) {
  return { description, content: { 'application/json': { schema: z.toJSONSchema(schema) } } };
}

export function billTraceOpenApi() {
  const errors = Object.fromEntries(Object.entries(SOURCE_FEED_ERROR_CODES).map(([status, codes]) =>
    [status, response(codes.join(' / '), SourceFeedErrorSchema.extend({ code: z.enum(codes) }))]));
  return {
    openapi: '3.1.0', info: { title: 'CivicSignal bill and committee brief', version: '0.1.0' },
    security: [{ workspaceKey: [] }],
    components: { securitySchemes: { workspaceKey: { type: 'http', scheme: 'bearer',
      description: 'Workspace key with civicsignal.retrieve.' } } },
    paths: { [BILL_BRIEF_PATH]: { get: {
      operationId: 'getBillCommitteeBrief', summary: 'Follow one bill through both chambers',
      description: 'The local pilot covers S-5 in Parliament 44, session 1. Every successful brief costs one unit. Coverage lists each selected source. A missing source yields a partial brief when other sources are available.',
      parameters: [
        { in: 'path', name: 'parliament', required: true, schema: { type: 'integer' }, example: 44 },
        { in: 'path', name: 'session', required: true, schema: { type: 'integer' }, example: 1 },
        { in: 'path', name: 'number', required: true, schema: { type: 'string' }, example: 'S-5' },
        { in: 'query', name: 'language', required: true, schema: z.toJSONSchema(BillLanguageSchema) },
      ],
      responses: { 200: response('Localized records, directed links, vote tally and source coverage.', BillBriefSchema), ...errors },
    } } },
  };
}
