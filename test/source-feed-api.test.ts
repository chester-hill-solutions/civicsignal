import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedSource } from '../src/corpora/source-feed';
import { parseSourceFeedRequest, matchSourceFeed, readSourceFeed } from '../src/routes/source-feed';
import { SOURCE_FEED_PATHS, SourceFeedResponseSchema } from '../src/routes/source-feed-contract';
import { sourceFeedOperation } from '../src/routes/source-feed-openapi';
import { testD1 } from './helpers/d1';

const migration = readFileSync('preview/source-feed/migrations/0001_source_feed.sql', 'utf8');

describe('source feed API', () => {
  let store: ReturnType<typeof testD1>;
  beforeEach(() => { store = testD1({ schema: migration }); });
  afterEach(() => { vi.restoreAllMocks(); store.close(); });

  function edition(source: FeedSource, { language = 'en', editionId = 'edition-1', part, date = '2026-04-25' }: {
    language?: 'en' | 'fr'; editionId?: string; part?: 'I' | 'II'; date?: string;
  } = {}) {
    store.sqlite.prepare(`INSERT INTO source_feed_editions (source, language, edition_id, part, publication_date, observed_at)
      VALUES (?, ?, ?, ?, ?, '2026-04-26T12:00:00.000Z')`).run(source, language, editionId, part ?? null, date);
  }

  function event({ source = 'gazette', language = 'en', editionId = 'edition-1', part,
    kind = 'corrected', recordId = 'record-1', before = 'old title', after = 'new title',
    date = '2026-04-25', observed = '2026-04-26T12:00:00.000Z' }: {
      source?: FeedSource; language?: 'en' | 'fr'; editionId?: string; part?: 'I' | 'II';
      kind?: 'added' | 'corrected' | 'removed'; recordId?: string; before?: string | null; after?: string | null;
      date?: string; observed?: string;
    } = {}) {
    const resolvedPart = source === 'gazette' ? part ?? 'I' : null;
    store.sqlite.prepare(`INSERT INTO source_feed_events
      (source, language, edition_id, part, kind, record_id, publication_date, observed_at, citation_url, label, before_search, after_search)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(source, language, editionId, resolvedPart, kind, recordId,
      date, observed, 'https://example.gc.ca/record', 'Public label', before, after);
  }

  function request(source: FeedSource, query: string) {
    return parseSourceFeedRequest(source, new URL(`https://example.test${SOURCE_FEED_PATHS[source]}?${query}`));
  }

  it('matches only the three feed paths and validates required, optional, and source-specific parameters', () => {
    expect(matchSourceFeed(SOURCE_FEED_PATHS.gazette)).toBe('gazette');
    expect(matchSourceFeed(SOURCE_FEED_PATHS.house)).toBe('house');
    expect(matchSourceFeed(SOURCE_FEED_PATHS.senate)).toBe('senate');
    expect(matchSourceFeed('/api/gazette/changes/extra')).toBeUndefined();
    expect(() => request('gazette', 'topic=x')).toThrow();
    expect(() => request('gazette', 'language=en&limit=0')).toThrow();
    expect(() => request('gazette', 'language=en&language=fr')).toThrow();
    expect(() => request('house', 'language=en&part=I')).toThrow();
    expect(() => request('gazette', `language=en&topic=${encodeURIComponent('\u0301')}`)).toThrow();
    expect(request('gazette', 'language=fr&topic=  Café%20%20&limit=5')).toEqual({
      language: 'fr', topic: 'Café', part: undefined, limit: 5, cursor: undefined,
    });
  });

  it('returns change metadata, edition coverage, and only match booleans for a folded topic', async () => {
    edition('gazette', { part: 'I' }); edition('gazette', { editionId: 'edition-2', part: 'II', date: '2026-04-26' });
    event({ before: 'le cafe autorise', after: 'le the autorise' });
    const parsed = request('gazette', 'language=en&topic=CAFE');
    const batch = vi.spyOn(store.db, 'batch');
    const raw = await readSourceFeed(store.db, { source: 'gazette', query: parsed });
    const result = SourceFeedResponseSchema.parse(raw);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[0]).toHaveLength(4);
    expect(result).toMatchObject({
      events: [{ id: 1, kind: 'corrected', recordId: 'record-1', part: 'I', matches: { before: true, after: false } }],
      scope: { source: 'gazette', language: 'en', editions: [
        { editionId: 'edition-1', part: 'I', publicationDate: '2026-04-25' },
        { editionId: 'edition-2', part: 'II', publicationDate: '2026-04-26' },
      ], redistribution: 'metadata-only' },
      hasMore: false,
    });
    expect(JSON.stringify(result)).not.toContain('le cafe autorise');
    expect(JSON.stringify(result)).not.toContain('le the autorise');
  });

  it('paginates in ascending stable order and returns an idle cursor that sees later changes', async () => {
    edition('house');
    event({ source: 'house', recordId: 'first' });
    event({ source: 'house', recordId: 'second', before: null, after: 'second title' });
    const first = await readSourceFeed(store.db, { source: 'house', query: request('house', 'language=en&limit=1') });
    expect(first.events.map((item) => item.recordId)).toEqual(['first']);
    expect(first.hasMore).toBe(true);
    const next = request('house', `language=en&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`);
    const second = await readSourceFeed(store.db, { source: 'house', query: next });
    expect(second.events.map((item) => item.recordId)).toEqual(['second']);
    expect(second.hasMore).toBe(false);

    const idle = await readSourceFeed(store.db, { source: 'house', query: request('house', 'language=en&topic=no-match') });
    expect(idle.events).toEqual([]);
    expect(idle.hasMore).toBe(false);
    event({ source: 'house', recordId: 'third', before: null, after: 'no-match later' });
    const later = await readSourceFeed(store.db, { source: 'house', query: request('house',
      `language=en&topic=no-match&cursor=${encodeURIComponent(idle.nextCursor)}`) });
    expect(later.events.map((item) => item.recordId)).toEqual(['third']);
  });

  it('rejects filter and journal changes, cursor tampering, and unavailable scope', async () => {
    edition('gazette', { part: 'I' }); edition('gazette', { editionId: 'edition-2', part: 'II' });
    event();
    const page = await readSourceFeed(store.db, { source: 'gazette', query: request('gazette', 'language=en&topic=title') });
    expect(() => request('gazette', `language=en&topic=other&cursor=${encodeURIComponent(page.nextCursor)}`)).toThrow();
    expect(() => request('house', `language=en&cursor=${encodeURIComponent(page.nextCursor)}`)).toThrow();
    expect(() => request('gazette', `language=fr&part=II&topic=title&cursor=${encodeURIComponent(page.nextCursor)}`)).toThrow();
    await expect(readSourceFeed(store.db, { source: 'gazette', query: { ...request('gazette', 'language=en'), cursor: 'not-a-cursor' } })).rejects.toThrow();

    const rebuilt = testD1({ schema: migration });
    try {
      rebuilt.sqlite.prepare(`INSERT INTO source_feed_editions (source, language, edition_id, part, publication_date, observed_at)
        VALUES ('gazette', 'en', 'edition-1', 'I', '2026-04-25', '2026-04-26T12:00:00.000Z'),
        ('gazette', 'en', 'edition-2', 'II', '2026-04-25', '2026-04-26T12:00:00.000Z')`).run();
      rebuilt.sqlite.prepare(`INSERT INTO source_feed_events
        (source, language, edition_id, part, kind, record_id, publication_date, observed_at, citation_url, label)
        VALUES ('gazette', 'en', 'edition-1', 'I', 'added', 'row', '2026-04-25', '2026-04-26T12:00:00.000Z', 'https://example.gc.ca/record', 'Label')`).run();
      const cursor = request('gazette', `language=en&topic=title&cursor=${encodeURIComponent(page.nextCursor)}`);
      await expect(readSourceFeed(rebuilt.db, { source: 'gazette', query: cursor })).rejects.toThrow();
    } finally { rebuilt.close(); }

    const noCoverage = testD1({ schema: migration });
    try {
      await expect(readSourceFeed(noCoverage.db, { source: 'house', query: request('house', 'language=en') }))
        .rejects.toMatchObject({ code: 'RETRIEVAL_UNAVAILABLE', status: 503 });
    } finally { noCoverage.close(); }

    const missingTables = testD1({ schema: '' });
    try {
      await expect(readSourceFeed(missingTables.db, { source: 'house', query: request('house', 'language=en') }))
        .rejects.toMatchObject({ code: 'RETRIEVAL_UNAVAILABLE', status: 503 });
    } finally { missingTables.close(); }
  });

  it('keeps language and Gazette-part events isolated within one shared journal', async () => {
    edition('gazette', { part: 'I' });
    edition('gazette', { editionId: 'part-two', part: 'II' });
    edition('gazette', { language: 'fr', editionId: 'french', part: 'I' });
    event({ before: 'le cafe en premiere partie', after: 'le cafe en premiere partie' });
    event({ editionId: 'part-two', part: 'II', recordId: 'part-two-record', before: 'le cafe en deuxieme partie' });
    event({ language: 'fr', editionId: 'french', recordId: 'french-record', before: 'le cafe francais' });

    const englishPartTwo = await readSourceFeed(store.db, { source: 'gazette',
      query: request('gazette', 'language=en&part=II&topic=CAFE') });
    expect(englishPartTwo.events.map((item) => item.recordId)).toEqual(['part-two-record']);
    const frenchPartOne = await readSourceFeed(store.db, { source: 'gazette',
      query: request('gazette', 'language=fr&part=I&topic=cafe') });
    expect(frenchPartOne.events.map((item) => item.recordId)).toEqual(['french-record']);
  });

  it('requires both Gazette parts for an unqualified feed and documents the GET contract', async () => {
    edition('gazette', { part: 'I' });
    await expect(readSourceFeed(store.db, { source: 'gazette', query: request('gazette', 'language=en') }))
      .rejects.toMatchObject({ code: 'RETRIEVAL_UNAVAILABLE', status: 503 });
    const operation = sourceFeedOperation('gazette').get;
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'language', in: 'query', required: true }),
      expect.objectContaining({ name: 'part', in: 'query', required: false }),
      expect.objectContaining({ name: 'cursor', in: 'query', required: false }),
    ]));
    const responses = operation.responses as Record<string, { content: { 'application/json': { schema: unknown } } }>;
    expect(responses['429']?.content['application/json'].schema).toMatchObject({ properties: { count: expect.any(Object), limit: expect.any(Object), retrieval: expect.any(Object) } });
    expect(responses['200']?.content['application/json'].schema).toMatchObject({ properties: { hasMore: expect.any(Object) } });
  });
});
