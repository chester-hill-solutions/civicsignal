import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { getHansardSpeech } from '../src/corpora/adapters';
import { readHansardWeekFiles, replayHansardWeek } from '../scripts/lib/hansard-week';
import { testD1 } from './helpers/d1';

const fixture = fileURLToPath(new URL('./fixtures/hansard/week.json', import.meta.url));

describe('one-week Hansard replay', () => {
  it('imports both editions, records an absent edition, and only writes the correction and recovered edition', async () => {
    const store = testD1();
    const { load, ...sample } = readHansardWeekFiles(fixture);
    const week = { ...sample, sittings: [...sample.sittings, { sittingId: '45-1-1000', sittingDate: '2026-04-02' }] };
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let secondFrenchAvailable = false;
    let englishCorrection = false;
    try {
      const editionBytes: Parameters<typeof replayHansardWeek>[2] = (expected) => {
        const source = load({ ...expected, sittingId: '45-1-999' })!;
        if (expected.sittingId === '45-1-1000') {
          if (expected.edition === 'fr' && !secondFrenchAvailable) return null;
          return encoder.encode(decoder.decode(source).replace('999', '1000')
            .replace('April 1', 'April 2').replace('1<Sup>er</Sup> avril', '2 avril'));
        }
        return expected.edition === 'en' && englishCorrection
          ? encoder.encode(decoder.decode(source).replace('We discussed the', 'We amended the'))
          : source;
      };
      const first = await replayHansardWeek(store.sqlite, week, editionBytes);
      expect(first).toMatchObject({ complete: false, counts: { imported: 3, unchanged: 0, missing: 1, failed: 0 } });
      expect(first.editions[3]).toMatchObject({ sittingId: '45-1-1000', edition: 'fr', status: 'missing' });
      const replay = await replayHansardWeek(store.sqlite, week, editionBytes);
      expect(replay.counts).toEqual({ imported: 0, unchanged: 3, missing: 1, failed: 0 });

      secondFrenchAvailable = true;
      englishCorrection = true;
      const corrected = await replayHansardWeek(store.sqlite, week, editionBytes);
      expect(corrected).toMatchObject({ complete: true, counts: { imported: 2, unchanged: 2, missing: 0, failed: 0 } });
      const ctx = { db: store.db, fetch, now: () => new Date() };
      const correctedSpeech = await getHansardSpeech('hansard:en:45-1-999:99002', ctx);
      expect(correctedSpeech?.excerpt).toContain('We amended the housing regulation');
      expect(await getHansardSpeech('hansard:fr:45-1-1000:99002', ctx)).toMatchObject({ language: 'fr' });
    } finally {
      store.close();
    }
  });

  it('separates a failed edition from an absent one and still imports the other edition', async () => {
    const store = testD1();
    const { load, ...week } = readHansardWeekFiles(fixture);
    try {
      const result = await replayHansardWeek(store.sqlite, week, (expected) =>
        expected.edition === 'en' ? load(expected) : new TextEncoder().encode('<invalid'));
      expect(result).toMatchObject({ complete: false, counts: { imported: 1, unchanged: 0, missing: 0, failed: 1 } });
      expect(result.editions[1]).toMatchObject({ edition: 'fr', status: 'failed', error: expect.stringContaining('XML') });
    } finally {
      store.close();
    }
  });

  it('rejects a duplicate, out-of-range sitting, or non-Monday week before loading data', async () => {
    const store = testD1();
    const { sittings, weekOf } = readHansardWeekFiles(fixture);
    const load = vi.fn(() => null);
    try {
      await expect(replayHansardWeek(store.sqlite, { weekOf, sittings: [...sittings, ...sittings] }, load))
        .rejects.toThrow('duplicate sitting');
      await expect(replayHansardWeek(store.sqlite, {
        weekOf, sittings: [{ sittingId: '45-1-999', sittingDate: '2026-04-06' }],
      }, load)).rejects.toThrow('outside the week');
      await expect(replayHansardWeek(store.sqlite, { weekOf: '2026-03-31', sittings }, load)).rejects.toThrow('Monday');
      expect(load).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
});
