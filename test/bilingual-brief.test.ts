import { createRequire } from 'node:module';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { GAZETTE_PREVIEW_ISSUES, type GazetteEdition } from '../src/corpora/gazette';
import { importGazetteEdition } from '../scripts/lib/gazette-store';
import { readBilingualBrief } from '../scripts/lib/bilingual-brief';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof SqliteDatabase };
const gazetteSchema = readFileSync(new URL('../preview/gazette/migrations/0001_gazette.sql', import.meta.url), 'utf8');

describe('local bilingual source brief', () => {
  let replay: SqliteDatabase | undefined;
  afterEach(() => { replay?.close(); replay = undefined; });

  it('replays an explicitly simulated EN/FR title correction against cited Gazette metadata', async () => {
    const store = new DatabaseSync(':memory:');
    replay = store;
    store.exec(gazetteSchema);
    const editions = GAZETTE_PREVIEW_ISSUES.map((key): GazetteEdition => {
      const records: GazetteEdition['records'] = key.part === 'II'
        ? key.language === 'en' ? [{ ...key, id: 'gazette:pii:en:2026-04-22:v160:n8:sor-65', kind: 'instrument',
          title: 'Canadian Turkey Marketing Quota Regulations, 1990 — Regulations Amending the',
          citationUrl: 'https://gazette.gc.ca/rp-pr/p2/2026/2026-04-22/html/sor-dors65-eng.html',
          registrationNumber: 'SOR/2026-65', registrationDate: '2026-03-31' }]
          : [{ ...key, id: 'gazette:pii:fr:2026-04-22:v160:n8:sor-65', kind: 'instrument',
            title: 'Contingentement de la commercialisation du dindon (1990) — Règlement modifiant le Règlement canadien sur le',
            citationUrl: 'https://gazette.gc.ca/rp-pr/p2/2026/2026-04-22/html/sor-dors65-fra.html',
            registrationNumber: 'DORS/2026-65', registrationDate: '2026-03-31' }]
        : [];
      return { ...key, records };
    });
    {
      editions.forEach((edition) => importGazetteEdition(store, edition));
      const topics = { en: 'turkey marketing quota', fr: 'du dindon' };
      const checkpoint = await readBilingualBrief(store, { topics });
      const english = editions.find(({ part, language }) => part === 'II' && language === 'en');
      const french = editions.find(({ part, language }) => part === 'II' && language === 'fr');
      const enRecord = english?.records.find(({ registrationNumber }) => registrationNumber === 'SOR/2026-65');
      const frRecord = french?.records.find(({ registrationNumber }) => registrationNumber === 'DORS/2026-65');
      if (!english || !french || !enRecord || !frRecord) throw new Error('Expected the bilingual SOR/DORS fixture records.');
      expect(checkpoint.events.filter(({ recordId }) => [enRecord.id, frRecord.id].includes(recordId)).map(({ kind }) => kind))
        .toEqual(['added', 'added']);
      expect(enRecord?.id).toBe('gazette:pii:en:2026-04-22:v160:n8:sor-65');
      expect(frRecord?.id).toBe('gazette:pii:fr:2026-04-22:v160:n8:sor-65');

      importGazetteEdition(store, { ...english, records: english.records.map((record) => record.id === enRecord.id
        ? { ...record, title: 'Canadian poultry quota regulations — simulated correction' } : record) });
      importGazetteEdition(store, { ...french, records: french.records.map((record) => record.id === frRecord.id
        ? { ...record, title: 'Règlement sur les contingents de volaille — correction simulée' } : record) });

      const next = await readBilingualBrief(store, { cursors: checkpoint.cursors, topics,
        generatedAt: '2026-11-23T12:00:00.000Z' });
      expect(next.events).toHaveLength(2);
      expect(next.events.map(({ recordId, kind, matches, citationUrl, attribution }) => ({
        recordId, kind, matches, citationUrl, attribution,
      }))).toEqual([
        expect.objectContaining({ recordId: enRecord?.id, kind: 'corrected', matches: { before: true, after: false },
          citationUrl: enRecord?.citationUrl, attribution: expect.stringContaining('Source: Canada Gazette, Government of Canada.') }),
        expect.objectContaining({ recordId: frRecord?.id, kind: 'corrected', matches: { before: true, after: false },
          citationUrl: frRecord?.citationUrl, attribution: expect.stringContaining('Source: Canada Gazette, Government of Canada.') }),
      ]);
      expect(new Set(next.events.map(({ identity }) => identity)).size).toBe(2);
      const retried = await readBilingualBrief(store, { cursors: checkpoint.cursors, topics,
        generatedAt: '2026-11-23T12:00:00.000Z' });
      expect(retried.events.map(({ identity }) => identity)).toEqual(next.events.map(({ identity }) => identity));
      expect((await readBilingualBrief(store, { cursors: next.cursors, topics })).events).toEqual([]);

      expect(next.coverage.filter(({ source, language }) => source === 'gazette' && language === 'en').map(({ part, status }) => [part, status]))
        .toEqual([['I', 'quiet'], ['II', 'changes']]);
      expect(next.coverage.find(({ source, language }) => source === 'house' && language === 'en')?.status).toBe('unknown');
      expect(next.coverage.find(({ source, language }) => source === 'senate' && language === 'fr')?.status).toBe('unknown');

      importGazetteEdition(store, { ...english, records: [] });
      importGazetteEdition(store, { ...french, records: [] });
      expect((await readBilingualBrief(store, { cursors: next.cursors, topics })).events).toEqual([]);
      const completeJournal = await readBilingualBrief(store);
      expect(completeJournal.events.filter(({ kind }) => kind === 'removed').map(({ recordId, kind }) => [recordId, kind])).toEqual([
        [enRecord.id, 'removed'], [frRecord.id, 'removed'],
      ]);
      expect((await readBilingualBrief(store, { cursors: completeJournal.cursors })).events).toEqual([]);

      const rebuilt = new DatabaseSync(':memory:');
      try {
        rebuilt.exec(gazetteSchema);
        editions.forEach((edition) => importGazetteEdition(rebuilt, edition));
        await expect(readBilingualBrief(rebuilt, { cursors: checkpoint.cursors, topics })).rejects.toThrow('cursor is no longer valid');
      } finally { rebuilt.close(); }
    }
  });
});
