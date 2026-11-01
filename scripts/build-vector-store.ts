#!/usr/bin/env bun
/**
 * Assemble the full corpus's vectors into a local store, from R2.
 *
 * Every retrieval measurement so far has been taken on a 19,021-section
 * evaluation corpus, because embedding 277,857 provisions takes about five
 * hours on the deployed container. The vectors now exist as a file — 28 parts
 * in the bucket, written by the export — so the measurement can be taken on
 * the corpus the product actually serves, where the candidate sets are denser
 * and the distractors harder. That matters most for the refusal threshold,
 * which is the number that decides whether the product says "I don't know".
 *
 * The parts are flat float32 in the **index's** order, so concatenating them in
 * part order gives exactly the layout `loadVectorStore` wants; all this adds is
 * its sixteen-byte header. Streamed a part at a time, because 853 MB is not
 * something to hold twice.
 *
 *     bun scripts/build-vector-store.ts --revision 0507465
 */
import { appendFileSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { SnapshotReader } from '../src/ingest/snapshot-source';
import { FileSnapshotBucket } from './lib/file-snapshot';
import { ENCODER_CONTRACT } from '../src/encoder';
import { IndexDigester, parseVectorsManifest, SNAPSHOT_PARSER_VERSION, snapshotNamespace, vectorsManifestKey } from '../src/ingest/snapshot-format';
import { token as cloudflareToken } from './lib/cloudflare-auth';

const BUCKET = 'civicsignal-corpus';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'ad5ec479b9a421faa2ed06c3d1c2b23a';
const MAGIC = 0x43535356; // "CVSV", as `src/eval/retrieval.ts` reads it

const args = process.argv.slice(2);
function arg(flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

const revision = arg('--revision', '');
const dir = arg('--dir', join('dist', 'snapshot'));
if (!revision) {
  console.error('usage: bun scripts/build-vector-store.ts --revision <sha> [--dir dist/snapshot]');
  process.exit(2);
}

const selectedParser = arg('--parser', SNAPSHOT_PARSER_VERSION);
if (selectedParser !== 'legacy' && selectedParser !== SNAPSHOT_PARSER_VERSION) throw new Error('unsupported parser; select current parser or explicit legacy');
const parser = selectedParser === 'legacy' ? undefined : selectedParser;

const manifest = parseVectorsManifest(
  readFileSync(join(dir, vectorsManifestKey(revision, parser)), 'utf8'),
  vectorsManifestKey(revision, parser),
);
if (manifest.commit !== revision || manifest.parser !== parser) throw new Error('vector manifest revision/parser mismatch');
const snapshot = new SnapshotReader(new FileSnapshotBucket(dir), revision, { parser });
const identity = new IndexDigester();
let entries = 0;
for await (const entry of snapshot.indexEntries()) { identity.add(entry); entries++; }
if (entries !== manifest.index.entries || identity.digest() !== manifest.index.digest) throw new Error('vectors do not belong to this exact snapshot index and fingerprints');
if (manifest.dims !== ENCODER_CONTRACT.dimensions) {
  throw new Error(
    `the vectors are ${manifest.dims}-dimensional and the encoder contract says ` +
      `${ENCODER_CONTRACT.dimensions} — the store would not match the queries`,
  );
}

const out = join(dir, snapshotNamespace(parser), `${revision}.store.emb`);
const temporary = `${out}.partial`;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The sixteen-byte header `loadVectorStore` reads, then nothing else. */
function header(): Buffer {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32LE(MAGIC, 0);
  buffer.writeUInt32LE(manifest.count, 4);
  buffer.writeUInt32LE(manifest.dims, 8);
  return buffer;
}

async function main(): Promise<void> {
  console.log(
    `${manifest.count} vector(s) of ${manifest.dims} in ${manifest.parts.length} part(s), ` +
      `${mb(manifest.bytes)} — assembling ${out}`,
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(temporary, header());

  let written = 0;
  for (const [at, part] of manifest.parts.entries()) {
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}` +
      `/objects/${encodeURIComponent(part.key)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${cloudflareToken()}` } });
    if (!response.ok) throw new Error(`the bucket refused ${part.key}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength !== part.bytes) {
      throw new Error(
        `${part.key} is ${bytes.byteLength} bytes in the bucket and ${part.bytes} in the manifest`,
      );
    }
    if (part.sha256 && createHash('sha256').update(bytes).digest('hex') !== part.sha256) throw new Error(`vector part SHA-256 mismatch: ${part.key}`);
    appendFileSync(temporary, bytes);
    written += bytes.byteLength;
    console.log(
      `  ${String(at + 1).padStart(2)}/${manifest.parts.length}  ${part.key}  ` +
        `${mb(bytes.byteLength)}  (${mb(written)} of ${mb(manifest.bytes)})`,
    );
  }

  const expected = manifest.count * manifest.dims * 4;
  if (written !== expected) {
    throw new Error(`wrote ${written} bytes of vectors, expected ${expected}`);
  }
  renameSync(temporary, out);
  console.log(`\n${out} — 16 bytes of header and ${mb(written)} of vectors`);
}

try { await main(); } catch (error) { rmSync(temporary, { force: true }); throw error; }
