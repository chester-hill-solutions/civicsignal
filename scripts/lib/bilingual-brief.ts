import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { SOURCE_FEED_PATHS, type SourceFeedResponse } from '../../src/routes/source-feed-contract';
import { parseSourceFeedRequest, readSourceFeed } from '../../src/routes/source-feed';
import { localD1 } from './local-d1';

const feedSource = z.enum(['gazette', 'house', 'senate']);
const language = z.enum(['en', 'fr']);
const eventKind = z.enum(['added', 'corrected', 'removed']);

export const BriefCoverageSchema = z.strictObject({
  source: feedSource,
  language,
  part: z.enum(['I', 'II']).optional(),
  status: z.enum(['changes', 'quiet', 'unknown']),
  editions: z.array(z.strictObject({ editionId: z.string().min(1), publicationDate: z.iso.date(), observedAt: z.iso.datetime() })),
});

export const BriefEventSchema = z.strictObject({
  identity: z.string().regex(/^[0-9a-f]{32}:[1-9][0-9]*$/u),
  source: feedSource,
  language,
  kind: eventKind,
  recordId: z.string().min(1),
  editionId: z.string().min(1),
  part: z.enum(['I', 'II']).optional(),
  publicationDate: z.iso.date(),
  observedAt: z.iso.datetime(),
  label: z.string(),
  citationUrl: z.url({ protocol: /^https$/ }),
  attribution: z.string().min(1),
  matches: z.strictObject({ before: z.boolean(), after: z.boolean() }).optional(),
});

export const BilingualBriefSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime(),
  topics: z.strictObject({ en: z.string().optional(), fr: z.string().optional() }),
  cursors: z.record(z.string(), z.string().min(1)),
  coverage: z.array(BriefCoverageSchema),
  events: z.array(BriefEventSchema),
});

export const BriefOptionsSchema = z.strictObject({
  cursors: z.record(z.string().min(1), z.string().min(1).max(4096)).optional(),
  topics: z.strictObject({ en: z.string().trim().min(1).max(300).optional(), fr: z.string().trim().min(1).max(300).optional() }).optional(),
  generatedAt: z.iso.datetime().optional(),
});

export type BilingualBrief = z.infer<typeof BilingualBriefSchema>;
export type BriefLanguage = z.infer<typeof language>;
export type BriefSource = z.infer<typeof feedSource>;
export type BriefCursors = Record<string, string>;

export interface BriefOptions {
  cursors?: BriefCursors;
  topics?: Partial<Record<BriefLanguage, string>>;
  generatedAt?: string;
}

const snapshotQueues = new WeakMap<DatabaseSync, Promise<void>>();
let snapshotNumber = 0;

async function withReadSnapshot<T>(sqlite: DatabaseSync, work: () => Promise<T>): Promise<T> {
  const previous = snapshotQueues.get(sqlite) ?? Promise.resolve();
  let unlock = () => {};
  const lock = new Promise<void>((resolve) => { unlock = resolve; });
  const queued = previous.then(() => lock);
  snapshotQueues.set(sqlite, queued);
  await previous;
  const savepoint = `local_brief_${++snapshotNumber}`;
  let opened = false;
  try {
    sqlite.exec(`SAVEPOINT ${savepoint}`);
    opened = true;
    const result = await work();
    sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    if (opened) {
      sqlite.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);
    }
    throw error;
  } finally {
    unlock();
  }
}

interface JournalIdentity { journal_id: string }
interface EditionRow { part: string | null }

function laneKey(source: BriefSource, lang: BriefLanguage, part?: 'I' | 'II', topic?: string) {
  return `${source}/${lang}/${part ?? '*'}/${encodeURIComponent(topic ?? '')}`;
}

function laneParts(source: BriefSource): Array<'I' | 'II' | undefined> {
  return source === 'gazette' ? ['I', 'II'] : [undefined];
}

function toBriefEvent(source: BriefSource, response: SourceFeedResponse, event: SourceFeedResponse['events'][number], journalId: string) {
  return {
    identity: `${journalId}:${event.id}`,
    source,
    language: response.scope.language,
    kind: event.kind,
    recordId: event.recordId,
    editionId: event.editionId,
    ...(event.part === undefined ? {} : { part: event.part }),
    publicationDate: event.publicationDate,
    observedAt: event.observedAt,
    label: event.label,
    citationUrl: event.citationUrl,
    attribution: response.scope.attribution,
    ...(event.matches === undefined ? {} : { matches: event.matches }),
  };
}

interface LaneRead {
  coverage: z.infer<typeof BriefCoverageSchema>;
  events: Array<z.infer<typeof BriefEventSchema>>;
  cursor?: string;
}

interface LaneSpec {
  source: BriefSource;
  language: BriefLanguage;
  part?: 'I' | 'II';
  topic?: string;
  key: string;
}

async function readLane(sqlite: DatabaseSync, db: D1Database, journalId: string,
  lane: LaneSpec, initialCursor: string | undefined): Promise<LaneRead> {
  const { source, language: lang, part, topic, key } = lane;
  const editions = sqlite.prepare(`SELECT part FROM source_feed_editions WHERE source = ? AND language = ?${part ? ' AND part = ?' : ''}`)
    .all(...(part ? [source, lang, part] : [source, lang])) as unknown as EditionRow[];
  if (!editions.some((row) => part === undefined || row.part === part)) {
    return { coverage: { source, language: lang, ...(part ? { part } : {}), status: 'unknown', editions: [] }, events: [] };
  }

  const laneEvents: Array<z.infer<typeof BriefEventSchema>> = [];
  let pageCursor = initialCursor;
  let scope: SourceFeedResponse['scope'] | undefined;
  let hasMore = true;
  const seen = new Set<string>();
  while (hasMore) {
    const params = new URLSearchParams({ language: lang, limit: '100' });
    if (part) params.set('part', part);
    if (topic !== undefined) params.set('topic', topic);
    if (pageCursor) params.set('cursor', pageCursor);
    const query = parseSourceFeedRequest(source, new URL(`https://local.invalid${SOURCE_FEED_PATHS[source]}?${params}`));
    const result = await readSourceFeed(db, { source, query });
    scope = result.scope;
    for (const event of result.events) {
      const shaped = toBriefEvent(source, result, event, journalId);
      if (!seen.has(shaped.identity)) {
        seen.add(shaped.identity);
        laneEvents.push(shaped);
      }
    }
    if (result.hasMore && result.nextCursor === pageCursor) throw new Error('The source-feed cursor did not advance.');
    pageCursor = result.nextCursor;
    hasMore = result.hasMore;
  }
  if (!scope || !pageCursor) throw new Error(`The source-feed lane ${key} did not return a resumable cursor.`);
  return {
    cursor: pageCursor,
    coverage: { source, language: lang, ...(part ? { part } : {}), status: laneEvents.length ? 'changes' : 'quiet',
      editions: scope.editions.map(({ editionId, publicationDate, observedAt }) => ({ editionId, publicationDate, observedAt })) },
    events: laneEvents,
  };
}

/** Consume the existing local source-feed API, preserving its match and cursor semantics. */
export function readBilingualBrief(sqlite: DatabaseSync, inputOptions: BriefOptions = {}): Promise<BilingualBrief> {
  const options = BriefOptionsSchema.parse(inputOptions);
  return withReadSnapshot(sqlite, async () => readBilingualBriefSnapshot(sqlite, options));
}

async function readBilingualBriefSnapshot(sqlite: DatabaseSync, options: z.infer<typeof BriefOptionsSchema>): Promise<BilingualBrief> {
  const hasEnTopic = options.topics?.en !== undefined;
  const hasFrTopic = options.topics?.fr !== undefined;
  if (hasEnTopic !== hasFrTopic) throw new Error('Supply both --topic-en and --topic-fr, or neither.');
  const journal = sqlite.prepare('SELECT journal_id FROM source_feed_identity WHERE singleton = 1').get() as JournalIdentity | undefined;
  if (!journal || !/^[0-9a-f]{32}$/u.test(journal.journal_id)) throw new Error('The local source-feed journal is unavailable.');
  const db = localD1(sqlite, { existingReadTransaction: true });
  const cursors = { ...(options.cursors ?? {}) };
  const coverage: Array<z.infer<typeof BriefCoverageSchema>> = [];
  const events: Array<z.infer<typeof BriefEventSchema>> = [];
  for (const source of ['gazette', 'house', 'senate'] as const) for (const lang of ['en', 'fr'] as const) {
    const topic = options.topics?.[lang];
    for (const part of laneParts(source)) {
      const key = laneKey(source, lang, part, topic);
      const result = await readLane(sqlite, db, journal.journal_id,
        { source, language: lang, ...(part ? { part } : {}), ...(topic === undefined ? {} : { topic }), key }, cursors[key]);
      if (result.cursor) cursors[key] = result.cursor;
      coverage.push(result.coverage);
      events.push(...result.events);
    }
  }
  events.sort((a, b) => Number(a.identity.slice(a.identity.lastIndexOf(':') + 1))
    - Number(b.identity.slice(b.identity.lastIndexOf(':') + 1)));
  return BilingualBriefSchema.parse({ schemaVersion: 1, generatedAt: options.generatedAt ?? new Date().toISOString(),
    topics: options.topics ?? {}, cursors, coverage, events });
}
