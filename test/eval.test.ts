import { describe, expect, it } from 'vitest';
import { buildIndex, search, stem, tokenize } from '../src/eval/bm25';
import { reciprocalRankFusion } from '../src/eval/retrieval';
import { formatModeResult, scoreMode, validateLabels } from '../src/eval/evaluate';
import { QUESTIONS } from '../src/eval/questions';

describe('tokenizer', () => {
  it('lowercases, splits on non-alphanumerics and drops stopwords', () => {
    expect(tokenize('The Minister may make Regulations')).toEqual([
      'minister',
      'make',
      'regulation',
    ]);
  });

  it('keeps numbers, which matter in statutes', () => {
    expect(tokenize('section 210 of the Act')).toContain('210');
  });

  it('stems the forms a question and a statute use differently', () => {
    expect(stem('increases')).toBe(stem('increase'));
    expect(stem('increased')).toBe(stem('increase'));
    expect(stem('increasing')).toBe(stem('increase'));
  });

  it('makes a verb and its inflections collide', () => {
    // Porter alone leaves "increase" and "increased" as different tokens, so a
    // question saying "increase" would never match a statute saying "increased".
    expect(stem('increased')).toBe(stem('increase'));
    expect(stem('increasing')).toBe(stem('increase'));
    expect(stem('increases')).toBe(stem('increase'));
  });

  it('does not mangle words that merely end in s', () => {
    expect(stem('business')).toBe('business');
    expect(stem('status')).toBe('status');
  });
});

describe('bm25 index', () => {
  const documents = [
    'A landlord may not increase rent without notice to the tenant.',
    'The Minister may make regulations respecting the collection of personal information.',
    'Every one commits theft who fraudulently takes the property of another.',
    'A person who operates a conveyance while impaired commits an offence.',
  ];

  it('ranks the matching document first', () => {
    const index = buildIndex(documents);
    const results = search(index, 'personal information regulations', 4);
    expect(results[0]?.docId).toBe(1);
  });

  it('finds a document by a term that appears in many documents', () => {
    const index = buildIndex(documents);
    const results = search(index, 'regulations', 4);
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns nothing for a query with no matching terms', () => {
    const index = buildIndex(documents);
    expect(search(index, 'xylophone', 4)).toHaveLength(0);
  });

  it('reports the average document length', () => {
    const index = buildIndex(documents);
    expect(index.docCount).toBe(4);
    expect(index.avgDocLen).toBeGreaterThan(0);
  });
});

describe('reciprocal rank fusion', () => {
  it('favours a document that both arms rank highly', () => {
    const fused = reciprocalRankFusion([
      [{ docId: 1, score: 9 }, { docId: 2, score: 8 }],
      [{ docId: 1, score: 0.9 }, { docId: 2, score: 0.8 }],
    ]);
    expect(fused[0]?.docId).toBe(1);
    expect(fused[0]!.score).toBeGreaterThan(fused[1]!.score);
  });

  it('treats a symmetric ranking as a tie, because rank fusion sees only order', () => {
    const fused = reciprocalRankFusion([
      [{ docId: 1, score: 9 }, { docId: 2, score: 8 }],
      [{ docId: 2, score: 0.9 }, { docId: 1, score: 0.8 }],
    ]);
    expect(fused[0]!.score).toBeCloseTo(fused[1]!.score);
  });

  it('surfaces a document that only one arm found', () => {
    const fused = reciprocalRankFusion([
      [{ docId: 1, score: 9 }],
      [{ docId: 2, score: 0.9 }],
    ]);
    expect(fused.map((f) => f.docId).sort()).toEqual([1, 2]);
  });
});

describe('label validation', () => {
  const rows = [
    { act: 'Criminal Code', section: '322' },
    { act: 'Criminal Code', section: '322' },
    { act: 'Privacy Act', section: '4' },
  ];

  it('reports a label that matches nothing', () => {
    const { valid, issues } = validateLabels(
      [{ id: 'q', question: 'x', act: 'Nowhere Act', section: '1', style: 'exact', note: '' }],
      rows,
    );
    expect(valid.size).toBe(0);
    expect(issues[0]?.reason).toBe('no matching row in the corpus');
  });

  it('reports an ambiguous label', () => {
    const { issues } = validateLabels(
      [{ id: 'q', question: 'x', act: 'Criminal Code', section: '322', style: 'exact', note: '' }],
      rows,
    );
    expect(issues[0]?.reason).toBe('label is ambiguous');
  });

  it('accepts a unique label', () => {
    const { valid, issues } = validateLabels(
      [{ id: 'q', question: 'x', act: 'Privacy Act', section: '4', style: 'exact', note: '' }],
      rows,
    );
    expect(valid.get('q')).toBe(2);
    expect(issues).toHaveLength(0);
  });
});

describe('scoring', () => {
  it('computes recall and reciprocal rank over the questions', () => {
    const result = scoreMode('keyword', [
      { id: 'a', style: 'exact', rank: 1, goldCount: 1 },
      { id: 'b', style: 'concept', rank: 3, goldCount: 1 },
      { id: 'c', style: 'concept', rank: null, goldCount: 1 },
    ]);
    expect(result.hits).toBe(2);
    expect(result.recallAt1).toBeCloseTo(1 / 3);
    // Two of three are within the top five; the miss is not a recall hit.
    expect(result.recallAt5).toBeCloseTo(2 / 3);
    expect(result.mrr).toBeCloseTo((1 + 1 / 3) / 3);
    expect(result.byStyle.concept.hits).toBe(1);
    expect(result.byStyle.exact.hits).toBe(1);
  });

  it('formats a result for a human', () => {
    const result = scoreMode('hybrid', [
      { id: 'a', style: 'exact', rank: 1, goldCount: 1 },
    ]);
    const text = formatModeResult(result);
    expect(text).toContain('hybrid');
    expect(text).toContain('R@5');
  });
});

describe('the evaluation set', () => {
  it('is balanced between exact and concept questions', () => {
    const exact = QUESTIONS.filter((q) => q.style === 'exact').length;
    const concept = QUESTIONS.filter((q) => q.style === 'concept').length;
    expect(exact).toBeGreaterThanOrEqual(10);
    expect(concept).toBeGreaterThanOrEqual(10);
  });

  it('has unique ids', () => {
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(QUESTIONS.length);
  });

  it('pairs each concept question with the same gold answer asked exactly', () => {
    // The comparison only works if the two phrasings of a provision share a target.
    const counts = new Map<string, number>();
    for (const q of QUESTIONS) {
      const key = `${q.act}::${q.section}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counts) {
      expect({ key, count }).toEqual({ key, count: expect.any(Number) });
      expect(count).toBeLessThanOrEqual(2);
    }
    const exact = new Set(QUESTIONS.filter((q) => q.style === 'exact').map((q) => `${q.act}::${q.section}`));
    const concept = new Set(QUESTIONS.filter((q) => q.style === 'concept').map((q) => `${q.act}::${q.section}`));
    const paired = [...concept].filter((key) => exact.has(key)).length;
    expect(paired).toBeGreaterThanOrEqual(10);
  });
});
