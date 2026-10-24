import { createHash } from 'node:crypto';
import { ENCODER_CONTRACT } from '../../src/encoder';
import { SnapshotReader } from '../../src/ingest/snapshot-source';
import { indexDigest, parseVectorsManifest, SNAPSHOT_FORMAT, SNAPSHOT_PARSER_VERSION,
  vectorsManifestKey, vectorsPartKey, type VectorsManifest } from '../../src/ingest/snapshot-format';
import type { SnapshotIndexEntry } from '../../src/ingest/snapshot-diff';

/** Fixed server-side partitioning is part of the export identity. */
export const VECTOR_EXPORT_PART_COUNT = 10_000;
const DIMS = ENCODER_CONTRACT.dimensions;
const GET_BATCH = 20;
export interface VectorExportRequest {
  action?: 'part' | 'manifest';
  commit: string;
  parser: string;
  indexDigest: string;
  part?: number;
}
export interface VectorPartReceipt {
  format: 1;
  commit: string;
  parser: string;
  indexDigest: string;
  partDigest: string;
  part: number;
  key: string;
  from: number;
  count: number;
  bytes: number;
  sha256: string;
  embedded: number;
  notEmbedded: number;
}
export interface VectorExportDependencies {
  bucket: Pick<R2Bucket, 'get' | 'put'>;
  vector: Pick<Vectorize, 'getByIds'>;
  /** Must check revision, parser, total, empty outbox and these fingerprints.
   * The caller also serializes this operation with all corpus writes. */
  assertCurrent(entries: readonly SnapshotIndexEntry[], total: number): Promise<ReadonlySet<string>>;
}
export function parseVectorExportRequest(value: unknown): VectorExportRequest {
  if (!value || typeof value !== 'object') throw new Error('invalid vector export request');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['action', 'commit', 'parser', 'indexDigest', 'part'].includes(key)) ||
    typeof body.commit !== 'string' || !/^[a-f0-9]{40}$/.test(body.commit) || body.parser !== SNAPSHOT_PARSER_VERSION ||
    typeof body.indexDigest !== 'string' || !/^[a-f0-9]{32}$/.test(body.indexDigest) ||
    body.action !== undefined && body.action !== 'part' && body.action !== 'manifest' ||
    body.action !== 'manifest' && (!Number.isSafeInteger(body.part) || (body.part as number) < 0) ||
    body.action === 'manifest' && body.part !== undefined) {
    throw new Error('vectors require a full SHA, current parser, published indexDigest and bounded part number; caller IDs are forbidden');
  }
  return body as unknown as VectorExportRequest;
}
const receiptKey = (request: VectorExportRequest, part: number) => `${vectorsPartKey(request.commit, part, request.parser)}.receipt.json`;
const encode = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(text));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function verifyObject(bucket: VectorExportDependencies['bucket'], key: string, bytes: number, sha256: string): Promise<void> {
  const object = await bucket.get(key);
  if (!object || object.size !== bytes) throw new Error(`missing or truncated immutable vector artifact: ${key}`);
  const hash = createHash('sha256');
  let read = 0;
  if (object.body) {
    const reader = object.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        read += value.byteLength;
        hash.update(value);
      }
    } finally { reader.releaseLock(); }
  } else {
    const value = new Uint8Array(await object.arrayBuffer());
    read = value.byteLength;
    hash.update(value);
  }
  if (read !== bytes || hash.digest('hex') !== sha256) throw new Error(`immutable vector artifact SHA-256 mismatch: ${key}`);
}
async function immutableWrite(bucket: VectorExportDependencies['bucket'], key: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const sha256 = digest(bytes);
  await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, customMetadata: { sha256 } });
  // Verify actual bytes on first write and retry, including an uncertain put acknowledgement.
  await verifyObject(bucket, key, bytes.byteLength, sha256);
  return sha256;
}
async function entriesForPart(snapshot: SnapshotReader, part: number): Promise<SnapshotIndexEntry[]> {
  const entries: SnapshotIndexEntry[] = [];
  const from = part * VECTOR_EXPORT_PART_COUNT;
  let position = 0;
  for await (const entry of snapshot.indexEntries()) {
    if (position >= from && position < from + VECTOR_EXPORT_PART_COUNT) entries.push(entry);
    position++;
  }
  if (!entries.length) throw new Error('vector part is outside the published snapshot');
  return entries;
}
function parseReceipt(text: string, request: VectorExportRequest, part: number, total: number): VectorPartReceipt {
  const value = JSON.parse(text) as VectorPartReceipt;
  const from = part * VECTOR_EXPORT_PART_COUNT;
  const count = Math.min(VECTOR_EXPORT_PART_COUNT, total - from);
  if (!value || value.format !== 1 || value.commit !== request.commit || value.parser !== request.parser ||
    value.indexDigest !== request.indexDigest || value.part !== part || value.from !== from || value.count !== count ||
    value.key !== vectorsPartKey(request.commit, part, request.parser) || value.bytes !== count * DIMS * 4 ||
    !/^[a-f0-9]{64}$/.test(value.sha256) || !/^[a-f0-9]{32}$/.test(value.partDigest) ||
    !Number.isSafeInteger(value.embedded) || value.embedded < 0 || !Number.isSafeInteger(value.notEmbedded) ||
    value.notEmbedded < 0 || value.embedded + value.notEmbedded !== count) throw new Error('vector part receipt identity mismatch');
  return value;
}

/** Reads existing Vectorize values only. Never inserts, clears or rebuilds the index. */
export async function exportSnapshotVectors(input: unknown, dependencies: VectorExportDependencies): Promise<VectorPartReceipt | VectorsManifest> {
  const request = parseVectorExportRequest(input);
  const { bucket, vector, assertCurrent } = dependencies;
  const snapshot = new SnapshotReader(bucket, request.commit, { parser: request.parser });
  const manifest = await snapshot.manifest();
  if (manifest.index.digest !== request.indexDigest) throw new Error('published snapshot index identity mismatch');
  const total = manifest.rows.count;
  await assertCurrent([], total);
  if (request.action === 'manifest') {
    const parts: VectorsManifest['parts'] = [];
    let embedded = 0;
    let position = 0;
    let entries: SnapshotIndexEntry[] = [];
    const finishPart = async () => {
      const part = parts.length;
      const object = await bucket.get(receiptKey(request, part));
      if (!object) throw new Error(`vector export part ${part} has no verified receipt`);
      const receipt = parseReceipt(await object.text(), request, part, total);
      if (receipt.partDigest !== indexDigest(entries)) throw new Error('vector part receipt index order mismatch');
      await assertCurrent(entries, total);
      await verifyObject(bucket, receipt.key, receipt.bytes, receipt.sha256);
      parts.push({ key: receipt.key, bytes: receipt.bytes, count: receipt.count, from: receipt.from, sha256: receipt.sha256 });
      embedded += receipt.embedded;
      entries = [];
    };
    for await (const entry of snapshot.indexEntries()) {
      entries.push(entry);
      position++;
      if (entries.length === VECTOR_EXPORT_PART_COUNT) await finishPart();
    }
    if (entries.length) await finishPart();
    if (position !== total) throw new Error('vector export index count mismatch');
    await assertCurrent([], total);
    const result = parseVectorsManifest(JSON.stringify({ format: SNAPSHOT_FORMAT, commit: request.commit, parser: request.parser,
      dims: DIMS, count: total, bytes: total * DIMS * 4, parts, index: { entries: total, digest: request.indexDigest },
      embedded, notEmbedded: total - embedded }));
    await immutableWrite(bucket, vectorsManifestKey(request.commit, request.parser), encode(`${JSON.stringify(result, null, 2)}\n`));
    return result;
  }

  const part = request.part!;
  if (part >= Math.ceil(total / VECTOR_EXPORT_PART_COUNT)) throw new Error('vector part is outside the published snapshot');
  const entries = await entriesForPart(snapshot, part);
  const requireFingerprint = await assertCurrent(entries, total);
  // 30.72 MB at the fixed ceiling. Binding responses are discarded every 20
  // vectors; a full part is never also retained as a JS number[][] map.
  const bytes = new Uint8Array(new ArrayBuffer(entries.length * DIMS * 4));
  const packed = new DataView(bytes.buffer);
  let embedded = 0;
  for (let at = 0; at < entries.length; at += GET_BATCH) {
    const chunk = entries.slice(at, at + GET_BATCH);
    const expected = new Map(chunk.map((entry) => [entry.id, entry]));
    const found = new Set<string>();
    for (const item of await vector.getByIds(chunk.map((entry) => entry.id))) {
      const entry = expected.get(item.id);
      if (!entry || found.has(item.id)) throw new Error('Vectorize returned duplicate or unrequested vector IDs');
      found.add(item.id);
      if (item.values.length !== DIMS || (requireFingerprint.has(item.id) || item.metadata?.fingerprint !== undefined) && item.metadata?.fingerprint !== entry.fp) {
        throw new Error(`vector dimensions or fingerprint mismatch: ${item.id}`);
      }
      const offset = at + chunk.findIndex((candidate) => candidate.id === item.id);
      for (let dimension = 0; dimension < DIMS; dimension++) {
        const value = item.values[dimension]!;
        if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new Error(`non-finite vector: ${item.id}`);
        packed.setFloat32((offset * DIMS + dimension) * 4, value, true);
      }
      embedded++;
    }
    const missing = chunk.filter((entry) => !found.has(entry.id));
    if (missing.length) {
      const rows = await snapshot.rows(missing);
      if (rows.length !== missing.length || rows.some((row) => row.status !== 'placeholder')) {
        throw new Error(`vector export has missing non-placeholder vectors: ${missing.map((entry) => entry.id).join(', ')}`);
      }
    }
  }
  await assertCurrent(entries, total);
  const key = vectorsPartKey(request.commit, part, request.parser);
  const sha256 = await immutableWrite(bucket, key, bytes);
  const receipt: VectorPartReceipt = { format: 1, commit: request.commit, parser: request.parser, indexDigest: request.indexDigest,
    partDigest: indexDigest(entries), part, key, from: part * VECTOR_EXPORT_PART_COUNT, count: entries.length,
    bytes: bytes.byteLength, sha256, embedded, notEmbedded: entries.length - embedded };
  await immutableWrite(bucket, receiptKey(request, part), encode(`${JSON.stringify(receipt)}\n`));
  return receipt;
}

/** Export only after the selected revision/parser finished all vector writes.
 * Bound IDs to 80 per query, below D1's 100 parameter ceiling. */
export async function assertCorpusVectorExportCurrent(db: D1Database, corpusId: string, body: VectorExportRequest,
  entries: readonly SnapshotIndexEntry[], total: number): Promise<ReadonlySet<string>> {
  const state = await db.prepare(
    `SELECT commit_sha, parser_version, row_count,
      (SELECT COUNT(*) FROM corpus_mutations WHERE corpus_id = ? AND payload IS NOT NULL) AS pending,
      (SELECT COUNT(*) FROM statute_sections WHERE corpus_id = ?) AS actual
     FROM corpus_state WHERE corpus_id = ?`,
  ).bind(corpusId, corpusId, corpusId).first<{
    commit_sha: string; parser_version: string; row_count: number; pending: number; actual: number;
  }>();
  if (!state || state.commit_sha !== body.commit || state.parser_version !== body.parser ||
    state.row_count !== total || state.actual !== total || state.pending !== 0) {
    throw new Error('vector backup requires the completed matching corpus revision/parser, row count and empty vector outbox');
  }
  const requireFingerprint = new Set<string>();
  for (let at = 0; at < entries.length; at += 80) {
    const chunk = entries.slice(at, at + 80);
    const result = await db.prepare(
      `SELECT s.id, s.text_hash,
       EXISTS(SELECT 1 FROM corpus_mutations m WHERE m.id = json_array(?, ?, s.id, s.text_hash)) AS requires_fingerprint
       FROM statute_sections s WHERE s.corpus_id = ? AND s.id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(corpusId, body.commit, corpusId, ...chunk.map((entry) => entry.id)).all<{ id: string; text_hash: string; requires_fingerprint: number }>();
    for (const row of result.results) if (row.requires_fingerprint) requireFingerprint.add(row.id);
    const found = new Map(result.results.map((row) => [row.id, row.text_hash]));
    if (chunk.some((entry) => found.get(entry.id) !== entry.fp)) throw new Error('serving corpus fingerprints differ from the published vector snapshot');
  }
  return requireFingerprint;
}
