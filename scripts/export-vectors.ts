#!/usr/bin/env bun
/** Export existing vectors through the authenticated binding-only endpoint.
 * The server selects positions from its verified, immutable snapshot. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ENCODER_CONTRACT } from '../src/encoder';
import { parseVectorsManifest, SNAPSHOT_PARSER_VERSION, vectorsManifestKey, vectorsPartKey } from '../src/ingest/snapshot-format';
import { SnapshotReader } from '../src/ingest/snapshot-source';
import { VECTOR_EXPORT_PART_COUNT, type VectorPartReceipt } from '../services/pipeline/vector-export';
import { FileSnapshotBucket } from './lib/file-snapshot';

const args = process.argv.slice(2);
const arg = (flag: string) => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
const revision = arg('--revision');
const parser = arg('--parser') ?? SNAPSHOT_PARSER_VERSION;
if (!revision || !/^[a-f0-9]{40}$/.test(revision) || parser !== SNAPSHOT_PARSER_VERSION ||
  arg('--per-part') !== undefined && Number(arg('--per-part')) !== VECTOR_EXPORT_PART_COUNT) {
  throw new Error('usage: bun scripts/export-vectors.ts --revision <full-sha> --dir <artifact-root> --url <pipeline-url> [--dry-run]; only current-parser fixed 10000-position parts are supported');
}
const dir = arg('--dir') ?? 'dist/snapshot';
const snapshot = new SnapshotReader(new FileSnapshotBucket(dir), revision, { parser });
const manifest = await snapshot.manifest();
let count = 0;
for await (const _entry of snapshot.indexEntries()) count++;
if (count !== manifest.rows.count || !manifest.index.digest) throw new Error('local snapshot index validation failed');
const identity = { commit: revision, parser, indexDigest: manifest.index.digest };
const parts = Math.ceil(count / VECTOR_EXPORT_PART_COUNT);
if (args.includes('--dry-run')) {
  console.log(JSON.stringify({ ...identity, count, parts, bytes: count * ENCODER_CONTRACT.dimensions * 4, writes: false }, null, 2));
} else {
  const url = arg('--url') ?? process.env.PIPELINE_URL;
  const secret = process.env.PIPELINE_SECRET;
  if (!url || !secret) throw new Error('explicit --url (or PIPELINE_URL) and PIPELINE_SECRET environment variable are required');
  const target = new URL(url);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname))) throw new Error('pipeline URL must use HTTPS, except localhost');
  async function call(body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(new URL('/vectors', target), { method: 'POST',
      headers: { 'x-pipeline-secret': secret!, 'content-type': 'application/json' }, body: JSON.stringify({ ...identity, ...body }) });
    const result = await response.json() as { error?: string };
    if (!response.ok || result.error) throw new Error(`vector export failed: ${result.error ?? response.status}`);
    return result;
  }
  for (let part = 0; part < parts; part++) {
    const receipt = await call({ action: 'part', part }) as VectorPartReceipt;
    const from = part * VECTOR_EXPORT_PART_COUNT;
    const expected = Math.min(VECTOR_EXPORT_PART_COUNT, count - from);
    if (receipt.commit !== revision || receipt.parser !== parser || receipt.indexDigest !== identity.indexDigest ||
      receipt.part !== part || receipt.from !== from || receipt.count !== expected ||
      receipt.key !== vectorsPartKey(revision, part, parser) || receipt.bytes !== expected * ENCODER_CONTRACT.dimensions * 4 ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256)) throw new Error('server returned an invalid vector part identity');
    console.log(`${receipt.key}: ${receipt.count} positions, ${receipt.embedded} vectors, SHA256 ${receipt.sha256}`);
  }
  const vectors = parseVectorsManifest(JSON.stringify(await call({ action: 'manifest' })));
  if (vectors.commit !== revision || vectors.parser !== parser || vectors.index.digest !== identity.indexDigest || vectors.count !== count || vectors.dims !== ENCODER_CONTRACT.dimensions) throw new Error('published vector manifest identity mismatch');
  const path = join(dir, vectorsManifestKey(revision, parser));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(vectors, null, 2)}\n`);
  console.log(`Published and readback-verified ${vectors.parts.length} immutable parts and vector manifest; saved receipt ${path}`);
}
