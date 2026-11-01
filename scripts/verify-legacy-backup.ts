/** Check existing legacy snapshot/vector bytes locally. Never contacts Cloudflare. */
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnapshotReader } from '../src/ingest/snapshot-source';
import { IndexDigester, parseManifest, parseVectorsManifest } from '../src/ingest/snapshot-format';
import type { SnapshotIndexEntry } from '../src/ingest/snapshot-diff';
import { FileSnapshotBucket } from './lib/file-snapshot';

export async function verifyLegacyBackup(options: { directory: string; revision: string; onProgress?: (rows: number) => void }) {
  if (!/^[a-f0-9]{40}$/.test(options.revision)) throw new Error('A complete legacy source SHA is required.');
  const root = resolve(options.directory);
  const manifestKey = `${options.revision}.manifest.json`;
  const vectorsKey = `${options.revision}.vectors.manifest.json`;
  const manifest = parseManifest(readFileSync(join(root, manifestKey), 'utf8'));
  const vectors = parseVectorsManifest(readFileSync(join(root, vectorsKey), 'utf8'));
  if (manifest.commit !== options.revision || vectors.commit !== options.revision || manifest.parser || vectors.parser ||
      vectors.dims !== 768 || vectors.count !== manifest.rows.count) throw new Error('Legacy snapshot/vector identity mismatch.');
  const storeKey = `${options.revision}.store.emb`;
  const file = openSync(join(root, storeKey), 'r');
  let checked = 0;
  let embedded = 0;
  let placeholders = 0;
  try {
    const header = Buffer.alloc(16);
    if (readSync(file, header, 0, 16, 0) !== 16 || header.readUInt32LE(0) !== 0x43535356 ||
      header.readUInt32LE(4) !== vectors.count || header.readUInt32LE(8) !== vectors.dims ||
      statSync(join(root, storeKey)).size !== 16 + vectors.bytes) throw new Error('Legacy vector store header/length mismatch.');
    const source = new SnapshotReader(new FileSnapshotBucket(root), options.revision);
    const identity = new IndexDigester();
    let entries: SnapshotIndexEntry[] = [];
    async function checkBatch() {
      const rows = await source.rows(entries);
      if (rows.length !== entries.length) throw new Error('Legacy backup has missing rows.');
      const bytes = Buffer.alloc(entries.length * vectors.dims * 4);
      if (readSync(file, bytes, 0, bytes.length, 16 + checked * vectors.dims * 4) !== bytes.length) throw new Error('Legacy vector bytes are truncated.');
      for (let at = 0; at < rows.length; at++) {
        const row = rows[at]!;
        if (row.id !== entries[at]!.id) throw new Error('Legacy positional row identity mismatch.');
        let nonzero = false;
        for (let dimension = 0; dimension < vectors.dims; dimension++) {
          const value = bytes.readFloatLE((at * vectors.dims + dimension) * 4);
          if (!Number.isFinite(value)) throw new Error('Legacy backup contains a non-finite vector.');
          if (value !== 0) nonzero = true;
        }
        if (row.status === 'placeholder') {
          if (nonzero) throw new Error('Legacy placeholder has unexpected vector values.');
          placeholders++;
        } else {
          if (!nonzero) throw new Error('Legacy non-placeholder has a zero vector.');
          embedded++;
        }
      }
      checked += entries.length;
      entries = [];
      if (checked % 25000 < 256) options.onProgress?.(checked);
    }
    for await (const entry of source.indexEntries()) {
      identity.add(entry);
      entries.push(entry);
      if (entries.length === 256) await checkBatch();
    }
    if (entries.length) await checkBatch();
    if (checked !== vectors.count || identity.digest() !== vectors.index.digest || embedded !== vectors.embedded ||
      placeholders !== vectors.notEmbedded) throw new Error('Legacy backup count or ordered fingerprint mismatch.');
  } finally { closeSync(file); }
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const key of [manifestKey, vectorsKey, manifest.index.key, ...manifest.rows.parts.map((part) => part.key), storeKey]) {
    if (key.includes('/') || key.includes('..') || !key.startsWith(options.revision + '.')) throw new Error('Unsafe legacy artifact name.');
    const path = join(root, key);
    const digest = createHash('sha256');
    const descriptor = openSync(path, 'r');
    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    try {
      for (;;) {
        const read = readSync(descriptor, buffer, 0, buffer.length, offset);
        if (!read) break;
        digest.update(buffer.subarray(0, read)); offset += read;
      }
    } finally { closeSync(descriptor); }
    const expected = manifest.rows.parts.find((part) => part.key === key)?.bytes ?? (key === manifest.index.key ? manifest.index.bytes : undefined);
    if (expected !== undefined && offset !== expected) throw new Error('Legacy artifact byte count differs from manifest.');
    files[key] = { bytes: offset, sha256: digest.digest('hex') };
  }
  return { format: 1 as const, observedAt: new Date().toISOString(),
    source: { commit: options.revision, date: manifest.date, parser: 'legacy' as const, indexDigest: vectors.index.digest,
      rows: checked, embedded, placeholders, dimensions: vectors.dims }, files,
    verification: { allRows: true, rows: checked, allVectorPositions: true, finite: true, placeholderZeros: true },
    limitation: 'Local downloaded bytes and positional identity. Live stored-vector equality requires a separate sampled readback.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== '--dir' || args[2] !== '--revision' || args[4] !== '--output') {
    throw new Error('Use --dir <legacy files> --revision <full SHA> --output <new receipt.json>.');
  }
  const receipt = await verifyLegacyBackup({ directory: args[1]!, revision: args[3]!, onProgress: (rows) => console.error(`Checked ${rows} legacy rows/vectors.`) });
  writeFileSync(args[5]!, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(receipt, null, 2));
}
