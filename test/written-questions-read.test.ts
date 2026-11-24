import { createRequire } from 'node:module';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  lookupWrittenQuestion, readWrittenQuestionCoverage, searchWrittenQuestions,
} from '../src/corpora/written-questions';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof SqliteDatabase };

describe('written-question local retrieval', () => {
  let db: SqliteDatabase;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE questions (
      session TEXT NOT NULL, number INTEGER NOT NULL, language TEXT NOT NULL, url TEXT NOT NULL,
      text TEXT NOT NULL, status TEXT NOT NULL, metadata_json TEXT NOT NULL, source_hash TEXT NOT NULL, acquisition TEXT NOT NULL,
      error TEXT, member_id TEXT, member_name TEXT, asked_on TEXT, PRIMARY KEY(session, number, language));
      CREATE TABLE documents (
      session TEXT NOT NULL, number INTEGER NOT NULL, language TEXT NOT NULL, doc_key TEXT NOT NULL,
      kind TEXT NOT NULL, respondent TEXT, title TEXT, url TEXT NOT NULL, text TEXT NOT NULL,
      object_sha256 TEXT, availability TEXT NOT NULL, metadata_json TEXT NOT NULL, PRIMARY KEY(session, number, language, doc_key));
      CREATE VIRTUAL TABLE wq_fts USING fts5(session UNINDEXED, number UNINDEXED, language UNINDEXED, doc_key UNINDEXED, text);`);
    db.prepare(`INSERT INTO questions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      '45-1', 17, 'en', 'https://www.ourcommons.ca/written-questions/45-1/q-17',
      'What funding supports rural water systems?', 'Answered', '{"published":true}', 'a'.repeat(64), 'complete', null,
      'm-17', 'A. Member', '2026-01-15');
    db.prepare(`INSERT INTO questions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      '45-1', 17, 'fr', 'https://www.ourcommons.ca/questions-ecrites/45-1/q-17',
      'Quel financement soutient les réseaux d’eau ruraux?', 'Answered', '{"published":true}', 'b'.repeat(64), 'complete', null,
      'm-17', 'A. Member', '2026-01-15');
    db.prepare(`INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      '45-1', 17, 'en', 'reply-main', 'reply', 'Department of Infrastructure', 'Government Response',
      'https://www.ourcommons.ca/written-questions/45-1/q-17#reply',
      'The department allocated funds to rural water systems through the regional program.', null, 'searchable', '{}');
    db.prepare(`INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      '45-1', 17, 'en', 'attachment-1', 'attachment', null, 'Tabled funding table',
      'https://www.ourcommons.ca/written-questions/45-1/q-17#attachment-1', '', null, 'gap', '{}');
    db.prepare(`INSERT INTO wq_fts VALUES (?, ?, ?, ?, ?)`).run(
      '45-1', '17', 'en', '', 'What funding supports rural water systems?');
    db.prepare(`INSERT INTO wq_fts VALUES (?, ?, ?, ?, ?)`).run(
      '45-1', '17', 'en', 'reply-main', 'The department allocated funds to rural water systems through the regional program.');
  });
  afterEach(() => db.close());

  it('returns exact question metadata, citations, and language with explicit answer gaps', () => {
    expect(lookupWrittenQuestion(db, '45-1', 17, 'en')).toMatchObject({
      state: 'found',
      question: {
        session: '45-1', number: 17, language: 'en',
        url: 'https://www.ourcommons.ca/written-questions/45-1/q-17',
        text: 'What funding supports rural water systems?', status: 'Answered', metadata: { published: true },
        sourceHash: 'a'.repeat(64), attribution: { publisher: 'House of Commons of Canada', surrogate: null },
        acquisition: 'complete', error: null, memberId: 'm-17', memberName: 'A. Member', askedOn: '2026-01-15',
      },
      documents: [
        {
          session: '45-1', number: 17, language: 'en', documentKey: 'attachment-1', kind: 'attachment',
          respondent: null, title: 'Tabled funding table',
          url: 'https://www.ourcommons.ca/written-questions/45-1/q-17#attachment-1', text: '', objectSha256: null,
          metadata: {}, attribution: { publisher: 'House of Commons of Canada', surrogate: null }, availability: 'gap',
          fileLanguage: null, textChars: 0, chunkCount: 0, hasMore: false,
        },
        {
          session: '45-1', number: 17, language: 'en', documentKey: 'reply-main', kind: 'reply',
          respondent: 'Department of Infrastructure', title: 'Government Response',
          url: 'https://www.ourcommons.ca/written-questions/45-1/q-17#reply',
          text: 'The department allocated funds to rural water systems through the regional program.',
          objectSha256: null, metadata: {}, attribution: { publisher: 'House of Commons of Canada', surrogate: null }, availability: 'searchable',
          fileLanguage: null, textChars: 83, chunkCount: 1, hasMore: false,
        },
      ],
      answerState: 'available',
    });
    expect(lookupWrittenQuestion(db, '45-1', 17, 'fr')).toMatchObject({ state: 'found', question: { language: 'fr' }, documents: [] });
    expect(lookupWrittenQuestion(db, '45-1', 18, 'en')).toEqual({ state: 'not-found', session: '45-1', number: 18, language: 'en' });
  });

  it('searches source text in question and answer passages with exact source URLs', () => {
    const results = searchWrittenQuestions(db, { language: 'en', query: 'department allocated funds', kind: 'reply' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'reply', session: '45-1', number: 17, language: 'en', documentKey: 'reply-main',
      memberId: 'm-17', memberName: 'A. Member', askedOn: '2026-01-15', respondent: 'Department of Infrastructure',
      sourceHash: 'a'.repeat(64), attribution: { publisher: 'House of Commons of Canada', surrogate: null },
      title: 'Government Response', text: 'The department allocated funds to rural water systems through the regional program.',
      citationUrl: 'https://www.ourcommons.ca/written-questions/45-1/q-17#reply', availability: 'searchable',
      chunkIndex: 0, chunkCount: 1, textChars: 83, hasMore: false, fileLanguage: null,
    });
    expect(searchWrittenQuestions(db, { language: 'fr', query: 'funding', kind: 'question' })).toEqual([]);
    expect(searchWrittenQuestions(db, { language: 'en', query: 'funding', kind: 'question' })[0]?.citationUrl)
      .toBe('https://www.ourcommons.ca/written-questions/45-1/q-17');
  });

  it('reports recorded coverage by language without hiding attachments with gaps', () => {
    expect(readWrittenQuestionCoverage(db, '45-1')).toEqual([
      {
        session: '45-1', language: 'en', questions: 1, complete: 1, pending: 0, questionGaps: 0,
        searchableReplies: 1, storedReplies: 0, replyGaps: 0,
        searchableAttachments: 0, storedAttachments: 0, attachmentGaps: 1,
      },
      {
        session: '45-1', language: 'fr', questions: 1, complete: 1, pending: 0, questionGaps: 0,
        searchableReplies: 0, storedReplies: 0, replyGaps: 0,
        searchableAttachments: 0, storedAttachments: 0, attachmentGaps: 0,
      },
    ]);
  });
});
