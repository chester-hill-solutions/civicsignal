import { describe, expect, it } from 'vitest';
import {
  cutRows,
  indexDigest,
  indexLine,
  locate,
  parseManifest,
  parseVectorsManifest,
  SNAPSHOT_PARSER_VERSION,
  manifestKey,
  indexKey,
  partStarts,
  DEFAULT_PART_BYTES,
  SNAPSHOT_FORMAT,
  type SnapshotManifest,
} from '../src/ingest/snapshot-format';

/**
 * The snapshot's shape.
 *
 * The rows are parts because a single object cannot be published: neither
 * wrangler nor the Cloudflare API will upload more than 300 MB, and the rows
 * are 347. That turned out to be a limit rather than a detail — the upload
 * failed, the bucket kept the index it had already taken, and nothing said so
 * until something tried to read a row.
 *
 * So the format has two jobs, and both of them are about that failure: cutting
 * the rows without ever splitting one (a row that straddles two parts cannot
 * be read by a range request, and a range request is the only way rows are
 * read), and describing them well enough that "is it all there?" has an
 * answer.
 */
function manifestWith(parts: { key: string; bytes: number }[], bytes: number): SnapshotManifest {
  return {
    format: SNAPSHOT_FORMAT,
    commit: 'abc123',
    date: '2026-10-15',
    rows: { count: 3, bytes, partBytes: DEFAULT_PART_BYTES, parts },
    index: { key: 'abc123.index.jsonl', bytes: 100, entries: 3 },
  };
}

describe('an index entry', () => {
  /**
   * Exactly one newline, because the file is the entries and nothing else.
   *
   * The builder joins these with nothing — each line already carries its own
   * newline. Joining them with a newline *as well* is how the index came to
   * have a blank line between every entry: two hundred and seventy-seven
   * thousand of them, a byte each, invisible to every reader because a blank
   * line is skipped. The index was a megabyte larger than it should have been
   * and the only thing that noticed was a byte count.
   */
  it('is the bytes of the entry, and one newline', () => {
    const line = indexLine({ id: 'acts-en-100', fp: 'a'.repeat(32), off: 1234, len: 567 });

    expect(line.split('\n')).toHaveLength(2);
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      id: 'acts-en-100',
      fp: 'a'.repeat(32),
      off: 1234,
      len: 567,
    });
  });
});

/**
 * The identity of an index.
 *
 * The vectors are **positional**: vector *i* belongs to the *i*-th id in the
 * index. So a vectors file is only correct against the exact index it was
 * exported from, and a new revision — which adds and removes provisions and
 * shifts every position after the first change — makes yesterday's vectors
 * vectors of *different provisions*. Nothing about that is an error anywhere:
 * the search returns provisions, ranked by somebody else's meaning, and reads
 * as a working search. This digest is what makes it refusable.
 */
describe('the identity of an index', () => {
  const entries = [
    { id: 'acts-en-100', fp: 'aaa' },
    { id: 'acts-en-101', fp: 'bbb' },
    { id: 'regulations-en-1', fp: 'ccc' },
  ];

  it('is the same for the same index', () => {
    expect(indexDigest(entries)).toBe(indexDigest([...entries]));
  });

  it('changes when two provisions swap places', () => {
    const swapped = [entries[1]!, entries[0]!, entries[2]!];
    expect(indexDigest(swapped)).not.toBe(indexDigest(entries));
  });

  it('changes when a provision\'s text changes, even if nothing moved', () => {
    const edited = [entries[0]!, { ...entries[1]!, fp: 'different' }, entries[2]!];
    expect(indexDigest(edited)).not.toBe(indexDigest(entries));
  });

  it('changes when a provision is dropped', () => {
    expect(indexDigest(entries.slice(0, 2))).not.toBe(indexDigest(entries));
  });

  it('does not care how the work is divided', () => {
    // A megabyte of entries crosses the chunk boundary many times over, and
    // the digest is a hash of the chunk hashes over the count — so the same
    // index always gives the same value.
    const many = Array.from({ length: 40_000 }, (_, at) => ({
      id: `acts-en-${at}`,
      fp: at.toString(16).padStart(32, '0'),
    }));
    expect(indexDigest(many)).toBe(indexDigest(many));
    expect(indexDigest(many)).not.toBe(indexDigest(many.slice(1)));
  });
});

describe('cutting the rows into parts', () => {
  it('never splits a line', () => {
    const lines = ['a'.repeat(10) + '\n', 'b'.repeat(10) + '\n', 'c'.repeat(10) + '\n'];
    const parts = [...cutRows(lines, 25)];

    expect(parts.map((part) => part.lines)).toEqual([
      [lines[0], lines[1]],
      [lines[2]],
    ]);
    expect(parts.map((part) => part.bytes)).toEqual([22, 11]);
  });

  it('keeps a line longer than a part in one piece', () => {
    const huge = 'x'.repeat(100) + '\n';
    const parts = [...cutRows([huge, 'small\n'], 10)];

    expect(parts).toHaveLength(2);
    expect(parts[0]!.lines).toEqual([huge]);
    expect(parts[0]!.bytes).toBe(101);
  });

  it('cuts nothing when there is nothing', () => {
    expect([...cutRows([], 10)]).toEqual([]);
  });

  it('counts bytes, not characters', () => {
    const accented = 'Éditeur officiel\n';
    const parts = [...cutRows([accented], 10)];
    expect(parts[0]!.bytes).toBe(new TextEncoder().encode(accented).length);
    expect(parts[0]!.bytes).toBe(18);
  });
});

describe('the manifest', () => {
  it('is read when its parts add up', () => {
    const manifest = manifestWith(
      [
        { key: 'abc123.rows.000.jsonl', bytes: 100 },
        { key: 'abc123.rows.001.jsonl', bytes: 50 },
      ],
      150,
    );
    expect(parseManifest(JSON.stringify(manifest)).rows.parts).toHaveLength(2);
  });

  /**
   * The failure that started this.
   *
   * A snapshot whose last part never arrived looks exactly like a snapshot —
   * until a row is asked for and nothing comes back, which looks exactly like
   * a provision that is not in the corpus.
   */
  it('refuses a snapshot whose parts do not add up', () => {
    const manifest = manifestWith(
      [
        { key: 'abc123.rows.000.jsonl', bytes: 100 },
        { key: 'abc123.rows.001.jsonl', bytes: 50 },
      ],
      364_214_039,
    );
    expect(() => parseManifest(JSON.stringify(manifest))).toThrow(/incomplete/);
  });

  it('refuses a format it does not know', () => {
    const manifest = { ...manifestWith([{ key: 'p', bytes: 1 }], 1), format: 99 };
    expect(() => parseManifest(JSON.stringify(manifest))).toThrow(/format 99/);
  });

  it('refuses a manifest that is not one', () => {
    expect(() => parseManifest('{"hello":true}')).toThrow(/does not describe a snapshot/);
    expect(() => parseManifest('not json')).toThrow(/not JSON/);
  });

  it.each([
    (manifest: SnapshotManifest) => { manifest.rows.count = -1; },
    (manifest: SnapshotManifest) => { manifest.rows.bytes = Number.NaN; },
    (manifest: SnapshotManifest) => { manifest.rows.partBytes = 0.5; },
    (manifest: SnapshotManifest) => { manifest.index.entries = 2; },
    (manifest: SnapshotManifest) => { manifest.index.bytes = -100; },
    (manifest: SnapshotManifest) => { manifest.date = '2026-99-32'; },
    (manifest: SnapshotManifest) => { manifest.rows.parts[0]!.bytes = 0; },
    (manifest: SnapshotManifest) => { manifest.rows.parts[1]!.key = manifest.rows.parts[0]!.key; },
    (manifest: SnapshotManifest) => { manifest.rows.parts[0]!.key = 'another-revision.rows.000.jsonl'; },
    (manifest: SnapshotManifest) => { manifest.index.key = '../other.index.jsonl'; },
    (manifest: SnapshotManifest) => { manifest.index.sha256 = 'bad'; },
    (manifest: SnapshotManifest) => { manifest.index.digest = 'bad'; },
    (manifest: SnapshotManifest) => { manifest.rows.parts[0]!.sha256 = 'bad'; },
  ])('refuses malformed counts, offsets, keys and digests before reading objects', (mutate) => {
    const manifest = manifestWith([{ key: 'abc123.rows.000.jsonl', bytes: 100 }, { key: 'abc123.rows.001.jsonl', bytes: 50 }], 150);
    mutate(manifest);
    expect(() => parseManifest(JSON.stringify(manifest))).toThrow();
  });

  it('keeps parser-versioned and legacy revision identities separate', () => {
    expect(manifestKey('abc123')).toBe('abc123.manifest.json');
    expect(manifestKey('abc123', SNAPSHOT_PARSER_VERSION)).toBe('snapshots/statutes-v2/abc123.manifest.json');
    const manifest = manifestWith([{ key: 'snapshots/statutes-v2/abc123.rows.000.jsonl', bytes: 100 }], 100);
    manifest.parser = SNAPSHOT_PARSER_VERSION;
    manifest.index.key = indexKey(manifest.commit, manifest.parser);
    manifest.index.digest = 'a'.repeat(32);
    manifest.index.sha256 = 'a'.repeat(64);
    manifest.rows.parts[0]!.sha256 = 'b'.repeat(64);
    expect(parseManifest(JSON.stringify(manifest)).parser).toBe(SNAPSHOT_PARSER_VERSION);
    manifest.parser = '../escape';
    expect(() => parseManifest(JSON.stringify(manifest))).toThrow('parser identity');
  });

  it('refuses a snapshot with no parts', () => {
    expect(() => parseManifest(JSON.stringify(manifestWith([], 0)))).toThrow(/names no parts/);
  });
});

describe('finding a row in the parts', () => {
  const manifest = manifestWith(
    [
      { key: 'abc123.rows.000.jsonl', bytes: 100 },
      { key: 'abc123.rows.001.jsonl', bytes: 50 },
      { key: 'abc123.rows.002.jsonl', bytes: 25 },
    ],
    175,
  );

  it('knows where each part begins', () => {
    expect(partStarts(manifest)).toEqual([0, 100, 150]);
  });

  it('finds the part, and the offset inside it', () => {
    expect(locate(manifest, 0)).toEqual({ part: 0, local: 0 });
    expect(locate(manifest, 99)).toEqual({ part: 0, local: 99 });
    // The boundaries: the first byte of a part belongs to that part.
    expect(locate(manifest, 100)).toEqual({ part: 1, local: 0 });
    expect(locate(manifest, 149)).toEqual({ part: 1, local: 49 });
    expect(locate(manifest, 150)).toEqual({ part: 2, local: 0 });
    expect(locate(manifest, 174)).toEqual({ part: 2, local: 24 });
  });
});


describe('vector manifest release boundary', () => {
  const valid = () => ({ format: SNAPSHOT_FORMAT, commit: 'abc123', dims: 2, count: 3,
    bytes: 24, embedded: 2, notEmbedded: 1, index: { entries: 3, digest: 'a'.repeat(32) },
    parts: [{ key: 'abc123.vectors.000.f32', bytes: 16, count: 2, from: 0 },
      { key: 'abc123.vectors.001.f32', bytes: 8, count: 1, from: 2 }] });
  it('accepts an exact positional layout', () => { expect(parseVectorsManifest(JSON.stringify(valid())).count).toBe(3); });
  it.each([
    (manifest: ReturnType<typeof valid>) => { manifest.dims = -2; },
    (manifest: ReturnType<typeof valid>) => { manifest.embedded = 3; },
    (manifest: ReturnType<typeof valid>) => { manifest.index.digest = 'bad'; },
    (manifest: ReturnType<typeof valid>) => { manifest.parts[1]!.from = 1; },
    (manifest: ReturnType<typeof valid>) => { manifest.parts[1]!.key = manifest.parts[0]!.key; },
    (manifest: ReturnType<typeof valid>) => { manifest.parts[0]!.key = 'other.vectors.000.f32'; },
    (manifest: ReturnType<typeof valid>) => { manifest.parts[0]!.count = 1.5; },
    (manifest: ReturnType<typeof valid>) => { manifest.parts[0]!.bytes = 0; },
  ])('refuses invalid vector identities, counts and positions', (mutate) => {
    const manifest = valid();
    mutate(manifest);
    expect(() => parseVectorsManifest(JSON.stringify(manifest))).toThrow();
  });
});
