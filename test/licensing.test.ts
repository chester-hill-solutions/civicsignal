import { describe, expect, it } from 'vitest';
import {
  emitCorpusItem,
  emitCorpusItems,
  LicenceViolation,
  truncate,
  type RawCorpusItem,
} from '../src/licensing';
import {
  GDELT,
  HANSARD_FEDERAL,
  NEWS_CANADA,
  STATUTES_CANADA,
} from '../src/corpora/policies';

/**
 * These tests are the licence boundary. If one of them fails, the product is
 * redistributing something it has no right to redistribute — which is a legal
 * problem, not a bug.
 */

function raw(overrides: Partial<RawCorpusItem> = {}): RawCorpusItem {
  return {
    corpusId: STATUTES_CANADA.id,
    kind: 'statute',
    id: 'item-1',
    title: 'A section',
    body: 'The full body of the provision, which for an open corpus may be returned.',
    excerpt: 'A short passage.',
    citationUrl: 'https://example.invalid/item',
    source: 'Publisher',
    ...overrides,
  };
}

describe('licence boundary', () => {
  it('emits full text for an open corpus', () => {
    const item = emitCorpusItem(STATUTES_CANADA, raw());
    expect(item.body).toContain('full body');
    expect(item.redistribution).toBe('open');
    expect(item.attribution).toContain('Open Government Licence');
  });

  it('never emits the body of a cite-only corpus, even when one is supplied', () => {
    const item = emitCorpusItem(
      HANSARD_FEDERAL,
      raw({ corpusId: HANSARD_FEDERAL.id, kind: 'debate', body: 'the whole speech' }),
    );
    expect(item.body).toBeUndefined();
    expect(item.redistribution).toBe('cite-only');
  });

  it('caps the excerpt of a cite-only corpus', () => {
    const long = 'x'.repeat(5000);
    const item = emitCorpusItem(
      HANSARD_FEDERAL,
      raw({ corpusId: HANSARD_FEDERAL.id, kind: 'debate', body: undefined, excerpt: long }),
    );
    expect(item.excerpt).toBeDefined();
    expect(item.excerpt!.length).toBeLessThanOrEqual(HANSARD_FEDERAL.excerptMaxChars);
    expect(item.excerpt!.endsWith('…')).toBe(true);
  });

  it('emits neither body nor excerpt for a metadata-only corpus', () => {
    for (const policy of [NEWS_CANADA, GDELT]) {
      const item = emitCorpusItem(
        policy,
        raw({ corpusId: policy.id, kind: 'news', body: 'article text', excerpt: 'a lede' }),
      );
      expect(item.body).toBeUndefined();
      expect(item.excerpt).toBeUndefined();
      expect(item.title).toBe('A section');
      expect(item.citationUrl).toBe('https://example.invalid/item');
    }
  });

  it('refuses to emit an item from a corpus the policy does not describe', () => {
    expect(() =>
      emitCorpusItem(STATUTES_CANADA, raw({ corpusId: 'hansard-federal' })),
    ).toThrow(/Corpus mismatch/);
  });

  it('refuses to emit an item with no source link when the policy requires one', () => {
    expect(() =>
      emitCorpusItem(STATUTES_CANADA, raw({ citationUrl: '' })),
    ).toThrow(LicenceViolation);
  });

  it('silently drops items from unknown corpora in a batch', () => {
    const policies = new Map([[STATUTES_CANADA.id, STATUTES_CANADA]]);
    const items = emitCorpusItems(policies, [
      raw(),
      raw({ corpusId: 'something-unregistered' }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.corpusId).toBe(STATUTES_CANADA.id);
  });

  it('always carries attribution', () => {
    const policies = [STATUTES_CANADA, HANSARD_FEDERAL, NEWS_CANADA, GDELT];
    for (const policy of policies) {
      const item = emitCorpusItem(policy, raw({ corpusId: policy.id }));
      expect(item.attribution.length).toBeGreaterThan(10);
    }
  });

  it('truncates without exceeding the cap', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 10)).toBe('abc');
    expect(truncate('abc', 0)).toBe('');
  });
});
