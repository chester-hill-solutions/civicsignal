import { describe, expect, it } from 'vitest';
import { stageCorpus, buildGroup, sortIndexPartition, publishSnapshot, cleanupStaging, immutablePut,
  PARTITIONS, stagingPrefix, type BuildBucket, type GroupResult } from '../services/snapshot/builder';
import { SnapshotReader } from '../src/ingest/snapshot-source';
import { manifestKey, SNAPSHOT_PARSER_VERSION, indexDigest, assertVectorIndex, SNAPSHOT_FORMAT, type VectorsManifest } from '../src/ingest/snapshot-format';
import { runSnapshotPipeline } from '../src/ingest/snapshot-pipeline';
import { rowsForFile } from '../src/ingest/corpus-rows';
import { fingerprint } from '../src/ingest/reconcile';
import { FakeStore } from './helpers/corpus-store';
import type { CorpusSource, InstrumentFile } from '../src/ingest/source';

const revision = { commit: 'a'.repeat(40), date: '2026-10-22' };
function memoryBucket() {
  const objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; metadata: Record<string, string> }>();
  const writes: string[] = [];
  const bucket = {
    async head(key: string) { const item = objects.get(key); return item ? { size: item.bytes.length, customMetadata: item.metadata } : null; },
    async get(key: string, options?: { range: { offset: number; length: number } }) {
      const item = objects.get(key);
      if (!item) return null;
      const bytes = options ? item.bytes.slice(options.range.offset, options.range.offset + options.range.length) : item.bytes;
      return { arrayBuffer: async () => bytes.slice().buffer, text: async () => new TextDecoder().decode(bytes) };
    },
    async put(key: string, bytes: Uint8Array<ArrayBuffer>, options?: { customMetadata?: Record<string, string>; onlyIf?: unknown }) {
      if (options?.onlyIf && objects.has(key)) return null;
      writes.push(key);
      objects.set(key, { bytes: bytes.slice(), metadata: options?.customMetadata ?? {} });
      return { size: bytes.byteLength };
    },
    async list({ prefix }: { prefix: string }) { return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) }; },
    async delete(keys: string | string[]) { for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key); },
  } as unknown as BuildBucket;
  return { bucket, objects, writes };
}
function instrument(path: string, anchor: string, text: string): InstrumentFile {
  return { path, content: `<Statute xmlns:lims="http://justice.gc.ca/lims"><Identification><ShortTitle>Test Act</ShortTitle><Chapter><ConsolidatedNumber>T-1</ConsolidatedNumber></Chapter></Identification><Body><Section lims:id="${anchor}"><Label>1</Label><MarginalNote>Équité</MarginalNote><Text>${text}</Text></Section></Body></Statute>` };
}
const files = [
  instrument('eng/acts/Z-1.xml', '900', 'Every employee has a right.'),
  instrument('eng/acts/A-1.xml', '100', 'The first provision in sorted index order.'),
  instrument('fra/lois/T-1.xml', '800', 'Chaque employé a droit à un congé.'),
  instrument('eng/regulations/SOR-1.xml', '200', 'A regulatory rule.'),
  instrument('fra/reglements/DORS-1.xml', '300', 'La règle réglementaire.'),
];
function sourceFor(values = files) {
  let archives = 0;
  return { source: { async *instruments() { archives++; yield* values; } } as unknown as CorpusSource,
    archives: () => archives };
}
async function prepare(h: ReturnType<typeof memoryBucket>) {
  const source = sourceFor();
  const plan = await stageCorpus(h.bucket, source.source, revision, 1);
  const groups: GroupResult[] = [];
  let offset = 0;
  for (let group = 0; group < plan.groups.length; group++) {
    const result = await buildGroup(h.bucket, plan, group, offset, 100);
    groups.push(result);
    offset += result.bytes;
  }
  const partitions = [];
  for (const partition of PARTITIONS) partitions.push(await sortIndexPartition(h.bucket, revision.commit, partition, groups));
  return { plan, groups, partitions, source };
}

describe('bounded immutable snapshot Workflow stages', () => {
  it('stages the archive once, writes file-order rows, sorts the index, and ingests a non-empty bilingual revision', async () => {
    const h = memoryBucket();
    const { plan, groups, partitions, source } = await prepare(h);
    const manifest = await publishSnapshot(h.bucket, plan, groups, partitions);
    expect(source.archives()).toBe(1);
    expect(h.writes.at(-1)).toBe(manifestKey(revision.commit, SNAPSHOT_PARSER_VERSION));
    expect(manifest.rows.count).toBe(5);
    const reader = new SnapshotReader(h.bucket, revision.commit, { parser: SNAPSHOT_PARSER_VERSION });
    const index = await reader.index();
    const entries = [...index.values()];
    expect(entries.map((entry) => entry.id)).toEqual(['acts-en-100', 'acts-en-900', 'acts-fr-800', 'regulations-en-200', 'regulations-fr-300']);
    expect(entries[0]!.off).toBeGreaterThan(entries[1]!.off); // sorted index, file-order rows
    expect(manifest.index.digest).toBe(indexDigest(entries));
    const found = await reader.rows(entries);
    const expected = files.flatMap((file) => rowsForFile({ ...file, date: revision.date }));
    expect(new Map(found.map((row) => [row.id, fingerprint(row)]))).toEqual(new Map(expected.map((row) => [row.id, fingerprint(row)])));
    expect(found.find((row) => row.language === 'fr')?.text).toContain('employé');
    const store = new FakeStore();
    const run = await runSnapshotPipeline({ corpusId: 'statutes-canada', revision, source: reader, store,
      encoder: { async embed(documents) { return documents.map(() => [0.1]); } }, now: new Date() });
    expect(run.counts.added).toBe(5);
    expect(store.states[0]).toMatchObject({ commit: revision.commit, rowCount: 5 });
  });

  it('replays interrupted parsing and publication without replacing any immutable artifact', async () => {
    const h = memoryBucket();
    const { plan, groups, partitions } = await prepare(h);
    const before = h.writes.length;
    expect(await buildGroup(h.bucket, plan, 0, 0, 100)).toEqual(groups[0]);
    expect(h.writes.length).toBe(before);
    await publishSnapshot(h.bucket, plan, groups, partitions);
    const publishedWrites = h.writes.length;
    await publishSnapshot(h.bucket, plan, groups, partitions);
    expect(h.writes.length).toBe(publishedWrites);
    await expect(immutablePut(h.bucket, manifestKey(revision.commit, SNAPSHOT_PARSER_VERSION), new Uint8Array(new TextEncoder().encode('different')))).rejects.toThrow('immutable artifact conflict');
  });

  it('does not announce a snapshot with a missing row part', async () => {
    const h = memoryBucket();
    const { plan, groups, partitions } = await prepare(h);
    h.objects.delete(groups[0]!.rows[0]!.key);
    await expect(publishSnapshot(h.bucket, plan, groups, partitions)).rejects.toThrow('snapshot part unavailable');
    expect(h.objects.has(manifestKey(revision.commit, SNAPSHOT_PARSER_VERSION))).toBe(false);
  });

  it('rejects duplicate row identities before publication', async () => {
    const h = memoryBucket();
    const plan = await stageCorpus(h.bucket, sourceFor([files[0]!, files[0]!]).source, revision, 1);
    const first = await buildGroup(h.bucket, plan, 0, 0);
    const second = await buildGroup(h.bucket, plan, 1, first.bytes);
    await expect(sortIndexPartition(h.bucket, revision.commit, PARTITIONS[0], [first, second])).rejects.toThrow('duplicate');
    expect(h.objects.has(manifestKey(revision.commit, SNAPSHOT_PARSER_VERSION))).toBe(false);
  });

  it('refuses a corrupted staged artifact and empty corpus', async () => {
    const h = memoryBucket();
    await expect(stageCorpus(h.bucket, sourceFor([]).source, revision)).rejects.toThrow('empty corpus');
    const plan = await stageCorpus(h.bucket, sourceFor().source, revision);
    h.objects.get(plan.groups[0]!.key)!.bytes[0] = 0;
    await expect(buildGroup(h.bucket, plan, 0, 0)).rejects.toThrow('artifact integrity failed');
  });

  it('cleans only this revision staging data after publication', async () => {
    const h = memoryBucket();
    const { plan, groups, partitions } = await prepare(h);
    await publishSnapshot(h.bucket, plan, groups, partitions);
    await immutablePut(h.bucket, `${stagingPrefix('other')}keep`, new Uint8Array([1]));
    await cleanupStaging(h.bucket, revision.commit);
    expect([...h.objects.keys()].some((key) => key.startsWith(stagingPrefix(revision.commit)))).toBe(false);
    expect(h.objects.has(manifestKey(revision.commit, SNAPSHOT_PARSER_VERSION))).toBe(true);
    expect(h.objects.has(`${stagingPrefix('other')}keep`)).toBe(true);
  });

  it('rejects a changed index fingerprint before a diff can write or delete anything', async () => {
    const h = memoryBucket();
    const { plan, groups, partitions } = await prepare(h);
    const manifest = await publishSnapshot(h.bucket, plan, groups, partitions);
    const item = h.objects.get(manifest.index.key)!;
    const text = new TextDecoder().decode(item.bytes).replace(/"fp":"[^"]+"/, '"fp":"changed"');
    item.bytes = new Uint8Array(new TextEncoder().encode(text));
    const reader = new SnapshotReader(h.bucket, revision.commit, { parser: SNAPSHOT_PARSER_VERSION });
    await expect(reader.index()).rejects.toThrow(/snapshot index (byte count|SHA-256|fingerprint digest) mismatch/);
  });

  it('rejects a row whose bytes no longer match its index identity', async () => {
    const h = memoryBucket();
    const { plan, groups, partitions } = await prepare(h);
    const manifest = await publishSnapshot(h.bucket, plan, groups, partitions);
    const reader = new SnapshotReader(h.bucket, revision.commit, { parser: SNAPSHOT_PARSER_VERSION });
    const entry = [...(await reader.index()).values()][0]!;
    const part = manifest.rows.parts.find((part) => new TextDecoder().decode(h.objects.get(part.key)!.bytes).includes('acts-en-100'))!;
    const item = h.objects.get(part.key)!;
    item.bytes = new Uint8Array(new TextEncoder().encode(new TextDecoder().decode(item.bytes).replace('acts-en-100', 'acts-en-999')));
    await expect(reader.row(entry.id, entry)).rejects.toThrow('identity or fingerprint mismatch');
  });

  it('requires positional vector manifests to match ids, order and fingerprints', () => {
    const entries = [{ id: 'a', fp: 'one' }, { id: 'b', fp: 'two' }];
    const manifest: VectorsManifest = { format: SNAPSHOT_FORMAT, commit: revision.commit, dims: 1,
      count: 2, bytes: 8, parts: [{ key: 'vectors', bytes: 8, count: 2, from: 0 }],
      index: { entries: 2, digest: indexDigest(entries) }, embedded: 2, notEmbedded: 0 };
    expect(() => assertVectorIndex(manifest, entries)).not.toThrow();
    expect(() => assertVectorIndex(manifest, [...entries].reverse())).toThrow('exact snapshot');
    expect(() => assertVectorIndex(manifest, [{ ...entries[0]!, fp: 'changed' }, entries[1]!])).toThrow('fingerprints');
  });
});
