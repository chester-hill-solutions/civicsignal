import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  CommitteeCallDetailResponseSchema,
  CommitteeCallsResponseSchema,
  CommitteeCorpusCoverageSchema,
  CommitteeCorpusPageSchema,
  CommitteeCorpusSearchResponseSchema,
  CommitteeDetailResponseSchema,
  CommitteePassagesResponseSchema,
} from '../src/corpora/committee-corpus';
import type { Env } from '../src/types';
import { committeeStudyOpenApi } from '../src/routes/committee-study-openapi';
import { COMMITTEE_CORPUS_PATH, matchCommitteeCorpusRoute, prepareCommitteeCorpus } from '../src/routes/committee-corpus';
import { testD1 } from './helpers/d1';

describe('committee corpus HTTP contract', () => {
  it('recognizes the corpus routes and enforces the API prefix', () => {
    expect(matchCommitteeCorpusRoute('/api/committees/45-1')).toEqual({ op: 'session', session: '45-1' });
    expect(matchCommitteeCorpusRoute('/api/committees/45-1/house-envi/studies'))
      .toEqual({ op: 'studies', session: '45-1', id: 'house-envi' });
    expect(matchCommitteeCorpusRoute('/api/committees/45-1/documents/shared-file/passages'))
      .toEqual({ op: 'passages', session: '45-1', id: 'shared-file' });
    expect(matchCommitteeCorpusRoute('/api/committees/45-1/calls')).toEqual({ op: 'calls', session: '45-1' });
    expect(matchCommitteeCorpusRoute('/api/committees/45-1/calls/house-hesa-call-13632808'))
      .toEqual({ op: 'call', session: '45-1', id: 'house-hesa-call-13632808' });
    expect(matchCommitteeCorpusRoute('/api/committees/45-1/calls/a/b')).toBeUndefined();
    expect(matchCommitteeCorpusRoute('/api/committees/search')).toEqual({ op: 'search' });
    expect(matchCommitteeCorpusRoute('/unrelated/45-1')).toBeUndefined();
    expect(matchCommitteeCorpusRoute('/api/committees/45-1/not%20an%20id')).toBeUndefined();
  });

  it('validates preview access, language, search input and bounded pagination before reading', () => {
    const prepare = (path: string) => prepareCommitteeCorpus(new URL(`https://example.test${path}`));
    expect(() => prepare(`${COMMITTEE_CORPUS_PATH}/coverage`)?.({} as Env)).toThrow(/disabled/);

    const env = {
      COMMITTEE_CORPUS_PREVIEW: 'on',
      COMMITTEE_DB: {} as D1Database,
    } as Env;
    expect(() => prepare(`${COMMITTEE_CORPUS_PATH}/search?query=water`)?.(env)).toThrow(/language/);
    expect(() => prepare(`${COMMITTEE_CORPUS_PATH}/search?query=x&language=en&limit=101`)?.(env)).toThrow(/limit/);
    expect(() => prepare(`${COMMITTEE_CORPUS_PATH}/search?query=x&language=de`)?.(env)).toThrow(/language/);
    expect(prepare(`${COMMITTEE_CORPUS_PATH}/search?query=water&language=fr&limit=10`)?.(env)).toBeTypeOf('function');
    expect(() => prepare(`${COMMITTEE_CORPUS_PATH}/45-1/calls?status=maybe`)?.(env)).toThrow(/open, closed or unknown/);
    expect(() => prepare(`${COMMITTEE_CORPUS_PATH}/45-1/calls?asOf=not-a-date`)?.(env)).toThrow(/ISO date/);
    expect(() => prepare(`${COMMITTEE_CORPUS_PATH}/45-1/calls?query=`)?.(env)).toThrow(/256/);
    expect(prepare(`${COMMITTEE_CORPUS_PATH}/45-1/calls?status=open&asOf=2026-11-24`)?.(env)).toBeTypeOf('function');
  });

  it('advertises the committee routes and keeps the freshwater brief contract', () => {
    const api = committeeStudyOpenApi();
    expect(api.paths[`${COMMITTEE_CORPUS_PATH}/search`]?.get.operationId).toBe('searchCommitteeCorpus');
    expect(api.paths[`${COMMITTEE_CORPUS_PATH}/coverage`]?.get.operationId).toBe('getCommitteeCorpusCoverage');
    expect(api.paths[`${COMMITTEE_CORPUS_PATH}/{session}/calls`]?.get.operationId).toBe('listCommitteeCalls');
    expect(api.paths[`${COMMITTEE_CORPUS_PATH}/{session}/calls/{callId}`]?.get.operationId).toBe('getCommitteeCall');
    expect(api.paths[`${COMMITTEE_CORPUS_PATH}/{session}/documents/{documentId}/passages`]?.get.description)
      .toContain('400 characters');
    expect(api.paths['/api/committees/house/ENVI/studies/freshwater/brief']?.get.operationId)
      .toBe('getHouseEnviFreshwaterStudyBrief');
  });

  it('runs coverage, relationship traversal, rights-aware search and pagination against SQLite', async () => {
    const schema = readFileSync('preview/committees/migrations/0001_committee_preview.sql', 'utf8');
    const fixture = testD1({ schema });
    const { db } = fixture;
    const put = (record: { id: string; language?: 'en' | 'fr'; kind: string; chamber: string | null; committee: string | null;
      status: string; metadata?: object }) => db.prepare('INSERT INTO cc_records VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .bind('45-1', record.id, record.language ?? 'en', record.kind, record.chamber, record.committee, `Title ${record.id} ${record.language ?? 'en'}`,
        `https://example.org/${record.id}`, record.status, JSON.stringify(record.metadata ?? {}), null).run();

    await put({ id: 'house-envi', kind: 'committee', chamber: 'house', committee: 'house-envi', status: 'indexed', metadata: {
      directoryCutoffs: { studies: '2026-11-20T00:00:00Z', meetings: '2026-11-21T00:00:00Z' },
    } });
    await put({ id: 'joint-env', kind: 'committee', chamber: 'joint', committee: null, status: 'indexed' });
    await put({ id: 'house-envi', language: 'fr', kind: 'committee', chamber: 'house', committee: null, status: 'indexed' });
    await put({ id: 'water-study', kind: 'study', chamber: 'house', committee: 'house-envi', status: 'indexed' });
    await put({ id: 'water-study', language: 'fr', kind: 'study', chamber: 'house', committee: 'house-envi', status: 'indexed' });
    await put({ id: 'water-meeting', kind: 'meeting', chamber: 'house', committee: 'house-envi', status: 'indexed' });
    await put({ id: 'shared-pdf', kind: 'submission', chamber: 'house', committee: 'house-envi', status: 'searchable', metadata: {
      delivery: 'metadata-only', authors: ['A. Writer'], credits: [{ organization: 'Committee publishing service' }],
    } });
    await put({ id: 'excerpt-evidence', kind: 'evidence', chamber: 'house', committee: 'house-envi', status: 'searchable', metadata: {
      delivery: 'excerpt', credits: [{ submitter: 'Witness' }],
    } });
    await put({ id: 'missing-pdf', kind: 'submission', chamber: 'house', committee: 'house-envi', status: 'unavailable' });
    await put({ id: 'stored-brief', kind: 'brief', chamber: 'house', committee: 'house-envi', status: 'stored' });
    await put({ id: 'shared-pdf', language: 'fr', kind: 'submission', chamber: 'house', committee: 'house-envi', status: 'searchable', metadata: { delivery: 'metadata-only' } });
    await db.prepare('INSERT INTO cc_links VALUES(?,?,?,?,?)')
      .bind('45-1', 'en', 'water-study', 'shared-pdf', 'submission').run();
    await db.prepare('INSERT INTO cc_links VALUES(?,?,?,?,?)')
      .bind('45-1', 'en', 'house-envi', 'water-study', 'committee').run();
    await db.prepare('INSERT INTO cc_links VALUES(?,?,?,?,?)')
      .bind('45-1', 'fr', 'water-study', 'shared-pdf', 'submission').run();
    await db.prepare('INSERT INTO cc_snapshot VALUES(?,?)').bind('45-1', '2026-11-23T00:00:00Z').run();

    const sqlite = fixture.sqlite as unknown as DatabaseSync;
    sqlite.prepare('INSERT INTO cc_passages VALUES(?,?,?,?,?,?,?,?)')
      .run('45-1', 'en', 'shared-pdf', 0, 'page 2', 'secret indexed drinking water material', null, null);
    sqlite.prepare('INSERT INTO cc_passages VALUES(?,?,?,?,?,?,?,?)')
      .run('45-1', 'en', 'excerpt-evidence', 0, 'turn 1', 'x'.repeat(600), 'Witness', 'Example group');
    sqlite.prepare('INSERT INTO cc_passages VALUES(?,?,?,?,?,?,?,?)')
      .run('45-1', 'fr', 'shared-pdf', 0, 'page 2', 'eau potable et santé publique', null, null);
    sqlite.prepare('INSERT INTO cc_fts(rowid,session,language,document_id,position,text) SELECT rowid,session,language,document_id,position,text FROM cc_passages').run();

    const env = { COMMITTEE_CORPUS_PREVIEW: 'on', COMMITTEE_DB: db } as Env;
    const read = async (path: string): Promise<unknown> => {
      const handler = prepareCommitteeCorpus(new URL(`https://example.test${path}`))?.(env);
      if (!handler) throw new Error(`No committee handler matched ${path}.`);
      return handler();
    };

    const search = CommitteeCorpusSearchResponseSchema.parse(await read(
      '/api/committees/search?query=drinking%20water&language=en&session=45-1',
    ));
    expect(search.items[0]).toMatchObject({
      text: null,
      authors: ['A. Writer'],
      credits: [{ organization: 'Committee publishing service' }],
      parents: [
        { id: 'water-study', kind: 'study', relation: 'submission', direction: 'parent' },
        { id: 'house-envi', kind: 'committee', relation: 'committee', direction: 'parent' },
      ],
    });
    expect(JSON.stringify(search)).not.toContain('secret indexed');
    const frenchSearch = CommitteeCorpusSearchResponseSchema.parse(await read(
      '/api/committees/search?query=eau%20potable&language=fr&session=45-1',
    ));
    expect(frenchSearch.items).toHaveLength(1);
    expect(frenchSearch.items[0]?.citation.title).toBe('Title shared-pdf fr');
    expect(frenchSearch.items[0]?.text).toBeNull();

    const excerpts = CommitteePassagesResponseSchema.parse(await read(
      '/api/committees/45-1/documents/excerpt-evidence/passages?language=en',
    ));
    expect(excerpts.state).toBe('found');
    if (excerpts.state === 'found') expect(excerpts.items[0]?.text).toHaveLength(400);
    const hidden = CommitteePassagesResponseSchema.parse(await read(
      '/api/committees/45-1/documents/shared-pdf/passages?language=en',
    ));
    if (hidden.state === 'found') expect(hidden.items[0]?.text).toBeNull();

    const studies = CommitteeCorpusPageSchema.parse(await read('/api/committees/45-1/house-envi/studies'));
    expect(studies.items.map(record => record.language)).toEqual(['en', 'fr']);
    const studyDetail = CommitteeDetailResponseSchema.parse(await read('/api/committees/45-1/house-envi/studies/water-study?language=en'));
    if (studyDetail.state === 'found') {
      expect(studyDetail.links).toContainEqual({
        id: 'house-envi', kind: 'committee', relation: 'committee', direction: 'parent',
      });
    }
    expect(await read('/api/committees/45-1/no-such/studies')).toMatchObject({ state: 'not-found' });
    const committees = CommitteeCorpusPageSchema.parse(await read('/api/committees/45-1'));
    expect(committees.items.map(record => record.id)).toEqual(['house-envi', 'house-envi', 'joint-env']);
    const committeeDetail = CommitteeDetailResponseSchema.parse(await read('/api/committees/45-1/house-envi?language=en'));
    if (committeeDetail.state === 'found') {
      expect(committeeDetail.links.filter(link => link.id === 'house-envi')).toHaveLength(0);
      expect(committeeDetail.links.filter(link => link.id === 'water-study')).toHaveLength(1);
      expect(committeeDetail.links).toContainEqual({
        id: 'water-study', kind: 'study', relation: 'committee', direction: 'child',
      });
      expect(committeeDetail.links).toContainEqual({
        id: 'water-meeting', kind: 'meeting', relation: 'committee', direction: 'child',
      });
    }
    expect(await read('/api/committees/45-1?limit=1')).toMatchObject({ offset: 0, limit: 1, hasMore: true });
    expect(await read('/api/committees/45-1/documents/unknown?language=en'))
      .toMatchObject({ state: 'not-found', id: 'unknown' });
    expect(await read('/api/committees/45-1/documents/house-envi?language=en'))
      .toMatchObject({ state: 'not-found', id: 'house-envi' });
    expect(await read('/api/committees/45-1/documents/water-study?language=en'))
      .toMatchObject({ state: 'not-found', id: 'water-study' });
    expect(await read('/api/committees/45-1/documents/water-meeting?language=en'))
      .toMatchObject({ state: 'not-found', id: 'water-meeting' });
    expect(await read('/api/committees/45-1/documents/unknown/passages?language=en'))
      .toMatchObject({ state: 'not-found', id: 'unknown' });
    expect(await read('/api/committees/45-1/house-envi/studies/shared-pdf?language=en'))
      .toMatchObject({ state: 'not-found', id: 'shared-pdf' });

    const document = CommitteeDetailResponseSchema.parse(await read('/api/committees/45-1/documents/shared-pdf?language=en'));
    expect(document.state).toBe('found');
    if (document.state === 'found') {
      expect(document.record.metadata.credits).toEqual([{ organization: 'Committee publishing service' }]);
      expect(document.links).toContainEqual({ id: 'water-study', kind: 'study', relation: 'submission', direction: 'parent' });
    }
    const coverage = CommitteeCorpusCoverageSchema.parse(await read('/api/committees/coverage?session=45-1&limit=1'));
    expect(coverage).toMatchObject({
      session: '45-1', cutoff: '2026-11-23T00:00:00Z',
      outstanding: { total: 2, hasMore: true },
    });
    expect(coverage.counts).toContainEqual({
      committeeId: 'house-envi', chamber: 'house', language: 'en', kind: 'submission', status: 'unavailable', count: 1,
      directoryCutoffs: { studies: '2026-11-20T00:00:00Z', meetings: '2026-11-21T00:00:00Z' },
    });
    const laterGaps = CommitteeCorpusCoverageSchema.parse(await read('/api/committees/coverage?session=45-1&limit=1&offset=1'));
    expect(laterGaps.outstanding.ids).toHaveLength(1);
    fixture.close();
  });

  it('serves a published call for the queried date and links it to its study', async () => {
    const schema = readFileSync('preview/committees/migrations/0001_committee_preview.sql', 'utf8');
    const fixture = testD1({ schema });
    const { db } = fixture;
    const put = (record: { id: string; language?: 'en' | 'fr'; kind: string; chamber?: string | null;
      committee: string | null; title?: string; status?: string; metadata?: object }) =>
      db.prepare('INSERT INTO cc_records VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .bind('45-1', record.id, record.language ?? 'en', record.kind, record.chamber ?? 'house', record.committee,
          record.title ?? `Title ${record.id}`, `https://example.org/${record.id}`, record.status ?? 'indexed',
          JSON.stringify(record.metadata ?? {}), null).run();
    const deadline = { text: 'before 11:59 p.m. (EST) on Monday, November 30, 2026',
      instant: '2026-12-01T04:59:00Z', timeZone: 'EST' };
    const call = (id: string, extra: object) => ({
      delivery: 'excerpt', studyId: id.replace(/^.*-study-/, ''), listingUrl: 'https://example.org/participate',
      instructionUrl: 'https://example.org/submit-brief/hesa/1', instructions: 'x'.repeat(600),
      contentWarning: false, observedAt: '2026-11-24T12:00:00Z', firstObservedAt: '2026-11-24T12:00:00Z', ...extra,
    });
    await put({ id: 'house-hesa', kind: 'committee', committee: 'house-hesa', title: 'Standing Committee on Health' });
    await put({ id: 'house-hesa-study-13632808', kind: 'study', committee: 'house-hesa', title: 'Diagnostic Imaging Capacity' });
    await put({ id: 'house-hesa-call-13632808', kind: 'call', committee: 'house-hesa',
      title: 'Diagnostic Imaging Capacity', metadata: call('house-hesa-study-13632808', { deadline }) });
    await put({ id: 'house-hesa-call-13145156', kind: 'call', committee: 'house-hesa',
      title: 'Opioid Epidemic', metadata: call('house-hesa-study-13145156', {
        deadline: { text: 'before ...', instant: '2026-11-01T04:59:00Z', timeZone: 'EST' } }) });
    await put({ id: 'house-hesa-call-13604489', kind: 'call', committee: 'house-hesa',
      title: 'Food Price Inflation', metadata: call('house-hesa-study-13604489', { deadline: null }) });
    await put({ id: 'house-hesa-call-13604490', kind: 'call', committee: 'house-hesa',
      title: 'Employment Insurance Parental Leave', metadata: call('house-hesa-study-13604490', {
        deadline: null, listed: false, lastListedAt: '2026-11-24T12:00:00Z' }) });
    await put({ id: 'house-hesa-call-13632806', kind: 'call', committee: 'house-hesa',
      title: 'Conflicting motion', metadata: call('house-hesa-study-13632806', {
        deadline: null, contentConflict: true, pendingDigest: 'a'.repeat(64) }) });
    await put({ id: 'house-hesa-call-13631120', language: 'fr', kind: 'call', committee: 'house-hesa',
      title: 'Risques pour la science', metadata: call('house-hesa-study-13631120', { delivery: 'metadata-only' }) });
    await put({ id: 'house-hesa-submission-1', kind: 'submission', committee: 'house-hesa', status: 'searchable',
      metadata: { delivery: 'metadata-only' } });
    await put({ id: 'house-hesa-notice-1', kind: 'notice', committee: 'house-hesa', status: 'searchable' });
    await db.prepare('INSERT INTO cc_links VALUES(?,?,?,?,?)').bind('45-1', 'en', 'house-hesa-study-13632808', 'house-hesa-submission-1', 'study-publication').run();
    await db.prepare('INSERT INTO cc_links VALUES(?,?,?,?,?)').bind('45-1', 'en', 'house-hesa-study-13632808', 'house-hesa-notice-1', 'study-publication').run();

    const env = { COMMITTEE_CORPUS_PREVIEW: 'on', COMMITTEE_DB: db } as Env;
    const read = async (path: string): Promise<unknown> => {
      const handler = prepareCommitteeCorpus(new URL(`https://example.test${path}`))?.(env);
      if (!handler) throw new Error(`No committee handler matched ${path}.`);
      return handler();
    };

    const open = CommitteeCallsResponseSchema.parse(await read('/api/committees/45-1/calls?language=en&asOf=2026-11-24T18:00:00Z'));
    expect(open.items.map(item => [item.id, item.status, item.statusBasis])).toEqual([
      ['house-hesa-call-13145156', 'closed', 'deadline'],
      ['house-hesa-call-13604489', 'open', 'listing-observation'],
      ['house-hesa-call-13604490', 'open', 'listing-observation'],
      ['house-hesa-call-13632806', 'open', 'listing-observation'],
      ['house-hesa-call-13632808', 'open', 'deadline'],
    ]);
    expect(open.items.find(item => item.id === 'house-hesa-call-13632808')).toMatchObject({
      title: 'Diagnostic Imaging Capacity', contentWarning: false,
      committee: { id: 'house-hesa', name: 'Standing Committee on Health' },
      study: { id: 'house-hesa-study-13632808', title: 'Diagnostic Imaging Capacity' },
      deadline: { instant: '2026-12-01T04:59:00Z', timeZone: 'EST' },
      instructionsTruncated: true,
    });
    expect(open.items.find(item => item.id === 'house-hesa-call-13632808')?.instructions).toHaveLength(400);

    const filtered = CommitteeCallsResponseSchema.parse(await read('/api/committees/45-1/calls?language=en&status=open&asOf=2026-11-24T18:00:00Z'));
    expect(filtered.items.map(item => item.id)).toEqual([
      'house-hesa-call-13604489', 'house-hesa-call-13604490',
      'house-hesa-call-13632806', 'house-hesa-call-13632808']);
    const dropped = CommitteeCallsResponseSchema.parse(await read('/api/committees/45-1/calls?language=en&asOf=2026-11-25T12:00:00Z'));
    expect(dropped.items.find(item => item.id === 'house-hesa-call-13604490')).toMatchObject({
      listed: false, status: 'unknown', statusBasis: 'listing-observation',
      lastListedAt: '2026-11-24T12:00:00.000Z',
    });
    expect(dropped.items.find(item => item.id === 'house-hesa-call-13604489')?.listed).toBe(true);
    expect(dropped.items.find(item => item.id === 'house-hesa-call-13632806')).toMatchObject({
      contentConflict: true, pendingChange: true, listed: true,
    });
    const beforeObservation = CommitteeCallsResponseSchema.parse(await read('/api/committees/45-1/calls?language=en&asOf=2026-11-01T00:00:00Z'));
    expect(beforeObservation.items.every(item => item.status === 'unknown' && item.statusBasis === 'unobserved')).toBe(true);
    const afterObservation = CommitteeCallsResponseSchema.parse(await read('/api/committees/45-1/calls?language=en&asOf=2026-11-30T18:00:00Z'));
    expect(afterObservation.items.find(item => item.id === 'house-hesa-call-13604489')?.status).toBe('unknown');
    const french = CommitteeCallsResponseSchema.parse(await read('/api/committees/45-1/calls?language=fr&asOf=2026-11-24T18:00:00Z'));
    expect(french.items[0]).toMatchObject({ instructions: null, instructionsTruncated: false });

    const detail = CommitteeCallDetailResponseSchema.parse(await read('/api/committees/45-1/calls/house-hesa-call-13632808?language=en&asOf=2026-11-24T18:00:00Z'));
    expect(detail.state).toBe('found');
    if (detail.state === 'found') {
      expect(detail.related).toEqual({ submissions: 1, evidence: 0, meetings: 0 });
      expect(detail.item.study?.id).toBe('house-hesa-study-13632808');
    }
    expect(await read('/api/committees/45-1/calls/house-hesa-call-13632808?language=fr&asOf=2026-11-24T18:00:00Z'))
      .toMatchObject({ state: 'not-found', id: 'house-hesa-call-13632808' });
    fixture.close();
  });
});
