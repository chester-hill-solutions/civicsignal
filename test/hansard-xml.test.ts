import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseHansardXml } from '../src/ingest/hansard';
import { HANSARD_FEDERAL } from '../src/corpora/policies';
import { importHansardSitting } from '../scripts/hansard-local';
import { getHansardSpeech, hansardCorpus } from '../src/corpora/adapters';
import { testD1 } from './helpers/d1';

const en = readFileSync(new URL('./fixtures/hansard/sitting-en.xml', import.meta.url), 'utf8');
const fr = readFileSync(new URL('./fixtures/hansard/sitting-fr.xml', import.meta.url), 'utf8');

describe('House Hansard XML', () => {
  it('derives the same source identity and date for both editions and preserves spoken text order', () => {
    const english = parseHansardXml(en);
    const french = parseHansardXml(fr);
    expect(english).toMatchObject({
      publicationId: '99001',
      edition: 'en',
      sitting: {
        sittingId: '45-1-999', sittingDate: '2026-04-01',
        speeches: [{
          interventionId: '99002', language: 'en', speaker: 'Synthetic Speaker',
          excerpt: 'We discussed the housing regulation & its reach. The committee will study it.',
          citationUrl: 'https://www.ourcommons.ca/DocumentViewer/en/45-1/house/sitting-999/hansard#Int-99002',
        }],
      },
    });
    expect(french).toMatchObject({
      publicationId: '99001', edition: 'fr',
      sitting: {
        sittingId: '45-1-999', sittingDate: '2026-04-01',
        speeches: [{
          interventionId: '99002', language: 'fr', speaker: 'Intervenante fictive',
          excerpt: 'Nous avons discuté du règlement sur le logement et de sa portée.',
          citationUrl: 'https://www.ourcommons.ca/DocumentViewer/fr/45-1/chambre/seance-999/debats#Int-99002',
        }],
      },
    });
  });

  it('caps excerpts without adding text or splitting a Unicode value', () => {
    const prefix = 'x'.repeat(HANSARD_FEDERAL.excerptMaxChars - 1);
    const xml = en.replace(/<ParaText>.*?<\/ParaText>/u, `<ParaText>${prefix}😀 tail</ParaText>`);
    const [speech] = parseHansardXml(xml).sitting.speeches;
    expect(speech?.excerpt).toBe(prefix);
  });

  it('normalizes the printed zero-padded sitting number for IDs and transcript links', () => {
    const official = parseHansardXml(en.replace('No. 999', 'No. 001'));
    expect(official.sitting.sittingId).toBe('45-1-1');
    expect(official.sitting.speeches[0]?.citationUrl).toContain('/sitting-1/hansard#Int-99002');
  });

  it.each([
    ['unknown edition', en.replace('xml:lang="EN"', 'xml:lang="XX"')],
    ['invalid date', en.replace('April 1, 2026', 'April 31, 2026')],
    ['missing speaker', en.replace('Synthetic Speaker', '')],
    ['malformed XML', en.replace('</Intervention>', '')],
    ['duplicated intervention ID', en.replace('</OrderOfBusiness>', '<Intervention id="99002"/></OrderOfBusiness>')],
    ['document type', en.replace('<Hansard ', '<!DOCTYPE Hansard><Hansard ')],
  ])('refuses %s', (_, input) => {
    expect(() => parseHansardXml(input)).toThrow();
  });

  it('feeds both editions into the existing search and exact speech lookup', async () => {
    const store = testD1();
    try {
      const ctx = { db: store.db, now: () => new Date(), fetch };
      for (const xml of [en, fr]) importHansardSitting(store.sqlite, parseHansardXml(xml).sitting);
      const hits = await hansardCorpus.retrieve({ topic: 'reglement', language: 'fr' }, ctx);
      expect(hits.map(({ id }) => id)).toEqual(['hansard:fr:45-1-999:99002']);
      expect(await getHansardSpeech('hansard:fr:45-1-999:99002', ctx)).toEqual(hits[0]);
      expect(await getHansardSpeech('hansard:en:45-1-999:99002', ctx)).toMatchObject({ language: 'en' });
    } finally {
      store.close();
    }
  });
});
