import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { checkHouseLanguage } from '../services/daily-checks/house-calls';
import type { HousePacket } from '../services/house/publish';
import { prepareCommitteeCorpus } from '../src/routes/committee-corpus';
import { testD1 } from './helpers/d1';

it('compares newly dropped calls and detects an unreported listing or changed packet edition', async () => {
  const { db, sqlite, close } = testD1({ schema: readFileSync('preview/committees/migrations/0001_committee_preview.sql', 'utf8') });
  const observedAt = '2026-11-26T00:00:00.000Z';
  const asRow = (studyId: string, listed: boolean): HousePacket['calls'][number] => ({
    session: '45-1', id: 'house-fina-call-' + studyId, language: 'en', kind: 'call', chamber: 'house',
    committee_id: 'house-fina', title: 'Study ' + studyId, url: 'https://www.ourcommons.ca/' + studyId, status: 'indexed',
    metadata: { delivery: 'excerpt', termsUrl: 'https://apps.ourcommons.ca/en/important-notices', committeeCode: 'FINA',
      listingUrl: 'https://www.ourcommons.ca/Committees/en/Participate', studyId, instructions: null, instructionUrl: null,
      deadline: null, contentWarning: false, contentWarningText: null, listed, observedAt, firstObservedAt: observedAt,
      lastListedAt: observedAt, revision: 1, contentDigest: 'a'.repeat(64), pendingDigest: null, contentConflict: false },
  });
  const read = async (path: string, search: Record<string, string> = {}) => {
    const url = new URL('https://private.invalid' + path);
    url.search = new URLSearchParams(search).toString();
    const operation = prepareCommitteeCorpus(url);
    if (!operation) throw new Error('Missing committee operation.');
    return operation({ COMMITTEE_DB: db, COMMITTEE_CORPUS_PREVIEW: 'on' })();
  };
  try {
    const listed = asRow('1', true), dropped = asRow('2', false), old = asRow('3', false);
    const put = sqlite.prepare(`INSERT INTO cc_records (session,id,language,kind,chamber,committee_id,title,url,status,metadata_json)
      VALUES ('45-1',?,'en',?,'house','house-fina',?,?,'indexed',?)`);
    for (const row of [listed, dropped, old]) put.run(row.id, 'call', row.title, row.url, JSON.stringify(row.metadata));
    put.run('house-fina-study-1', 'study', listed.title, listed.url, '{}');
    put.run('house-fina-brief-1', 'brief', 'Brief', listed.url, '{}');
    sqlite.exec("INSERT INTO cc_links VALUES ('45-1','en','house-fina-study-1','house-fina-brief-1','submission')");
    const check = () => checkHouseLanguage(read, db, [listed, dropped], 'en', observedAt);
    expect(await check()).toMatchObject({ listed: 1, newlyDropped: 1, retainedUnlisted: 1,
      sample: { studyId: 'house-fina-study-1', related: { submissions: 1 } } });
    sqlite.exec("UPDATE cc_records SET title='Wrong' WHERE id='house-fina-call-2'");
    await expect(check()).rejects.toThrow('differs from captured packet');
    sqlite.prepare('UPDATE cc_records SET title=? WHERE id=?').run(dropped.title, dropped.id);
    sqlite.prepare('UPDATE cc_records SET metadata_json=? WHERE id=?').run(JSON.stringify({ ...old.metadata, listed: true }), old.id);
    await expect(check()).rejects.toThrow('listed edition absent');
  } finally { close(); }
});
