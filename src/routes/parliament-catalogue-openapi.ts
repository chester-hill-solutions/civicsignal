import { z } from 'zod';
import { detailsByCollection, ParliamentEdition, ParliamentCollection, ParliamentCoverage, ParliamentList, ParliamentLookup,
  childResource, MemberPage, PassagePage, keyPattern } from '../corpora/parliament-catalogue';
import { CoverageQuery, ListQuery, MemberQuery, LookupQuery } from './parliament-catalogue';
import { SOURCE_FEED_ERROR_CODES, SourceFeedErrorSchema } from './source-feed-contract';

function response(description: string, schema: z.ZodType) {
  return { description, content: { 'application/json': { schema: z.toJSONSchema(schema) } } };
}

function parameters(shape: Record<string, z.ZodType>) {
  return Object.entries(shape).map(([name, schema]) => ({
    name, in: 'query', required: !schema.isOptional(), schema: z.toJSONSchema(schema, { io: 'input' }),
  }));
}

export function parliamentCatalogueOpenApi() {
  const errors = Object.fromEntries(Object.entries(SOURCE_FEED_ERROR_CODES).map(([status, codes]) =>
    [status, response(codes.join(' / '), SourceFeedErrorSchema.extend({ code: z.enum(codes) }))]));
  const paths: Record<string, unknown> = {};
  for (const collection of ParliamentCollection.options) {
    const tag = collection.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join('');
    const base = '/api/parliament/' + collection;
    const record = ParliamentEdition.extend({ key: z.string().regex(keyPattern(collection)), details: detailsByCollection[collection] });
    const list = ParliamentList.extend({ items: record.array() });
    const lookup = ParliamentLookup.extend({ item: record.nullable() });
    paths[base] = { get: { operationId: 'list' + tag, summary: 'Browse or search bilingual catalogue metadata',
      description: 'Select one language. Search matches a literal accent-insensitive substring. Supply the returned revision with nextOffset as offset to page the same inventory.',
      parameters: parameters(ListQuery.shape), responses: { 200: response('Cited editions and observed coverage.', list), ...errors } } };
    paths[base + '/coverage'] = { get: { operationId: 'get' + tag + 'Coverage', summary: 'Read the last materialized inventory cutoff and counts',
      parameters: parameters(CoverageQuery.shape), responses: { 200: response('Coverage of both editions.', ParliamentCoverage), ...errors } } };
    paths[base + '/{key}'] = { get: { operationId: 'get' + tag + 'Edition', summary: 'Look up an official number in one session and language',
      parameters: [{ in: 'path', name: 'key', required: true, schema: { type: 'string', pattern: keyPattern(collection).source } }, ...parameters(LookupQuery.shape)],
      responses: { 200: response('Cited edition, or null when absent from this inventory.', lookup), ...errors } } };
    const child = childResource(collection);
    if (child) {
      const shape = child === 'members' ? MemberQuery.shape : ListQuery.shape;
      for (const scoped of [false, true]) {
        const path = base + (scoped ? '/{key}/' : '/') + child;
        const pathArgs = scoped ? [{ in: 'path', name: 'key', required: true, schema: { type: 'string', pattern: keyPattern(collection).source } }] : [];
        paths[path] = { get: { operationId: 'search' + tag + (scoped ? 'Edition' : 'Session') + (child === 'members' ? 'Members' : 'Passages'),
          summary: 'Read or search cited ' + child + (scoped ? ' in one edition' : ' across the selected session'),
          description: child === 'members'
            ? 'Search published names, affiliations, constituencies or provinces. Filter by exact publisher memberId or vote position. A paired filter includes members marked as paired who also cast a vote.'
            : 'Search published Journal passages. Each hit includes an edition, a one-based ordinal, a citation and available source links.',
          parameters: [...pathArgs, ...parameters(shape)], responses: { 200: response('Entries in source order within each edition.',
            child === 'members' ? MemberPage : PassagePage), ...errors } } };
      }
    }
  }
  return { openapi: '3.1.0', info: { title: 'CivicSignal parliamentary catalogues', version: '0.1.0' },
    components: { securitySchemes: { workspaceKey: { type: 'http', scheme: 'bearer', description: 'Workspace key with civicsignal.retrieve.' } } },
    security: [{ workspaceKey: [] }], paths };
}
