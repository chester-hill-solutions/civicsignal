import { describe, expect, it } from 'vitest';
import { testD1 } from './helpers/d1';
import { materializeParliament } from '../scripts/materialize-parliament';

const records = ['en', 'fr'].map(language => ({ key: 's-2', language, title: 'Title', summary: 'Status',
  details: { kind: 'bill', legisInfoId: 22, status: 'Status' },
  date: null, url: 'https://www.parl.ca/legisinfo/' + language + '/bill/45-1/s-2' }));
const inventory = { collection: 'bills', session: '45-1', observedAt: '2026-11-23T14:00:00Z', records };

describe('parliamentary catalogue publication', () => {
  it('validates bilingual identities, advances the cutoff and rolls back a failed replacement', () => {
    const fixture = testD1({ schema: '' });
    try {
      const publish = (input: unknown) => materializeParliament(fixture.sqlite, input);
      const first = publish(inventory);
      expect(first).toMatchObject({ recordsPerLanguage: 1, changed: true });
      const second = publish({ ...inventory, observedAt: '2026-11-23T15:00:00Z', records: [...records].reverse() });
      expect(second).toMatchObject({ changed: false, revision: first.revision });
      expect(() => publish(inventory)).toThrow(/newer/);
      expect(() => publish({ ...inventory, records: records.slice(0, 1) })).toThrow(/counterpart/);
      expect(() => publish({ ...inventory, records: [...records, records[0]] })).toThrow(/Duplicate/);
      expect(() => publish({ ...inventory, records: records.map(r => ({ ...r, url: 'https://example.org/bill' })) })).toThrow(/citation/);
      fixture.sqlite.exec("CREATE TRIGGER reject_test BEFORE INSERT ON parliament_editions BEGIN SELECT RAISE(ABORT,'failed replacement'); END;");
      expect(() => publish({ ...inventory, observedAt: '2026-11-23T16:00:00Z', records: records.map(r => ({ ...r, title: 'Revised' })) })).toThrow(/failed replacement/);
      expect(fixture.sqlite.prepare('SELECT revision FROM parliament_catalogues').get()?.revision).toBe(first.revision);
      expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM parliament_editions').get()?.n).toBe(2);
    } finally { fixture.close(); }
  });

  it('replaces corrected Journal passages atomically and removes superseded rows', () => {
    const fixture = testD1({ schema: '' });
    const url = 'https://sencanada.ca/en/content/sen/chamber/451/journals/001jr_2025-05-27-e';
    const journal = (texts: string[], observedAt: string) => ({
      collection: 'senate-journals', session: '45-1', observedAt,
      records: ['en', 'fr'].map(language => ({ key: '1', language, title: 'Journal', url, date: '2025-05-27', summary: '',
        details: { kind: 'senate-journal', status: 'published', passages: texts.map(text => ({ text, url, links: [] })) } })),
    });
    const count = () => fixture.sqlite.prepare('SELECT count(*) AS n FROM parliament_entries').get()?.n;
    try {
      materializeParliament(fixture.sqlite, journal(['First', 'Second'], '2026-11-23T01:00:00Z'));
      expect(count()).toBe(4);
      const corrected = journal(['Correction'], '2026-11-23T02:00:00Z');
      const receipt = materializeParliament(fixture.sqlite, corrected);
      expect(count()).toBe(2);
      expect(materializeParliament(fixture.sqlite, corrected)).toMatchObject({ changed: false, revision: receipt.revision });
      fixture.sqlite.exec("CREATE TRIGGER reject_entry BEFORE INSERT ON parliament_entries BEGIN SELECT RAISE(ABORT,'entry rejected'); END;");
      expect(() => materializeParliament(fixture.sqlite, journal(['Later'], '2026-11-23T03:00:00Z'))).toThrow('entry rejected');
      expect(count()).toBe(2);
      expect(fixture.sqlite.prepare('SELECT payload FROM parliament_entries LIMIT 1').get()?.payload).toContain('Correction');
      expect(fixture.sqlite.prepare('SELECT revision FROM parliament_catalogues').get()?.revision).toBe(receipt.revision);
    } finally { fixture.close(); }
  });

  it('requires a complete Journal comparison before removing a supplemental Senate vote', () => {
    const fixture = testD1({ schema: '' });
    const observedAt = '2026-11-23T05:00:00Z';
    const edition = (key: string, language: string) => ({
      key, language, title: 'Amendment', summary: '', date: '2025-06-26', url: 'https://sencanada.ca/' + language,
      details: { kind: 'senate-roll-call', members: [{ name: 'Example', position: 'yea', paired: false,
        memberId: null, province: null, affiliation: null, constituency: null, url: null }],
        ...(key.startsWith('j') ? { journalIssue: '16', journalVoteOrdinal: 3 } : {}) },
    });
    const base = { collection: 'senate-roll-calls', session: '45-1', observedAt, records: ['en', 'fr'].map(lang => edition('1', lang)) };
    try {
      materializeParliament(fixture.sqlite, { ...base, records: [...base.records, ...['en','fr'].map(lang => edition('j16-3', lang))],
        journalReconciliation: { observedAt, journalOnlyRecordsPerLanguage: 1 } });
      const refresh = { ...base, observedAt: '2026-11-23T06:00:00Z' };
      expect(() => materializeParliament(fixture.sqlite, refresh)).toThrow(/reconciliation/);
      expect(() => materializeParliament(fixture.sqlite, { ...refresh, journalReconciliation: { observedAt, journalOnlyRecordsPerLanguage: 1 } }))
        .toThrow(/receipt/);
      expect(materializeParliament(fixture.sqlite, { ...refresh, journalReconciliation: { observedAt: refresh.observedAt, journalOnlyRecordsPerLanguage: 0 } }))
        .toMatchObject({ changed: true, recordsPerLanguage: 1 });
    } finally { fixture.close(); }
  });
});
