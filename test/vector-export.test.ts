import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { exportSnapshotVectors, parseVectorExportRequest, type VectorExportDependencies } from '../services/pipeline/vector-export';
import { retainD1Text } from '../services/pipeline/options';
import { fingerprint } from '../src/ingest/reconcile';
import { indexDigest, indexKey, manifestKey, SNAPSHOT_PARSER_VERSION as parser, vectorsManifestKey, vectorsPartKey, type SnapshotManifest } from '../src/ingest/snapshot-format';
import type { PipelineRow } from '../src/ingest/pipeline';

const commit = 'a'.repeat(40);
const encode = (value: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(value));
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function harness() {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const writes: string[] = [];
  const bucket = {
    async get(key: string, options?: { range: { offset: number; length: number } }) {
      const item = files.get(key);
      if (!item) return null;
      const bytes = options ? item.slice(options.range.offset, options.range.offset + options.range.length) : item;
      return { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer, text: async () => new TextDecoder().decode(bytes) };
    },
    async put(key: string, bytes: Uint8Array<ArrayBuffer>, options: { onlyIf?: unknown }) {
      if (options.onlyIf && files.has(key)) return null;
      files.set(key, bytes.slice()); writes.push(key); return { size: bytes.length };
    },
  } as unknown as VectorExportDependencies['bucket'];
  const rows: PipelineRow[] = ['1', '2', '3'].map((id) => ({ id: `acts-en-${id}`, corpusId: 'statutes-canada',
    instrument: 'Test Act', citation: 'T-1', section: id, schedule: null, part: null, status: id === '2' ? 'placeholder' : 'in-force',
    heading: null, text: id === '2' ? '[Reserved]' : `Provision ${id}`, source_url: 'https://example.test', in_force: 1,
    language: 'en', embedText: '', lastChanged: '2026-10-22' }));
  let offset = 0;
  const entries = rows.map((row) => { const len = Buffer.byteLength(`${JSON.stringify(row)}\n`); const entry = { id: row.id, fp: fingerprint(row), off: offset, len }; offset += len; return entry; });
  const rowBytes = encode(rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  const indexBytes = encode(entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  const rowKey = `snapshots/${parser}/${commit}.rows.000.jsonl`;
  const manifest: SnapshotManifest = { format: 1, commit, parser, date: '2026-10-22',
    rows: { count: rows.length, bytes: rowBytes.length, partBytes: rowBytes.length, parts: [{ key: rowKey, bytes: rowBytes.length, sha256: hash(rowBytes) }] },
    index: { key: indexKey(commit, parser), bytes: indexBytes.length, entries: entries.length, digest: indexDigest(entries), sha256: hash(indexBytes) } };
  files.set(rowKey, rowBytes); files.set(manifest.index.key, indexBytes); files.set(manifestKey(commit, parser), encode(JSON.stringify(manifest)));
  const vectorValues = new Map(rows.filter((row) => row.status !== 'placeholder').map((row) => [row.id, Array(768).fill(Number(row.section)) as number[]]));
  const reads: string[][] = [];
  const assertions: string[][] = [];
  let current = true;
  const required = new Set<string>();
  const metadata = new Map<string, { fingerprint: string }>();
  const dependencies: VectorExportDependencies = { bucket,
    vector: { async getByIds(ids: string[]) { reads.push(ids); return ids.flatMap((id) => vectorValues.has(id) ? [{ id, values: vectorValues.get(id)!, metadata: metadata.get(id) }] : []); } },
    async assertCurrent(values, total) { assertions.push(values.map((entry) => entry.id)); if (!current || total !== rows.length) throw new Error('corpus not current'); return required; },
  };
  const request = { commit, parser, indexDigest: manifest.index.digest!, part: 0 };
  return { files, writes, dependencies, request, vectorValues, required, metadata, assertions, reads, setCurrent: (value: boolean) => { current = value; } };
}

describe('immutable vector backups', () => {
  it('uses verified snapshot order, preserves placeholders and publishes the checked manifest last', async () => {
    const h = harness();
    const receipt = await exportSnapshotVectors(h.request, h.dependencies);
    expect(receipt).toMatchObject({ key: vectorsPartKey(commit, 0, parser), count: 3, embedded: 2, notEmbedded: 1 });
    const bytes = h.files.get(vectorsPartKey(commit, 0, parser))!;
    const view = new DataView(bytes.buffer);
    expect([0, 1, 2].map((at) => view.getFloat32(at * 768 * 4, true))).toEqual([1, 0, 3]);
    expect(h.reads.every((ids) => ids.length <= 20)).toBe(true);
    const result = await exportSnapshotVectors({ ...h.request, part: undefined, action: 'manifest' }, h.dependencies);
    expect(result).toMatchObject({ parser, count: 3, embedded: 2, notEmbedded: 1, parts: [{ from: 0, count: 3, sha256: hash(bytes) }] });
    expect(h.writes.at(-1)).toBe(vectorsManifestKey(commit, parser));
    expect(h.writes.every((key) => key.startsWith(`snapshots/${parser}/`))).toBe(true);
  });
  it('retries after an uncertain write without overwriting any bytes and rejects changed vectors', async () => {
    const h = harness();
    const first = await exportSnapshotVectors(h.request, h.dependencies);
    const before = h.writes.length;
    expect(await exportSnapshotVectors(h.request, h.dependencies)).toEqual(first);
    expect(h.writes.length).toBe(before);
    h.vectorValues.get('acts-en-1')![0] = 9;
    await expect(exportSnapshotVectors(h.request, h.dependencies)).rejects.toThrow('SHA-256');
    expect(new DataView(h.files.get(vectorsPartKey(commit, 0, parser))!.buffer).getFloat32(0, true)).toBe(1);
  });
  it.each([NaN, Infinity, 1e100])('rejects non-finite float32 values (%s) before publication', async (value) => {
    const h = harness(); h.vectorValues.get('acts-en-1')![0] = value;
    await expect(exportSnapshotVectors(h.request, h.dependencies)).rejects.toThrow('non-finite');
    expect(h.writes).toEqual([]);
  });
  it('fails closed for missing substantive vectors, wrong dimensions, stale corpus and wrong snapshot identity', async () => {
    const h = harness(); h.vectorValues.delete('acts-en-1');
    await expect(exportSnapshotVectors(h.request, h.dependencies)).rejects.toThrow('non-placeholder');
    h.vectorValues.set('acts-en-1', [1]);
    await expect(exportSnapshotVectors(h.request, h.dependencies)).rejects.toThrow('dimensions');
    h.setCurrent(false);
    await expect(exportSnapshotVectors(h.request, h.dependencies)).rejects.toThrow('not current');
    await expect(exportSnapshotVectors({ ...h.request, indexDigest: '0'.repeat(32) }, h.dependencies)).rejects.toThrow('index identity');
    expect(h.writes).toEqual([]);
  });
  it('waits for visible fingerprint metadata on newly mutated vectors while preserving untouched legacy vectors', async () => {
    const h = harness(); h.required.add('acts-en-1');
    await expect(exportSnapshotVectors(h.request, h.dependencies)).rejects.toThrow('fingerprint');
    expect(h.writes).toEqual([]);
    h.metadata.set('acts-en-1', { fingerprint: 'stale-indexed-vector' });
    await expect(exportSnapshotVectors(h.request, h.dependencies)).rejects.toThrow('fingerprint');
    const rowIndex = JSON.parse(new TextDecoder().decode(h.files.get(indexKey(commit, parser))!).split('\n')[0]!);
    h.metadata.set('acts-en-1', { fingerprint: rowIndex.fp });
    expect(await exportSnapshotVectors(h.request, h.dependencies)).toMatchObject({ embedded: 2 });
  });
  it('does not publish a manifest for corrupt bytes, absent receipts or reordered receipt identity', async () => {
    const h = harness(); const request = { ...h.request, part: undefined, action: 'manifest' };
    await expect(exportSnapshotVectors(request, h.dependencies)).rejects.toThrow('receipt');
    await exportSnapshotVectors(h.request, h.dependencies);
    h.files.get(vectorsPartKey(commit, 0, parser))![0] ^= 1;
    await expect(exportSnapshotVectors(request, h.dependencies)).rejects.toThrow('SHA-256');
    expect(h.files.has(vectorsManifestKey(commit, parser))).toBe(false);
  });
  it('rejects arbitrary IDs, legacy namespace, oversized positions and malformed requests', async () => {
    const h = harness();
    for (const change of [{ ids: ['chosen-id'] }, { parser: undefined }, { parser: 'legacy' }, { part: -1 }, { part: NaN }, { part: 0.1 }, { commit: '../bad' }]) {
      expect(() => parseVectorExportRequest({ ...h.request, ...change })).toThrow();
    }
    await expect(exportSnapshotVectors({ ...h.request, part: 1 }, h.dependencies)).rejects.toThrow('outside');
  });
});

describe('compact corpus writer selection', () => {
  it('retains D1 text by default and requires an R2 binding for explicit blank-text writes', () => {
    expect(retainD1Text(undefined, false)).toBe(true);
    expect(retainD1Text('true', true)).toBe(true);
    expect(retainD1Text('false', true)).toBe(false);
    expect(() => retainD1Text('false', false)).toThrow('R2');
    expect(() => retainD1Text('False', true)).toThrow('true or false');
  });
});
