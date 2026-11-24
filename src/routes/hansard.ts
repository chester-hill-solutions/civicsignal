import { emitCorpusItem, type RawCorpusItem } from '@chester-hill-solutions/corpus';
import { AccessError } from '../access';
import { getHansardSpeech, hansardCorpus, senateHansardCorpus } from '../corpora/adapters';
import { hansardLanguagePrefix, hansardPolicy, hansardSpeechIdentity, type HansardChamber, type HansardLanguage } from '../corpora/hansard';
import { RequestInputError } from '../http';
import type { Env } from '../types';
import {
  HANSARD_PATHS, HansardSearchSchema, HansardSpeechSchema, hansardSpeechIdSchema,
  type HansardLookupResponse, type HansardSearchRequest, type HansardSearchResponse, type HansardSpeech,
} from './hansard-contract';

interface HansardRoute {
  chamber: HansardChamber;
  pathId?: string;
}

type HansardRequest =
  | { operation: 'search'; chamber: HansardChamber; query: HansardSearchRequest }
  | { operation: 'lookup'; chamber: HansardChamber; id: string; language: HansardLanguage };

export function matchHansardRoute(pathname: string): HansardRoute | undefined {
  for (const chamber of ['house', 'senate'] as const) {
    const base = HANSARD_PATHS[chamber];
    if (pathname === base) return { chamber };
    if (!pathname.startsWith(`${base}/`)) continue;
    const pathId = pathname.slice(base.length + 1);
    if (pathId && !pathId.includes('/')) return { chamber, pathId };
  }
  return undefined;
}

function parseHansardSearch(url: URL): HansardSearchRequest {
  if (url.search.length > 8192) throw new RequestInputError('The Hansard query is too long.');
  const input: Record<string, unknown> = {};
  for (const name of url.searchParams.keys()) {
    if (!Object.hasOwn(HansardSearchSchema.shape, name)) throw new RequestInputError('Unsupported Hansard query parameter.');
    const values = url.searchParams.getAll(name);
    if (values.length !== 1) throw new RequestInputError(`Supply ${name} once.`);
    const value = values[0] ?? '';
    input[name] = name === 'limit' && /^[0-9]+$/u.test(value) ? Number(value) : value;
  }
  const result = HansardSearchSchema.safeParse(input);
  if (!result.success) throw new RequestInputError(`${result.error.issues[0]?.path.join('.') || 'query'} is invalid.`);
  return result.data;
}

function readSpeechId(pathId: string): string {
  try {
    return decodeURIComponent(pathId);
  } catch {
    throw new RequestInputError('The speech ID is not valid URL encoding.');
  }
}

export function parseHansardRequest({ chamber, pathId }: HansardRoute, url: URL): HansardRequest {
  if (pathId === undefined) return { operation: 'search', chamber, query: parseHansardSearch(url) };
  if (url.search) throw new RequestInputError('A Hansard exact lookup takes no query parameters.');
  const id = readSpeechId(pathId);
  const identity = hansardSpeechIdentity(id);
  if (!identity || !hansardSpeechIdSchema(chamber).safeParse(id).success) {
    throw new RequestInputError('Supply a speech ID for the requested chamber.');
  }
  return { operation: 'lookup', chamber, id, language: identity.language };
}

export function hansardDatabase(env: Env): D1Database {
  if (env.HANSARD_PREVIEW !== 'on') {
    throw new AccessError('UNSUPPORTED_COVERAGE', 'Hansard preview is disabled on this deployment.', 501);
  }
  if (!env.CIVIC_DB) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'The Hansard database is unavailable.', 503);
  return env.CIVIC_DB;
}

async function assertEditionAvailable(db: D1Database, chamber: HansardChamber, language: HansardLanguage) {
  const row = await db.prepare('SELECT id FROM hansard_speeches WHERE corpus_id = ? AND id GLOB ? LIMIT 1')
    .bind(hansardPolicy(chamber).id, `${hansardLanguagePrefix(language, chamber)}*`).first<{ id: string }>();
  if (!row) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'The requested Hansard edition is unavailable.', 503);
}

function emitHansardSpeech(raw: RawCorpusItem, chamber: HansardChamber): HansardSpeech {
  const item = emitCorpusItem(hansardPolicy(chamber), raw);
  const identity = hansardSpeechIdentity(item.id);
  return HansardSpeechSchema.parse({
    id: item.id, corpusId: item.corpusId, chamber, language: identity?.language,
    sittingId: identity?.sittingId, interventionId: identity?.interventionId, sittingDate: item.publishedAt,
    speaker: item.extra?.speaker, party: item.extra?.party, excerpt: item.excerpt, citationUrl: item.citationUrl,
    citationGranularity: chamber === 'house' ? 'intervention' : 'section', source: item.source,
    redistribution: item.redistribution, attribution: item.attribution,
  });
}

export async function runHansardRequest(db: D1Database, request: HansardRequest): Promise<HansardSearchResponse | HansardLookupResponse> {
  const { chamber } = request;
  const ctx = { db, fetch, now: () => new Date() };
  if (request.operation === 'lookup') {
    const raw = await getHansardSpeech(request.id, ctx);
    if (raw) return { item: emitHansardSpeech(raw, chamber) };
    await assertEditionAvailable(db, chamber, request.language);
    throw new AccessError('NOT_FOUND', 'No Hansard speech has that ID.', 404);
  }
  const corpus = chamber === 'house' ? hansardCorpus : senateHansardCorpus;
  const hits = await corpus.retrieve(request.query, ctx);
  if (!hits.length) await assertEditionAvailable(db, chamber, request.query.language);
  const items = hits.map((hit) => emitHansardSpeech(hit, chamber));
  return { items, count: items.length };
}
