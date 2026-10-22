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
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENCODER_CONTRACT } from '../src/encoder';
import { parseVectorsManifest, vectorsManifestKey } from '../src/ingest/snapshot-format';
import { token as cloudflareToken } from './lib/cloudflare-auth';
import { readFileSync } from 'node:fs';

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

const manifest = parseVectorsManifest(
  readFileSync(join(dir, vectorsManifestKey(revision)), 'utf8'),
  vectorsManifestKey(revision),
);
if (manifest.dims !== ENCODER_CONTRACT.dimensions) {
  throw new Error(
    `the vectors are ${manifest.dims}-dimensional and the encoder contract says ` +
      `${ENCODER_CONTRACT.dimensions} — the store would not match the queries`,
  );
}

const out = join(dir, `${revision}.store.emb`);
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
  writeFileSync(out, header());

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
    appendFileSync(out, bytes);
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
  console.log(`\n${out} — 16 bytes of header and ${mb(written)} of vectors`);
}

await main();
