import { describe,expect,it } from 'vitest';
import { materializeFunding } from '../scripts/materialize-funding';
import { testD1 } from './helpers/d1';

const edition = (id: string, language: string, terms = 'A published condition') => ({
  id, language, title: 'Grant', url: 'https://nserc.canada.ca/' + language + '/' + id,
  status: 'ongoing', statusText: null, availability: 'published',
  sections: [{ field: 'eligibility', heading: 'Applicants', text: terms, url: 'https://nserc.canada.ca/' + language + '/terms' }],
});
const dated = (day: number, ids: string[]) => ({
  source: 'nserc', observedAt: '2026-11-' + day + 'T12:00:00Z',
  indexes: {en:'https://nserc.canada.ca/en/cci',fr:'https://nserc.canada.ca/fr/cci'}, gaps: [],
  records: ids.flatMap(id => ['en','fr'].map(language => edition(id,language))),
});
const a = 'nserc-alpha', b = 'nserc-beta';

describe('funding catalogue publication', () => {
  it('retains observed changes, removals and reappearance and rejects stale or partial replacements', () => {
    const f = testD1({schema:''});
    const publish = (packet:unknown) => materializeFunding(f.sqlite,packet);
    try {
      const start = dated(11,[a,b]);
      const first = publish(start);
      expect(first.events).toEqual({added:4,changed:0,removed:0});
      const replay = dated(12,[b,a]);
      expect(publish(replay)).toMatchObject({revision:first.revision,events:{added:0,changed:0,removed:0}});
      expect(() => publish(start)).toThrow(/newer/);
      const next = dated(13,[a]);
      next.records[0] = edition(a,'en','Updated terms');
      expect(publish(next).events).toEqual({added:0,changed:1,removed:2});
      expect(() => publish(dated(13,[a,b]))).toThrow(/conflicting/);
      expect(() => publish({...next,records:[...next.records,edition(b,'fr')]})).toThrow(/counterpart/);
      expect(publish(dated(14,[a,b])).events).toEqual({added:2,changed:1,removed:0});
      expect(f.sqlite.prepare("SELECT event FROM funding_versions WHERE id=? AND language='fr' ORDER BY observed_at").all(b).map(r=>r.event))
        .toEqual(['added','removed','added']);
    } finally {f.close();}
  });

  it('rolls back a failed history write together with the current edition', () => {
    const f = testD1({schema:''});
    try {
      const original = materializeFunding(f.sqlite,dated(11,[a]));
      f.sqlite.exec("CREATE TRIGGER fail_write BEFORE INSERT ON funding_versions BEGIN SELECT RAISE(ABORT,'test history failure'); END;");
      expect(() => materializeFunding(f.sqlite,dated(12,[a,b]))).toThrow(/history failure/);
      expect(f.sqlite.prepare('SELECT revision FROM funding_catalogues').get()?.revision).toBe(original.revision);
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM funding_editions').get()?.n).toBe(2);
    } finally {f.close();}
  });

  it('only changes indexed sections for the affected editions', () => {
    const f = testD1({schema:''});
    const sections = (id: string, language: string) => f.sqlite.prepare(
      'SELECT text,url,normalized_text FROM funding_sections WHERE source=? AND id=? AND language=? ORDER BY section_index',
    ).all('nserc', id, language);
    try {
      const start = dated(11,[a,b]);
      const english = start.records[0];
      english.sections.push({...english.sections[0], text:'Obsolete condition'});
      materializeFunding(f.sqlite,start);
      const unchanged = sections(a,'fr');
      for (const [operation, reference] of [['DELETE','OLD'], ['INSERT','NEW'], ['UPDATE','OLD']]) {
        f.sqlite.exec(`CREATE TRIGGER preserve_fr_${operation} BEFORE ${operation} ON funding_sections
          WHEN ${reference}.id='nserc-alpha' AND ${reference}.language='fr'
          BEGIN SELECT RAISE(ABORT, 'wrote unchanged French edition'); END`);
      }
      const next = dated(12,[a,'nserc-new']);
      next.records[0] = edition(a,'en','Updated terms');
      expect(materializeFunding(f.sqlite,next).events).toEqual({added:2,changed:1,removed:2});
      expect(sections(a,'en')).toEqual([{text:'Updated terms', url:'https://nserc.canada.ca/en/terms', normalized_text:'updated terms'}]);
      expect(sections(a,'fr')).toEqual(unchanged);
      expect(sections(b,'en')).toEqual([]);
      expect(sections(b,'fr')).toEqual([]);
      expect(sections('nserc-new','en')).toHaveLength(1);
      expect(sections('nserc-new','fr')).toHaveLength(1);
    } finally {f.close();}
  });
});
