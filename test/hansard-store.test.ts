import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importHansardEdition, importHansardSitting } from '../scripts/lib/hansard-store';
import { getHansardSpeech, hansardCorpus } from '../src/corpora/adapters';
import { HANSARD_FEDERAL } from '../src/corpora/policies';
import { MAX_HANSARD_XML_BYTES, parseHansardXml } from '../src/ingest/hansard';
import { testD1 } from './helpers/d1';

const en = readFileSync(new URL('./fixtures/hansard/sitting-en.xml', import.meta.url));
const fr = readFileSync(new URL('./fixtures/hansard/sitting-fr.xml', import.meta.url));
const original = en.toString('utf8');
const english = { sittingId: '45-1-999', sittingDate: '2026-04-01', edition: 'en' } as const;
const englishId = 'hansard:en:45-1-999:99002';
const frenchId = 'hansard:fr:45-1-999:99002';

function addSpeech(xml: string, id: string) {
  return Buffer.from(xml.replace('</OrderOfBusiness>', `<Intervention id="${id}">
    <PersonSpeaking><Affiliation>Another synthetic speaker</Affiliation></PersonSpeaking>
    <Content><ParaText>Debate on the budget.</ParaText></Content>
  </Intervention></OrderOfBusiness>`));
}

describe('local Hansard edition imports', () => {
  let store: ReturnType<typeof testD1>;

  beforeEach(() => { store = testD1(); });
  afterEach(() => { store.close(); });

  function insertSpeech(id: string, corpusId: string) {
    store.sqlite.prepare(`INSERT INTO hansard_speeches (id, corpus_id, speaker, sitting_date, excerpt, source_url, search_text)
      VALUES (?, ?, 'Fixture', '2026-04-01', 'Fixture', 'https://www.ourcommons.ca/fixture#turn', 'fixture')`).run(id, corpusId);
  }

  function excerpts() {
    return store.sqlite.prepare('SELECT id, excerpt FROM hansard_speeches ORDER BY id').all();
  }

  it('skips speech writes for the same bytes and imports when the byte digest or parser version changes', () => {
    const { sqlite } = store;
    expect(importHansardEdition(sqlite, en, english)).toEqual({ ...english, status: 'imported', written: 1, removed: 0 });
    const totalChanges = sqlite.prepare('SELECT total_changes() AS count');
    const initialChanges = totalChanges.get();
    const unchanged = { ...english, status: 'unchanged', written: 0, removed: 0 };
    expect(importHansardEdition(sqlite, en, english)).toEqual(unchanged);
    expect(importHansardEdition(sqlite, en)).toEqual(unchanged);
    expect(totalChanges.get()).toEqual(initialChanges);

    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), en]);
    expect(importHansardEdition(sqlite, withBom).status).toBe('imported');
    expect(importHansardEdition(sqlite, withBom)).toEqual(unchanged);
    sqlite.exec("UPDATE local_hansard_editions SET parser_version = 'older-version'");
    expect(importHansardEdition(sqlite, withBom).status).toBe('imported');
  });

  it('seeds the source feed when an unchanged legacy digest is replayed', () => {
    const { sqlite } = store;
    importHansardEdition(sqlite, en, english);
    sqlite.exec('DROP TABLE source_feed_events; DROP TABLE source_feed_editions; DROP TABLE source_feed_identity;');

    expect(importHansardEdition(sqlite, en, english).status).toBe('unchanged');
    expect(sqlite.prepare(`SELECT source, language, edition_id FROM source_feed_editions
      WHERE source = 'house'`).all()).toEqual([{ source: 'house', language: 'en', edition_id: english.sittingId }]);
    expect(sqlite.prepare(`SELECT kind, record_id FROM source_feed_events WHERE source = 'house'`).all()).toEqual([
      { kind: 'added', record_id: englishId },
    ]);
  });

  it('replaces the corrected edition, preserving stable IDs, other editions, sittings and corpora', async () => {
    const { sqlite, db } = store;
    importHansardEdition(sqlite, addSpeech(original, '99003'));
    importHansardEdition(sqlite, fr);
    insertSpeech('hansard:en:45-1-9990:99003', HANSARD_FEDERAL.id);
    insertSpeech('hansard:en:45-1-999:99004', 'hansard-provincial');
    const corrected = Buffer.from(original.replace('housing regulation', 'règlement révisé'));

    expect(importHansardEdition(sqlite, corrected)).toEqual({ ...english, status: 'imported', written: 1, removed: 1 });
    expect(excerpts().map(({ id }) => id)).toEqual([
      'hansard:en:45-1-9990:99003', englishId, 'hansard:en:45-1-999:99004', frenchId,
    ]);
    const ctx = { db, fetch, now: () => new Date() };
    expect(await hansardCorpus.retrieve({ topic: 'housing regulation', language: 'en' }, ctx)).toEqual([]);
    const hits = await hansardCorpus.retrieve({ topic: 'reglement revise', language: 'en' }, ctx);
    expect(hits.map(({ id }) => id)).toEqual([englishId]);
    expect(await getHansardSpeech(englishId, ctx)).toMatchObject({ excerpt: expect.stringContaining('règlement révisé') });
    expect(await getHansardSpeech(frenchId, ctx)).toMatchObject({ excerpt: expect.stringContaining('du règlement sur le logement') });
    expect(importHansardEdition(sqlite, fr).status).toBe('unchanged');
  });

  it('journals normalized House corrections without removing speeches omitted from the partial import', () => {
    const { sqlite } = store;
    importHansardEdition(sqlite, addSpeech(original, '99003'));
    const initialEvents = sqlite.prepare(`SELECT kind, record_id FROM source_feed_events
      WHERE source = 'house' AND language = 'en' AND edition_id = ? ORDER BY record_id`)
      .all(english.sittingId);
    expect(initialEvents).toEqual([
      { kind: 'added', record_id: englishId },
      { kind: 'added', record_id: 'hansard:en:45-1-999:99003' },
    ]);

    const parsed = parseHansardXml(original).sitting;
    const changed = parsed.speeches.map((entry) => ({ ...entry, excerpt: 'A normalized correction about housing.' }));
    expect(importHansardSitting(sqlite, { ...parsed, speeches: changed })).toEqual([englishId]);
    expect(excerpts()).toContainEqual({ id: 'hansard:en:45-1-999:99003', excerpt: expect.stringContaining('Debate on the budget.') });
    expect(sqlite.prepare(`SELECT kind, record_id, before_search, after_search FROM source_feed_events
      WHERE source = 'house' AND language = 'en' AND edition_id = ? ORDER BY seq`).all(english.sittingId)).toEqual([
      { kind: 'added', record_id: englishId, before_search: null, after_search: expect.any(String) },
      { kind: 'added', record_id: 'hansard:en:45-1-999:99003', before_search: null, after_search: expect.any(String) },
      { kind: 'corrected', record_id: englishId, before_search: expect.any(String), after_search: expect.any(String) },
    ]);
  });

  it('rolls back Hansard feed events when a source journal write fails', () => {
    const { sqlite } = store;
    importHansardEdition(sqlite, en, english);
    const priorEvents = sqlite.prepare('SELECT * FROM source_feed_events ORDER BY seq').all();
    sqlite.exec(`CREATE TRIGGER reject_feed_event BEFORE INSERT ON source_feed_events
      BEGIN SELECT RAISE(ABORT, 'feed write failed'); END`);
    expect(() => importHansardEdition(sqlite, Buffer.from(original.replace('housing regulation', 'revised housing'))))
      .toThrow('feed write failed');
    expect(excerpts()).toContainEqual({ id: englishId, excerpt: expect.stringContaining('housing regulation') });
    expect(sqlite.prepare('SELECT * FROM source_feed_events ORDER BY seq').all()).toEqual(priorEvents);
  });

  it('verifies sitting identity, date and language before accepting fresh or unchanged input', () => {
    const { sqlite } = store;
    const mismatches = [
      { ...english, sittingId: '45-1-998' },
      { ...english, sittingDate: '2026-04-02' },
      { ...english, edition: 'fr' as const },
    ];
    for (const expected of mismatches) {
      expect(() => importHansardEdition(sqlite, en, expected)).toThrow('metadata mismatch');
      expect(excerpts()).toEqual([]);
    }
    importHansardEdition(sqlite, en, english);
    const committed = excerpts();
    for (const expected of mismatches) {
      expect(() => importHansardEdition(sqlite, en, expected)).toThrow('metadata mismatch');
      expect(excerpts()).toEqual(committed);
    }
    expect(importHansardEdition(sqlite, en, english).status).toBe('unchanged');
  });

  it('rolls back corrections on cross-corpus conflicts and state write errors', () => {
    const { sqlite } = store;
    const initial = addSpeech(original, '99003');
    const conflictingId = 'hansard:en:45-1-999:99004';
    importHansardEdition(sqlite, initial);
    insertSpeech(conflictingId, 'hansard-provincial');
    const committed = excerpts();
    const corrected = original.replace('housing regulation', 'revised budget');
    expect(() => importHansardEdition(sqlite, addSpeech(corrected, '99004'))).toThrow('another corpus');
    expect(excerpts()).toEqual(committed);
    expect(importHansardEdition(sqlite, initial).status).toBe('unchanged');

    sqlite.exec(`CREATE TRIGGER reject_edition_update BEFORE UPDATE ON local_hansard_editions
      BEGIN SELECT RAISE(ABORT, 'state write failed'); END`);
    expect(() => importHansardEdition(sqlite, Buffer.from(corrected))).toThrow('state write failed');
    expect(excerpts()).toEqual(committed);
    expect(importHansardEdition(sqlite, initial).status).toBe('unchanged');
  });

  it('invalidates only the edition touched by a JSON import and restores it from the same XML bytes', () => {
    const { sqlite } = store;
    importHansardEdition(sqlite, en);
    importHansardEdition(sqlite, fr);
    const publication = parseHansardXml(original).sitting;
    const manual = publication.speeches.map((speech) => ({ ...speech, excerpt: 'Manual correction.' }));

    expect(importHansardSitting(sqlite, { ...publication, speeches: manual })).toEqual([englishId]);
    expect(excerpts()).toContainEqual({ id: englishId, excerpt: 'Manual correction.' });
    expect(importHansardEdition(sqlite, fr).status).toBe('unchanged');
    expect(importHansardEdition(sqlite, en).status).toBe('imported');
    expect(excerpts()).toContainEqual({ id: englishId, excerpt: publication.speeches[0]?.excerpt });
  });

  it('rejects oversized, invalid UTF-8 and malformed XML without committing state', () => {
    const { sqlite } = store;
    expect(() => importHansardEdition(sqlite, new Uint8Array(MAX_HANSARD_XML_BYTES + 1))).toThrow('file limit');
    expect(() => importHansardEdition(sqlite, Buffer.concat([en, Buffer.from([0xff])]))).toThrow(TypeError);
    expect(() => importHansardEdition(sqlite, Buffer.from(original.replace('</Intervention>', '')))).toThrow('well-formed');
    expect(excerpts()).toEqual([]);
    expect(sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'local_hansard_editions'").get()).toBeUndefined();
  });
});
