import { createHash } from 'node:crypto';
import { SnapshotReader, type SnapshotBucket } from '../../src/ingest/snapshot-source';
import { indexDigest, indexKey, manifestKey, SNAPSHOT_PARSER_VERSION as parser, vectorsPartKey, type VectorsManifest } from '../../src/ingest/snapshot-format';
import { planVectorBackup, type VectorBackupPlan } from '../../scripts/lib/vector-export-client';
import type { VectorPartReceipt } from '../../services/pipeline/vector-export';
export const commit = 'a'.repeat(40), coordinatorId = 'c'.repeat(64), revision = 5;
export const origin = 'https://pipeline.invalid', secret = 'PRIVATE-local-fixture-secret';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export async function vectorBackupFixture(count = 3) {
  const entries = Array.from({ length: count }, (_, n) => ({ id: `acts-en-${String(n).padStart(6, '0')}`, fp: String(n % 10).repeat(32), off: n, len: 1 }));
  const index = entries.map(e => JSON.stringify(e) + '\n').join(''), rows = 'x'.repeat(count);
  const rowKey = `snapshots/${parser}/${commit}.rows.000.jsonl`;
  const sourceManifest = { format: 1, commit, parser, date: '2026-10-15', rows: { count, bytes: count, partBytes: count,
    parts: [{ key: rowKey, bytes: count, sha256: hash(rows) }] },
    index: { key: indexKey(commit, parser), bytes: Buffer.byteLength(index), entries: count, digest: indexDigest(entries), sha256: hash(index) } };
  const files = new Map([[manifestKey(commit, parser), JSON.stringify(sourceManifest)], [indexKey(commit, parser), index], [rowKey, rows]]);
  const bucket: SnapshotBucket = { async get(key) {
    const text = files.get(key); if (text === undefined) return null;
    const bytes = new TextEncoder().encode(text);
    return { async arrayBuffer() { return new Uint8Array(bytes).buffer; },
      body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) };
  } };
  const reader = () => new SnapshotReader(bucket, commit, { parser });
  const plan = await planVectorBackup(reader());
  const receipts: VectorPartReceipt[] = plan.parts.map(p => ({ format: 1, commit, parser, indexDigest: plan.indexDigest,
    partDigest: p.partDigest, part: p.part, key: vectorsPartKey(commit, p.part, parser), from: p.from, count: p.count,
    bytes: p.count * 768 * 4, sha256: String(p.part % 10).repeat(64), embedded: p.count, notEmbedded: 0 }));
  const manifest: VectorsManifest = { format: 1, commit, parser, dims: 768, count, bytes: count * 768 * 4,
    parts: receipts.map(r => ({ key: r.key, from: r.from, count: r.count, bytes: r.bytes, sha256: r.sha256 })),
    index: { entries: count, digest: plan.indexDigest }, embedded: count, notEmbedded: 0 };
  const control = { corpusId: plan.corpusId, coordinatorId, coordinator: { format: 1, revision, suspended: true, quiescent: true,
    active: null, queued: 0, alarmHandlersActive: 0, alarmAt: null, pending: false, failures: 0, lastFailure: null } };
  const json = (value: unknown, echo = true) => Response.json(value, { headers: echo ? { 'x-pipeline-suspension-revision': String(revision) } : {} });
  return { files, sourceManifest, entries, reader, plan, receipts, manifest, control, json };
}
export const expectedCalls = (plan: VectorBackupPlan) => ['/control', ...plan.parts.map(() => '/vectors'), '/vectors', '/control'];
