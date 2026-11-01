import { describe, expect, it } from 'vitest';
import { loadActTitles } from '../src/corpora/act-titles';
import { testD1 } from './helpers/d1';

function populate(fixture: ReturnType<typeof testD1>, act: string) {
  fixture.sqlite.prepare(`INSERT INTO statute_sections(id,corpus_id,act,citation,section,status,text,source_url,jurisdiction,in_force,language)
    VALUES('row','statutes-canada',?,'T-1','1','in-force','Text','https://example.test','CA',1,'en')`).run(act);
  fixture.sqlite.exec("INSERT INTO corpus_state(corpus_id,commit_sha,commit_date,as_of,row_count,last_run_at) VALUES('statutes-canada','revision1','2026-10-22','2026-10-22',1,'2026-10-22')");
}
describe('citation title revision boundaries', () => {
  it('never reuses another database or an obsolete published revision', async () => {
    const first = testD1();
    const second = testD1();
    try {
      populate(first, 'First Act');
      populate(second, 'Second Act');
      expect(await loadActTitles({ CIVIC_DB: first.db })).toEqual(['First Act']);
      expect(await loadActTitles({ CIVIC_DB: second.db })).toEqual(['Second Act']);
      first.sqlite.exec("UPDATE statute_sections SET act='New Act'; UPDATE corpus_state SET commit_sha='revision2'");
      expect(await loadActTitles({ CIVIC_DB: first.db })).toEqual(['New Act']);
    } finally { first.close(); second.close(); }
  });
});
