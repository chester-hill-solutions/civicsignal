import { SourceFeedResponseSchema } from '../src/routes/source-feed-contract';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessError } from '../src/access';
import { gazetteDatabase, matchGazetteRoute, parseGazetteRequest, runGazetteRequest } from '../src/routes/gazette';
import { GazetteExtraLookupResponseSchema, GazetteExtraSearchResponseSchema, GazetteLookupResponseSchema,
  GazetteSearchResponseSchema } from '../src/routes/gazette-contract';
import { gazetteOpenApi } from '../src/routes/gazette-openapi';
import { normalizeForSearch } from '../src/text';
import { testD1 } from './helpers/d1';

const migration = `${readFileSync('preview/gazette/migrations/0001_gazette.sql', 'utf8')}\n${readFileSync('preview/gazette/migrations/0002_gazette_extras.sql', 'utf8')}`;
describe('Canada Gazette HTTP contract', () => {
  let store: ReturnType<typeof testD1>;
  beforeEach(() => { store = testD1({ schema: migration }); });
  afterEach(() => { vi.restoreAllMocks(); store.close(); });

  function edition({ part, language, date, volume, issue, count = 1 }: {
    part: 'I' | 'II'; language: 'en' | 'fr'; date: string; volume: number; issue: number; count?: number;
  }) {
    store.sqlite.prepare(`INSERT INTO gazette_editions (part, language, issue_date, volume, issue_number, record_count, content_sha256, parser_version)
      VALUES (?, ?, ?, ?, ?, ?, 'digest', 'fixture')`).run(part, language, date, volume, issue, count);
  }

  function record({ id = 'gazette:pi:en:2026-04-25:v160:n17:cosmetics', part = 'I' as 'I' | 'II', language = 'en' as 'en' | 'fr', date = '2026-04-25', volume = 160,
    issue = 17, kind = 'proposal', title = 'Cosmetics consultation', table = 'gazette_notices' } = {}) {
    const partNumber = part === 'I' ? '1' : '2';
    const lang = language === 'en' ? 'eng' : 'fra';
    const citationUrl = `https://gazette.gc.ca/rp-pr/p${partNumber}/${date.slice(0, 4)}/${date}/html/s1-${lang}.html`;
    store.sqlite.prepare(`INSERT INTO ${table} (id, part, language, issue_date, volume, issue_number, kind, title, citation_url, search_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, part, language, date, volume, issue, kind, title, citationUrl, normalizeForSearch(title));
  }

  it('matches search and exact routes and rejects nested paths', () => {
    expect(matchGazetteRoute('/api/gazette')).toEqual({});
    expect(matchGazetteRoute('/api/gazette/gazette%3Api%3Aen%3A2026-04-25%3Av160%3An17%3Acosmetics')).toEqual({ pathId: 'gazette%3Api%3Aen%3A2026-04-25%3Av160%3An17%3Acosmetics' });
    expect(matchGazetteRoute('/api/gazette/openapi.json')).toEqual({ pathId: 'openapi.json' });
    expect(matchGazetteRoute('/api/gazette/a/b')).toBeUndefined();
  });

  it('parses the typed filters and rejects duplicate, unknown, invalid, or exact-query parameters', () => {
    const route = matchGazetteRoute('/api/gazette');
    expect(route).toBeDefined();
    if (!route) throw new Error('Search route should match.');
    expect(parseGazetteRequest(route, new URL('https://example.test/api/gazette?topic=cosmetics&language=fr&part=II&since=2026-04-20&until=2026-04-26&limit=5')))
      .toMatchObject({ operation: 'search', query: { topic: 'cosmetics', language: 'fr', part: 'II', limit: 5 } });
    const regularDefault = parseGazetteRequest(route, new URL('https://example.test/api/gazette?topic=x&language=en'));
    expect(regularDefault).toMatchObject({ operation: 'search', query: { topic: 'x', language: 'en' } });
    if (regularDefault.operation !== 'search') throw new Error('Search route should parse as search.');
    expect(regularDefault.query).not.toHaveProperty('editionType');
    expect(parseGazetteRequest(route, new URL('https://example.test/api/gazette?topic=x&language=en&editionType=extra')))
      .toMatchObject({ operation: 'search', query: { editionType: 'extra' } });
    for (const query of ['topic=x&topic=y&language=en', 'topic=x&language=en&editionType=unknown', 'topic=x&language=en&since=2026-05-01&until=2026-04-01']) {
      expect(() => parseGazetteRequest(route, new URL(`https://example.test/api/gazette?${query}`))).toThrow();
    }
    const invalidExact = matchGazetteRoute('/api/gazette/record-1');
    if (!invalidExact) throw new Error('Exact route should match.');
    expect(() => parseGazetteRequest(invalidExact, new URL('https://example.test/api/gazette/record-1?language=en'))).toThrow();
    const exactRoute = matchGazetteRoute('/api/gazette/gazette%3Api%3Aen%3A2026-04-25%3Av160%3An17%3Acosmetics');
    if (!exactRoute) throw new Error('Exact route should match.');
    expect(parseGazetteRequest(exactRoute, new URL('https://example.test/api/gazette/gazette%3Api%3Aen%3A2026-04-25%3Av160%3An17%3Acosmetics')))
      .toMatchObject({ operation: 'lookup', id: 'gazette:pi:en:2026-04-25:v160:n17:cosmetics' });
  });

  it('searches and looks up extras with a separate extraNumber identity on the regular issue date', async () => {
    const date = '2026-04-25';
    edition({ part: 'I', language: 'en', date, volume: 160, issue: 17 });
    record({ title: 'Regular Gazette record' });
    store.sqlite.prepare(`INSERT INTO gazette_extra_editions
      (part,language,issue_date,volume,extra_number,record_count,content_sha256,parser_version)
      VALUES ('I','en',?,160,1,1,'extra-digest','gazette-extra-fixture')`).run(date);
    const extraId = 'gazette:extra:pi:en:2026-04-25:v160:x1:proclamation';
    const extraUrl = 'https://gazette.gc.ca/rp-pr/p1/2026/2026-04-25-x1/html/extra1-eng.html';
    store.sqlite.prepare(`INSERT INTO gazette_extra_records
      (id,edition_type,part,language,issue_date,volume,extra_number,kind,title,citation_url,search_text)
      VALUES (?,'extra','I','en',?,160,1,'notice','Extra Gazette proclamation',?,?)`)
      .run(extraId, date, extraUrl, normalizeForSearch('Extra Gazette proclamation'));

    const regular = GazetteSearchResponseSchema.parse(await runGazetteRequest(store.db, {
      operation: 'search', query: { topic: 'gazette', language: 'en', part: 'I', limit: 20 },
    }));
    expect(regular.items.map((item) => item.id)).toEqual(['gazette:pi:en:2026-04-25:v160:n17:cosmetics']);
    const extra = GazetteExtraSearchResponseSchema.parse(await runGazetteRequest(store.db, {
      operation: 'search', query: { topic: 'proclamation', language: 'en', part: 'I', editionType: 'extra', limit: 20 },
    }));
    expect(extra.items).toMatchObject([{ id: extraId, editionType: 'extra', extraNumber: 1, citationUrl: extraUrl }]);
    expect(extra.coverage).toEqual([{ editionType: 'extra', part: 'I', language: 'en', available: true,
      issues: [{ issueDate: date, volume: 160, extraNumber: 1, recordCount: 1 }] }]);
    const exact = GazetteExtraLookupResponseSchema.parse(await runGazetteRequest(store.db, { operation: 'lookup', id: extraId }));
    expect(exact.item).toMatchObject({ id: extraId, editionType: 'extra', extraNumber: 1, issueDate: date, citationUrl: extraUrl });
  });

  it('returns bilingual records, exact lookup, metadata-only policy, and per-edition coverage', async () => {
    edition({ part: 'I', language: 'en', date: '2026-04-25', volume: 160, issue: 17 });
    edition({ part: 'I', language: 'fr', date: '2026-04-25', volume: 160, issue: 17 });
    edition({ part: 'II', language: 'en', date: '2026-04-22', volume: 160, issue: 8, count: 0 });
    edition({ part: 'II', language: 'fr', date: '2026-04-22', volume: 160, issue: 8, count: 0 });
    record();
    record({ id: 'gazette:pi:fr:2026-04-25:v160:n17:cosmetique', language: 'fr', title: 'Consultation cosmétique' });

    const en = await runGazetteRequest(store.db, { operation: 'search', query: { topic: 'cosmetics', language: 'en', limit: 20 } });
    const enSearch = GazetteSearchResponseSchema.parse(en);
    expect(enSearch).toMatchObject({ count: 1, items: [{ id: 'gazette:pi:en:2026-04-25:v160:n17:cosmetics', redistribution: 'metadata-only' }] });
    expect(en.coverage).toEqual([
      { part: 'I', language: 'en', available: true, issues: [{ issueDate: '2026-04-25', volume: 160, issueNumber: 17, recordCount: 1 }] },
      { part: 'II', language: 'en', available: true, issues: [{ issueDate: '2026-04-22', volume: 160, issueNumber: 8, recordCount: 0 }] },
    ]);
    const fr = await runGazetteRequest(store.db, { operation: 'search', query: { topic: 'cosmétique', language: 'fr', part: 'I', limit: 20 } });
    expect(GazetteSearchResponseSchema.parse(fr).items.map((item) => item.id)).toEqual(['gazette:pi:fr:2026-04-25:v160:n17:cosmetique']);
    const exact = await runGazetteRequest(store.db, { operation: 'lookup', id: 'gazette:pi:en:2026-04-25:v160:n17:cosmetics' });
    const exactResult = GazetteLookupResponseSchema.parse(exact);
    expect(exactResult.item).toMatchObject({ id: 'gazette:pi:en:2026-04-25:v160:n17:cosmetics', title: 'Cosmetics consultation' });
    expect(exactResult.item).not.toHaveProperty('body');
  });

  it('distinguishes an available zero-hit issue from unavailable coverage', async () => {
    edition({ part: 'II', language: 'en', date: '2026-04-22', volume: 160, issue: 8, count: 0 });
    const empty = await runGazetteRequest(store.db, { operation: 'search', query: { topic: 'no match', language: 'en', part: 'II', limit: 20 } });
    expect(empty).toMatchObject({ items: [], count: 0, coverage: [{ available: true, issues: [{ recordCount: 0 }] }] });

    await expect(runGazetteRequest(store.db, { operation: 'search', query: { topic: 'no match', language: 'fr', part: 'II', limit: 20 } }))
      .rejects.toMatchObject({ code: 'RETRIEVAL_UNAVAILABLE', status: 503 });
    await expect(runGazetteRequest(store.db, { operation: 'lookup', id: 'gazette:pi:fr:2026-04-25:v160:n17:missing' }))
      .rejects.toMatchObject({ code: 'RETRIEVAL_UNAVAILABLE', status: 503 });
    await expect(runGazetteRequest(store.db, { operation: 'lookup', id: 'gazette:pii:en:2026-04-22:v160:n8:missing' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('keeps date-filtered coverage to scheduled issues and rejects partial coverage despite hits elsewhere', async () => {
    const query = { topic: 'cosmetics', language: 'en' as const, limit: 20 };
    edition({ part: 'I', language: 'en', date: '2026-04-25', volume: 160, issue: 17 });
    record();
    const batch = vi.spyOn(store.db, 'batch');
    const singleDay = await runGazetteRequest(store.db, { operation: 'search', query: { ...query, since: '2026-04-25', until: '2026-04-25' } });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[0]).toHaveLength(2);
    const singleDayResult = GazetteSearchResponseSchema.parse(singleDay);
    expect(singleDayResult.items.map((item) => item.id)).toEqual(['gazette:pi:en:2026-04-25:v160:n17:cosmetics']);
    expect(singleDayResult.coverage).toEqual([
      { part: 'I', language: 'en', available: true, issues: [{ issueDate: '2026-04-25', volume: 160, issueNumber: 17, recordCount: 1 }] },
      { part: 'II', language: 'en', available: true, issues: [] },
    ]);

    await expect(runGazetteRequest(store.db, { operation: 'search', query }))
      .rejects.toMatchObject({ code: 'RETRIEVAL_UNAVAILABLE', status: 503 });
  });

  it('searches and looks up rolling issue editions alongside the April fixture editions', async () => {
    edition({ part: 'I', language: 'en', date: '2026-04-25', volume: 160, issue: 17 });
    edition({ part: 'II', language: 'en', date: '2026-04-22', volume: 160, issue: 8, count: 0 });
    for (const language of ['en', 'fr'] as const) {
      edition({ part: 'I', language, date: '2026-11-21', volume: 160, issue: 47 });
      edition({ part: 'II', language, date: '2026-11-18', volume: 160, issue: 20 });
    }
    record({ id: 'gazette:pi:en:2026-11-21:v160:n47:weekly-notice', date: '2026-11-21', issue: 47,
      title: 'Weekly Gazette consultation', kind: 'notice' });
    record({ id: 'gazette:pii:en:2026-11-18:v160:n20:weekly-instrument', part: 'II', date: '2026-11-18', issue: 20,
      title: 'Weekly Gazette instrument', kind: 'instrument', table: 'gazette_instruments' });

    const result = GazetteSearchResponseSchema.parse(await runGazetteRequest(store.db, {
      operation: 'search', query: { topic: 'weekly gazette', language: 'en', limit: 20 },
    }));
    expect(result.items.map((item) => item.issueDate)).toEqual(['2026-11-21', '2026-11-18']);
    expect(result.coverage).toEqual([
      { part: 'I', language: 'en', available: true, issues: [
        { issueDate: '2026-11-21', volume: 160, issueNumber: 47, recordCount: 1 },
        { issueDate: '2026-04-25', volume: 160, issueNumber: 17, recordCount: 1 },
      ] },
      { part: 'II', language: 'en', available: true, issues: [
        { issueDate: '2026-11-18', volume: 160, issueNumber: 20, recordCount: 1 },
        { issueDate: '2026-04-22', volume: 160, issueNumber: 8, recordCount: 0 },
      ] },
    ]);
    const exact = GazetteLookupResponseSchema.parse(await runGazetteRequest(store.db, {
      operation: 'lookup', id: 'gazette:pi:en:2026-11-21:v160:n47:weekly-notice',
    }));
    expect(exact.item).toMatchObject({ issueDate: '2026-11-21', title: 'Weekly Gazette consultation' });
  });

  it('requires the opt-in preview binding', () => {
    expect(() => gazetteDatabase({})).toThrowError(AccessError);
    expect(() => gazetteDatabase({ GAZETTE_PREVIEW: 'on' })).toThrowError(AccessError);
    expect(gazetteDatabase({ GAZETTE_PREVIEW: 'on', GAZETTE_DB: store.db })).toBe(store.db);
  });

  it('publishes a generated OpenAPI contract for filters, exact lookup, errors, coverage, and source policy', () => {
    const api = gazetteOpenApi();
    expect(api.openapi).toBe('3.1.0');
    expect(api.paths['/api/gazette'].get.parameters.map((item: { name: string }) => item.name))
      .toEqual(['topic', 'part', 'language', 'editionType', 'since', 'until', 'limit']);
    expect(api.paths['/api/gazette/{id}'].get.responses[200]).toBeDefined();
    const example = api.paths['/api/gazette/changes'].get.responses[200].content['application/json'].example;
    expect(SourceFeedResponseSchema.parse(example).scope.source).toBe('gazette');
    expect(api['x-source-policy']).toMatchObject({ redistribution: 'metadata-only' });
    expect(JSON.stringify(api)).toContain('available');
    expect(JSON.stringify(api)).toContain('503');
  });
});
