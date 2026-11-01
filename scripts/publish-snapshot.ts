#!/usr/bin/env bun
/** Compatibility verifier. Publication is owned by the immutable Workflow;
 * vectors are published by export-vectors.ts after server-side verification.
 * This command performs no remote reads or writes and never reads credentials. */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SnapshotReader } from '../src/ingest/snapshot-source';
import { parseVectorsManifest, SNAPSHOT_PARSER_VERSION, vectorsManifestKey } from '../src/ingest/snapshot-format';
import { FileSnapshotBucket } from './lib/file-snapshot';

const args = process.argv.slice(2);
const arg = (flag: string) => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
const commit = arg('--commit');
const parser = arg('--parser') ?? SNAPSHOT_PARSER_VERSION;
const dir = arg('--dir') ?? 'dist/snapshot';
if (!commit || !/^[a-f0-9]{40}$/.test(commit) || parser !== SNAPSHOT_PARSER_VERSION || args.includes('--publish') || args.includes('--remote')) {
  throw new Error('usage: bun scripts/publish-snapshot.ts --commit <full-sha> --dir <artifact-root> [--vectors]; verification only. Publish with the snapshot Workflow; export-vectors.ts publishes verified vector backups. Legacy root writes are retired.');
}
async function verify(key: string, bytes: number, sha256: string | undefined) {
  const hash = createHash('sha256');
  let count = 0;
  for await (const chunk of createReadStream(join(dir, key))) { count += chunk.length; hash.update(chunk); }
  if (!sha256 || count !== bytes || hash.digest('hex') !== sha256) throw new Error(`local immutable artifact integrity failed: ${key}`);
}
const reader = new SnapshotReader(new FileSnapshotBucket(dir), commit, { parser });
const manifest = await reader.manifest();
for (const part of manifest.rows.parts) await verify(part.key, part.bytes, part.sha256);
let count = 0;
for await (const _entry of reader.indexEntries()) count++;
if (count !== manifest.rows.count) throw new Error('local snapshot index count mismatch');
if (args.includes('--vectors')) {
  const key = vectorsManifestKey(commit, parser);
  const vectors = parseVectorsManifest(readFileSync(join(dir, key), 'utf8'), key);
  if (vectors.commit !== commit || vectors.parser !== parser || vectors.index.entries !== count || vectors.index.digest !== manifest.index.digest) throw new Error('local vectors do not match this exact snapshot index/fingerprints');
  for (const part of vectors.parts) await verify(part.key, part.bytes, part.sha256);
}
console.log(`Verified local ${parser}/${commit}: ${count} rows${args.includes('--vectors') ? ' and positional vector bytes' : ''}. No remote reads or writes. Publish snapshots with the Workflow; export-vectors.ts publishes vector backups.`);
