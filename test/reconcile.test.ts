import { describe, expect, it } from 'vitest';
import { fingerprint, hash128, reconcile, type FingerprintedRow } from '../src/ingest/reconcile';

/**
 * The reconciliation is the heart of the continuous pipeline: it decides which
 * provisions are re-embedded and which are left alone. Getting it wrong in one
 * direction is expensive — re-embedding the whole corpus costs $0.36 and an hour —
 * and wrong in the other direction it is silent: a provision that changed is
 * never updated, and the product serves stale law with a fresh date on it.
 */

function row(overrides: Partial<FingerprintedRow> = {}): FingerprintedRow {
  return {
    id: 'acts-en-177',
    instrument: 'Access to Information Act',
    text: 'This Act may be cited as the Access to Information Act.',
    heading: 'Short title',
    section: '1',
    status: 'in-force',
    schedule: null,
    part: null,
    source_url: 'https://laws-lois.justice.gc.ca/en/acts/A-1/section-1.html',
    in_force: 1,
    citation: 'A-1',
    ...overrides,
  };
}

describe('the fingerprint', () => {
  it('is the same for the same row', () => {
    expect(fingerprint(row())).toBe(fingerprint(row()));
  });

  it('changes when the text changes', () => {
    expect(fingerprint(row({ text: 'Something else entirely.' }))).not.toBe(fingerprint(row()));
  });

  it('changes when the label moves', () => {
    // A section whose label moved is a different citation, and the product's
    // answer to "section 1" changes with it.
    expect(fingerprint(row({ section: '1.1' }))).not.toBe(fingerprint(row()));
  });

  it('changes when the provision is repealed', () => {
    expect(fingerprint(row({ status: 'repealed', in_force: 0 }))).not.toBe(fingerprint(row()));
  });

  it('changes when the instrument is renamed', () => {
    // A rename changes what the row resolves to, and the citation URL with it.
    expect(fingerprint(row({ instrument: 'Access to Information Act, 2026' }))).not.toBe(fingerprint(row()));
  });

  it('changes when the citation changes', () => {
    expect(fingerprint(row({ citation: 'A-1.1' }))).not.toBe(fingerprint(row()));
  });

  it('changes when the heading changes', () => {
    expect(fingerprint(row({ heading: 'A different heading' }))).not.toBe(fingerprint(row()));
  });

  it('does not depend on the id', () => {
    // The id is the key, not the content. Two rows with the same content and
    // different ids have the same fingerprint, which is what makes a fingerprint
    // comparable across a rename.
    expect(fingerprint(row({ id: 'acts-en-999' }))).toBe(fingerprint(row()));
  });
});

describe('the hash', () => {
  it('is 128 bits wide', () => {
    expect(hash128('anything')).toHaveLength(32);
  });

  it('does not collide on a handful of similar values', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(hash128(`provision ${i}`));
    expect(seen.size).toBe(10_000);
  });

  it('separates values that differ only at the end', () => {
    expect(hash128('provision 1')).not.toBe(hash128('provision 2'));
    expect(hash128('a')).not.toBe(hash128('b'));
  });
});

describe('reconciliation', () => {
  const previous = new Map([
    ['a', 'hash-a'],
    ['b', 'hash-b'],
    ['c', 'hash-c'],
  ]);

  it('finds a row that was added', () => {
    const next = new Map([...previous, ['d', 'hash-d']]);
    const result = reconcile(previous, next);
    expect(result.added.map((c) => c.id)).toEqual(['d']);
    expect(result.changed).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it('finds a row that changed', () => {
    const next = new Map([...previous, ['b', 'hash-b-new']]);
    const result = reconcile(previous, next);
    expect(result.changed.map((c) => c.id)).toEqual(['b']);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it('finds a row that was removed', () => {
    const next = new Map([...previous]);
    next.delete('b');
    const result = reconcile(previous, next);
    expect(result.removed.map((c) => c.id)).toEqual(['b']);
  });

  it('leaves an unchanged row alone', () => {
    const result = reconcile(previous, previous);
    expect(result.unchanged).toHaveLength(3);
    expect(result.toEmbed).toHaveLength(0);
    expect(result.toDelete).toHaveLength(0);
    expect(result.isEmpty).toBe(true);
  });

  it('embeds only what changed and deletes only what went', () => {
    const next = new Map([
      ['a', 'hash-a'],
      ['b', 'hash-b-new'],
      ['d', 'hash-d'],
    ]);
    const result = reconcile(previous, next);
    expect(result.toEmbed.map((c) => c.id).sort()).toEqual(['b', 'd']);
    expect(result.toDelete.map((c) => c.id)).toEqual(['c']);
  });

  /**
   * The property the pipeline depends on: a revision that touches nothing must
   * cost nothing. If this ever changes, the pipeline re-embeds the corpus on
   * every commit and the $0.36 run becomes an hourly one.
   */
  it('costs nothing when a revision touches nothing', () => {
    const before = new Map<string, string>();
    for (let i = 0; i < 138_750; i++) before.set(`id-${i}`, hash128(`row ${i}`));
    const after = new Map(before);
    const result = reconcile(before, after);
    expect(result.isEmpty).toBe(true);
    expect(result.toEmbed).toHaveLength(0);
  });

  /**
   * The shape of a real commit: one instrument amended, a handful of provisions
   * changed, everything else untouched.
   */
  it('sees one provision in fifty-six on a typical commit', () => {
    const before = new Map<string, string>();
    for (let i = 0; i < 138_750; i++) before.set(`id-${i}`, hash128(`row ${i}`));
    const after = new Map(before);
    after.set('id-500', hash128('row 500, amended'));
    after.set('id-9001', hash128('row 9001, amended'));
    after.delete('id-77');

    const result = reconcile(before, after);
    expect(result.changed).toHaveLength(2);
    expect(result.removed).toHaveLength(1);
    expect(result.unchanged).toHaveLength(138_747);
    expect(result.toEmbed).toHaveLength(2);
  });
});
