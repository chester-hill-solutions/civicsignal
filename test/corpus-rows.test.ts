import { describe, expect, it } from 'vitest';
import { classifyInstrument } from '../src/ingest/corpus-rows';

/**
 * Where an instrument sits decides what it is.
 *
 * A regulation's citation is its file stem and a statute's is in the document,
 * so a regulation that is classified as a statute is parsed with no citation —
 * and a regulation with no citation does not parse at all. It returns nothing,
 * quietly, and a third of the corpus disappears from the diff.
 *
 * That is not hypothetical: `eng/regments/` was a typo for
 * `eng/regulations/`, and every English regulation parsed to zero rows for a
 * day.
 */
describe('classifying an instrument', () => {
  it('tells the four trees apart', () => {
    expect(classifyInstrument('eng/acts/C-34.xml')).toEqual({ kind: 'acts', language: 'en' });
    expect(classifyInstrument('eng/regulations/SOR-96-313.xml')).toEqual({
      kind: 'regulations',
      language: 'en',
    });
    expect(classifyInstrument('fra/lois/A-1.xml')).toEqual({ kind: 'acts', language: 'fr' });
    expect(classifyInstrument('fra/reglements/SOR-96-313.xml')).toEqual({
      kind: 'regulations',
      language: 'fr',
    });
  });

  it('does not lose a tree to a near miss', () => {
    // The four directories, and nothing else, are the four trees.
    const trees = new Set([
      'eng/acts',
      'eng/regulations',
      'fra/lois',
      'fra/reglements',
    ]);
    for (const tree of trees) {
      const kind = tree.endsWith('lois') || tree.endsWith('acts') ? 'acts' : 'regulations';
      expect(classifyInstrument(`${tree}/X-1.xml`).kind).toBe(kind);
    }
  });
});
