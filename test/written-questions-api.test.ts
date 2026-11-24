import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccessError } from '../src/access';
import { writtenQuestionOpenApi } from '../src/routes/written-questions-openapi';
import {
  matchWrittenQuestionRoute, parseWrittenQuestionRequest, runWrittenQuestionRequest, writtenQuestionDatabase,
} from '../src/routes/written-questions';
import { testD1 } from './helpers/d1';
import worker from '../src/index';
import type { Env } from '../src/types';

const migration = readFileSync('preview/written-questions/migrations/0001_written_questions.sql', 'utf8');

describe('written-question HTTP API', () => {
  let store: ReturnType<typeof testD1>;
  beforeEach(() => { store = testD1({ schema: migration }); });
  afterEach(() => store.close());

  function insertQuestion(language: 'en' | 'fr' = 'en') {
    const url = language === 'en' ? 'https://www.ourcommons.ca/written-questions/45-1/q-17' : 'https://www.ourcommons.ca/questions-ecrites/45-1/q-17';
    store.sqlite.prepare(`INSERT INTO questions
      (session, number, language, url, text, status, member_id, member_name, asked_on, metadata_json, source_hash, acquisition)
      VALUES ('45-1', 17, ?, ?, ?, 'Answered', 'm-17', 'A. Member', '2026-01-15', '{}', ?, 'gap')`)
      .run(language, url, 'What funding supports rural water systems?', 'a'.repeat(64));
    return url;
  }

  it('matches search, exact bilingual lookup, and coverage routes', () => {
    expect(matchWrittenQuestionRoute('/api/written-questions')).toEqual({ operation: 'search' });
    expect(matchWrittenQuestionRoute('/api/written-questions/coverage')).toEqual({ operation: 'coverage' });
    expect(matchWrittenQuestionRoute('/api/written-questions/45-1/17/fr')).toEqual({
      operation: 'lookup', session: '45-1', number: 17, language: 'fr',
    });
    expect(matchWrittenQuestionRoute('/api/written-questions/45-1/17/fr/nested')).toBeUndefined();
    const route = matchWrittenQuestionRoute('/api/written-questions');
    if (!route) throw new Error('Search route should match.');
    expect(parseWrittenQuestionRequest(route, new URL('https://example.test/api/written-questions?query=water+funding&language=en&kind=reply&session=45-1&limit=4')))
      .toMatchObject({ operation: 'search', query: { query: 'water funding', language: 'en', kind: 'reply', limit: 4 } });
    for (const query of [
      'query=x&language=en&extra=1', 'query=x&query=y&language=en', 'query=x&language=en&limit=0',
      'query=x&language=en&kind=senate',
    ]) expect(() => parseWrittenQuestionRequest(route, new URL(`https://example.test/api/written-questions?${query}`))).toThrow();
    const exact = matchWrittenQuestionRoute('/api/written-questions/45-1/17/en');
    if (!exact) throw new Error('Exact route should match.');
    expect(() => parseWrittenQuestionRequest(exact, new URL('https://example.test/api/written-questions/45-1/17/en?language=fr'))).toThrow();
  });

  it('returns bilingual exact questions, all answer states and exact source citations', async () => {
    const url = insertQuestion();
    insertQuestion('fr');
    store.sqlite.prepare(`INSERT INTO documents
      (session, number, language, doc_key, kind, respondent, title, url, text, text_chars, chunk_count, availability, metadata_json)
      VALUES ('45-1', 17, 'en', 'attachment-1', 'attachment', NULL, 'T table', ?, '', 0, 0, 'gap', '{}')`)
      .run(`${url}#attachment-1`);
    store.sqlite.prepare(`INSERT INTO documents
      (session, number, language, doc_key, kind, respondent, title, url, text, text_chars, chunk_count, availability, metadata_json)
      VALUES ('45-1', 17, 'en', 'reply-1', 'reply', 'Department of Infrastructure', 'Government Response', ?, ?, 82, 1, 'searchable', '{}')`)
      .run(`${url}#reply-1`, 'The department allocated funds to rural water systems through a regional program.');
    store.sqlite.prepare(`INSERT INTO document_chunks VALUES ('45-1', 17, 'en', 'reply-1', 0, ?, ?)`)
      .run('The department allocated funds to rural water systems through a regional program.', 'The department allocated funds to rural water systems through a regional program.');
    store.sqlite.prepare(`INSERT INTO documents
      (session, number, language, doc_key, kind, respondent, title, url, text, text_chars, chunk_count, availability, metadata_json)
      VALUES ('45-1', 17, 'en', 'cover-page', 'cover_page', 'Department of Infrastructure', 'Response cover',
        'https://na01.alma.exlibrisgroup.com/view/delivery/01CALP_INST/123/456', '', 0, 0, 'gap', '{"file_language":"b"}')`).run();
    store.sqlite.prepare(`INSERT INTO wq_fts (session, number, language, doc_key, chunk_index, text) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('45-1', '17', 'en', '', 0, 'What funding supports rural water systems?');
    store.sqlite.prepare(`INSERT INTO wq_fts (session, number, language, doc_key, chunk_index, text) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('45-1', '17', 'en', 'reply-1', 0, 'The department allocated funds to rural water systems through a regional program.');

    const lookup = await runWrittenQuestionRequest(store.db, { operation: 'lookup', session: '45-1', number: 17, language: 'en' });
    expect(lookup).toMatchObject({ state: 'found', question: { memberId: 'm-17', askedOn: '2026-01-15', sourceHash: 'a'.repeat(64),
        attribution: { publisher: 'House of Commons of Canada', surrogate: null } }, answerState: 'partial', documents: expect.any(Array) });
    if (!('documents' in lookup)) throw new Error('The written-question edition should be found.');
    expect(lookup.documents).toEqual(expect.arrayContaining([
      { session: '45-1', number: 17, language: 'en', documentKey: 'attachment-1', kind: 'attachment',
        respondent: null, title: 'T table', url: `${url}#attachment-1`, text: '', objectSha256: null, metadata: {},
        attribution: { publisher: 'House of Commons of Canada', surrogate: null }, textChars: 0, chunkCount: 0, hasMore: false,
        fileLanguage: null, availability: 'gap' },
      { session: '45-1', number: 17, language: 'en', documentKey: 'cover-page', kind: 'cover_page',
        respondent: 'Department of Infrastructure', title: 'Response cover', url: 'https://na01.alma.exlibrisgroup.com/view/delivery/01CALP_INST/123/456',
        text: '', objectSha256: null, metadata: { file_language: 'b' },
        attribution: { publisher: 'House of Commons of Canada', surrogate: 'Library of Parliament' },
        textChars: 0, chunkCount: 0, hasMore: false, fileLanguage: 'b', availability: 'gap' },
    ]));
    expect(await runWrittenQuestionRequest(store.db, { operation: 'lookup', session: '45-1', number: 17, language: 'fr' }))
      .toMatchObject({ state: 'found', question: { language: 'fr' }, documents: [], answerState: 'gap' });
    expect(await runWrittenQuestionRequest(store.db, { operation: 'lookup', session: '45-1', number: 18, language: 'en' }))
      .toEqual({ state: 'not-found', session: '45-1', number: 18, language: 'en' });

    expect(await runWrittenQuestionRequest(store.db, {
      operation: 'search', query: { query: 'department allocated funds', language: 'en', kind: 'reply', limit: 10 },
    })).toMatchObject({ count: 1, coverageBasis: 'materialized-records', items: [{
      kind: 'reply', session: '45-1', number: 17, language: 'en', memberId: 'm-17', memberName: 'A. Member',
      respondent: 'Department of Infrastructure', citationUrl: `${url}#reply-1`, availability: 'searchable',
      sourceHash: 'a'.repeat(64), fileLanguage: null, chunkIndex: 0, chunkCount: 1, textChars: 82, hasMore: false,
      attribution: { publisher: 'House of Commons of Canada', surrogate: null },
    }] });
    const chunksRoute = matchWrittenQuestionRoute('/api/written-questions/45-1/17/en/chunks');
    if (!chunksRoute) throw new Error('Text chunk route should match.');
    const chunksRequest = parseWrittenQuestionRequest(chunksRoute,
      new URL('https://example.test/api/written-questions/45-1/17/en/chunks?documentKey=reply-1'));
    expect(await runWrittenQuestionRequest(store.db, chunksRequest)).toMatchObject({
      documentKey: 'reply-1', sourceHash: 'a'.repeat(64), attribution: { publisher: 'House of Commons of Canada', surrogate: null },
      offset: 0, total: 1, hasMore: false, chunks: [{ index: 0, text: expect.stringContaining('allocated funds') }],
    });
  });

  it('reports materialized counts by language and enforces the opt-in preview state', async () => {
    insertQuestion('en');
    insertQuestion('fr');
    expect(await runWrittenQuestionRequest(store.db, { operation: 'coverage' })).toMatchObject({
      basis: 'materialized-records', coverage: [
        { session: '45-1', language: 'en', questions: 1, questionGaps: 1 },
        { session: '45-1', language: 'fr', questions: 1, questionGaps: 1 },
      ],
    });
    expect(() => writtenQuestionDatabase({ CIVIC_DB: store.db } as never)).toThrow(AccessError);
    expect(writtenQuestionDatabase({ CIVIC_DB: store.db, WRITTEN_QUESTIONS_PREVIEW: 'on' } as never)).toBe(store.db);
  });

  it('publishes the lookup, search, and coverage contracts', () => {
    const openapi = writtenQuestionOpenApi();
    expect(openapi.paths['/api/written-questions']?.get.operationId).toBe('searchWrittenQuestions');
    expect(openapi.paths['/api/written-questions/coverage']?.get.operationId).toBe('getWrittenQuestionCoverage');
    expect(openapi.paths['/api/written-questions/{session}/{number}/{language}']?.get.operationId).toBe('getWrittenQuestion');
    expect(openapi.paths['/api/written-questions/{session}/{number}/{language}/chunks']?.get.operationId).toBe('getWrittenQuestionTextChunks');
  });

  it('is mounted through the Worker entry point and exposes public OpenAPI', async () => {
    const context = { waitUntil: (_task: Promise<unknown>) => undefined } as ExecutionContext;
    const apiResponse = await worker.fetch(new Request('https://api.test/api/written-questions?query=water&language=en'), {} as Env, context);
    expect(apiResponse.status).toBe(401);
    const docsResponse = await worker.fetch(new Request('https://api.test/api/written-questions/openapi.json'), {} as Env, context);
    expect(docsResponse.status).toBe(200);
    expect(await docsResponse.json()).toMatchObject({ paths: { '/api/written-questions': { get: { operationId: 'searchWrittenQuestions' } } } });
  });
});
