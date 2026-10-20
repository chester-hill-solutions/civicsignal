import { describe, expect, it } from 'vitest';
import { emitCorpusItem, emitCorpusItems } from '@chester-hill-solutions/corpus';
import { CORPUS_POLICIES, STATUTES_CANADA, HANSARD_FEDERAL, NEWS_CANADA, GDELT } from '../src/corpora/policies';

/**
 * The product's licence declarations.
 *
 * The enforcement mechanism itself is tested in `@chester-hill-solutions/corpus`.
 * What this file checks is the part that belongs to *this* product: that each
 * corpus is declared under the regime its source actually permits. That is a
 * fact about Elections Canada, the House of Commons, the publishers and GDELT —
 * not about the package — and it is the thing that goes wrong silently, because a
 * mis-declared corpus still returns a well-formed response.
 */
describe('the corpora this product serves', () => {
  it('declares a regime for every corpus', () => {
    expect(CORPUS_POLICIES.length).toBeGreaterThan(0);
    for (const policy of CORPUS_POLICIES) {
      expect(policy.redistribution).toMatch(/^(open|cite-only|metadata-only)$/);
      expect(policy.attribution.length).toBeGreaterThan(10);
      expect(policy.licenceUrl).toMatch(/^https:\/\//);
    }
  });

  it('reproduces federal statutes in full, because the corpus is openly licensed', () => {
    expect(STATUTES_CANADA.redistribution).toBe('open');
    expect(STATUTES_CANADA.allowFullText).toBe(true);
    const item = emitCorpusItem(STATUTES_CANADA, {
      corpusId: STATUTES_CANADA.id,
      kind: 'statute',
      id: 'acts-en-a-1-1',
      title: 'Access to Information Act s.1',
      body: 'This Act may be cited as the Access to Information Act.',
      citationUrl: 'https://laws-lois.justice.gc.ca/en/acts/A-1/section-1.html',
      source: 'Government of Canada',
    });
    expect(item.body).toContain('may be cited');
    expect(item.attribution).toContain('Open Government Licence');
  });

  it('quotes the debates and never reproduces them, because Hansard is Crown copyright', () => {
    expect(HANSARD_FEDERAL.redistribution).toBe('cite-only');
    expect(HANSARD_FEDERAL.allowFullText).toBe(false);
    const item = emitCorpusItem(HANSARD_FEDERAL, {
      corpusId: HANSARD_FEDERAL.id,
      kind: 'debate',
      id: 'h-1',
      title: 'Debate on housing',
      body: 'The full speech, which may not be reproduced.',
      excerpt: 'We must build more homes.',
      citationUrl: 'https://www.ourcommons.ca/DocumentViewer/en/45-1/house/sitting-1/hansard',
      source: 'House of Commons of Canada',
    });
    expect(item.body).toBeUndefined();
    expect(item.excerpt).toBe('We must build more homes.');
    expect(item.excerpt!.length).toBeLessThanOrEqual(HANSARD_FEDERAL.excerptMaxChars);
    expect(item.attribution).toContain('Crown copyright');
  });

  it('surfaces news and global press as metadata only, because the publisher terms forbid republication', () => {
    for (const policy of [NEWS_CANADA, GDELT]) {
      expect(policy.redistribution).toBe('metadata-only');
      expect(policy.allowFullText).toBe(false);
      expect(policy.excerptMaxChars).toBe(0);
      const item = emitCorpusItem(policy, {
        corpusId: policy.id,
        kind: 'news',
        id: 'n-1',
        title: 'A headline',
        body: 'Article text.',
        excerpt: 'A lede.',
        citationUrl: 'https://example.invalid/n-1',
        source: 'Some Outlet',
      });
      expect(item.body).toBeUndefined();
      expect(item.excerpt).toBeUndefined();
      expect(item.title).toBe('A headline');
    }
  });

  it('lets only the openly-licensed corpora carry a body', () => {
    // The federal statutes, the Ontario statutes and the election results are the
    // three that are open. Everything else — debates, the Gazette, bills, news and
    // the global press monitor — is quoted or referenced, never reproduced.
    const withBody = CORPUS_POLICIES.filter((p) => p.allowFullText).map((p) => p.id);
    expect(withBody.sort()).toEqual(
      ['statutes-canada', 'statutes-ontario', 'election-results'].sort(),
    );
  });

  it('drops an item from a corpus it has no policy for', () => {
    const policies = new Map(CORPUS_POLICIES.map((p) => [p.id, p]));
    const items = emitCorpusItems(policies, [
      {
        corpusId: STATUTES_CANADA.id,
        kind: 'statute',
        id: 's1',
        title: 'A section',
        citationUrl: 'https://example.invalid/s1',
        source: 'Government of Canada',
      },
      {
        corpusId: 'some-corpus-nobody-declared',
        kind: 'statute',
        id: 's2',
        title: 'A section',
        citationUrl: 'https://example.invalid/s2',
        source: 'Government of Canada',
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.corpusId).toBe(STATUTES_CANADA.id);
  });
});
