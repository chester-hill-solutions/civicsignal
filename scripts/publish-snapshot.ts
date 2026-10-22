#!/usr/bin/env bun
/**
 * Publish a snapshot to R2.
 *
 * A snapshot is built locally — it takes a clone of the corpus, three hundred
 * and sixty megabytes of rows and a few minutes — and the pipeline reads it
 * out of the bucket. This is the step in between, and it is a step of its own
 * because it is the one that can fail *quietly*.
 *
 * It did. The rows were uploaded by hand, the upload could not work, and the
 * bucket was left holding an index with nothing behind it. Nothing said so,
 * because a missing object is not an error until something reads it — and by
 * then the cycle is failing in production with a message about a provision
 * its index names and a row that is not there.
 *
 * **Why the rows are parts.** Neither wrangler nor the Cloudflare API will
 * upload a single object larger than 300 MB, and the rows are 347. The
 * builder cuts them into parts for that reason, and this publishes each part
 * as its own object — so the upload is six or seven ordinary requests instead
 * of one that cannot work.
 *
 * **Why it verifies.** Every object is uploaded and then read back and
 * *sized*, and the manifest is only believed once its parts add up. The order
 * is deliberate: the rows go first, then the index, then the manifest last —
 * because the manifest is what says a snapshot is there, and a snapshot that
 * is announced before it is complete is the failure this exists to prevent.
 *
 *     bun scripts/publish-snapshot.ts --commit 0507465
 *     bun scripts/publish-snapshot.ts --commit 0507465 --dir dist/snapshot
 *     bun scripts/publish-snapshot.ts --commit 0507465 --vectors
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseManifest,
  parseVectorsManifest,
  vectorsManifestKey,
} from '../src/ingest/snapshot-format';
import { token } from './lib/cloudflare-auth';

const BUCKET = 'civicsignal-corpus';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'ad5ec479b9a421faa2ed06c3d1c2b23a';

const args = process.argv.slice(2);
function arg(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
function flag(name: string): boolean {
  return args.includes(name);
}

const commit = arg('--commit');
const dir = arg('--dir') ?? 'dist/snapshot';
if (!commit) {
  console.error('usage: bun scripts/publish-snapshot.ts --commit <sha> [--dir dist/snapshot]');
  process.exit(2);
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * The object as the bucket has it, or null.
 *
 * The object endpoint itself returns the object's **body** — asking it for
 * metadata parses a 64 MB JSONL part as JSON, which is how this was written
 * the first time and what it did. The listing endpoint is the one that
 * answers "is it there, and how big is it", and the exact key is matched
 * because a prefix is not a key.
 */
async function head(key: string): Promise<{ size: number } | null> {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects` +
    `?prefix=${encodeURIComponent(key)}&per_page=100`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } });
  if (!response.ok) {
    throw new Error(`the bucket could not be asked about ${key}: HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    success: boolean;
    result?: { key: string; size: number }[];
  };
  if (!body.success) throw new Error(`the bucket could not be asked about ${key}`);
  const found = body.result?.find((object) => object.key === key);
  return found ? { size: found.size } : null;
}

/** Every object under a prefix, with its size. */
async function listing(prefix: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  let cursor = '';
  for (;;) {
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects` +
      `?prefix=${encodeURIComponent(prefix)}&per_page=1000` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } });
    if (!response.ok) throw new Error(`the bucket could not be listed: HTTP ${response.status}`);
    const body = (await response.json()) as {
      success: boolean;
      result?: { key: string; size: number }[];
      result_info?: { is_truncated: boolean; cursor: string };
    };
    if (!body.success) throw new Error('the bucket could not be listed');
    for (const object of body.result ?? []) sizes.set(object.key, object.size);
    if (!body.result_info?.is_truncated) return sizes;
    cursor = body.result_info.cursor;
  }
}

/**
 * The object's bytes, as the bucket has them.
 *
 * This is the object endpoint, and it returns the **body** — which is what
 * makes it useless for "is it there?" and exactly right for "is it the file I
 * just uploaded?".
 */
async function bytesOf(key: string): Promise<Uint8Array> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects/${encodeURIComponent(key)}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } });
  if (!response.ok) {
    throw new Error(`the bucket could not be read for ${key}: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Upload one file with wrangler, reporting what went wrong if it does. */
function upload(key: string, path: string): void {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execFileSync(
        'npx',
        ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', path, '--remote'],
        {
          encoding: 'utf8',
          env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
        },
      );
      return;
    } catch (error) {
      last = error;
      if (attempt < 3) console.log(`  ${key} — attempt ${attempt} failed, trying again`);
    }
  }
  // `execFileSync` with inherited stdio reports a failure as
  // `signal: null, status: 1, output: [null, null, null]`, which is a thing
  // nobody can act on. The output is captured for exactly this.
  const failure = last as { stderr?: string; stdout?: string; message?: string };
  const detail = (failure.stderr || failure.stdout || failure.message || String(last)).trim();
  throw new Error(`wrangler could not upload ${key}:\n${detail.slice(0, 800)}`);
}

/**
 * Upload one file, and make sure the bucket has all of it.
 *
 * `bySize` is for the parts: they are the expensive uploads, they are
 * immutable for a revision, and a bucket that has an object of exactly that
 * size has that object.
 *
 * It is **not** for the index or the manifest, and that distinction is the
 * bug this function had. Both were skipped when the size matched — and a
 * rebuild that corrects a manifest without changing its *length*, which is
 * what happened when the index's byte count lost a line's worth of blank
 * lines but kept its number of digits, left the bucket announcing an index
 * that no longer existed.
 *
 * So the two small derived files are always uploaded and then **read back**,
 * and the bytes have to be the bytes. Trusting a 400-byte manifest to a size
 * comparison is how the announcement stops matching the thing it announces.
 */
async function put(key: string, path: string, bySize: boolean): Promise<void> {
  const expected = statSync(path).size;
  const before = await head(key);
  if (bySize && before?.size === expected) {
    console.log(`  ${key} — already there, ${mb(expected)}`);
    return;
  }
  if (before) console.log(`  ${key} — there, but ${mb(before.size)} not ${mb(expected)}; replacing`);

  console.log(`  ${key} — ${mb(expected)}, uploading`);
  const started = Date.now();
  upload(key, path);
  const took = Math.round((Date.now() - started) / 1000);

  if (!bySize) {
    const published = await bytesOf(key);
    const local = new Uint8Array(readFileSync(path));
    const same =
      published.length === local.length && published.every((byte, at) => byte === local[at]);
    if (!same) {
      throw new Error(
        `the upload of ${key} did not take: the bucket has ${published.length} bytes and the ` +
          `file has ${local.length}, and they are not the same bytes. Nothing reads a ` +
          `half-published snapshot, so the manifest is not published either.`,
      );
    }
    console.log(`  ${key} — up in ${took}s, read back the same`);
    return;
  }

  const after = await head(key);
  if (!after || after.size !== expected) {
    throw new Error(
      `the upload of ${key} did not take: the bucket has ` +
        `${after ? mb(after.size) : 'nothing'} and the file is ${mb(expected)}. ` +
        `Nothing reads a half-published snapshot, so the manifest is not published either.`,
    );
  }
  console.log(`  ${key} — up in ${took}s`);
}

async function main(): Promise<void> {
  const manifestPath = join(dir, `${commit}.manifest.json`);
  if (!existsSync(manifestPath)) {
    throw new Error(`there is no ${manifestPath} — build the snapshot first`);
  }
  const manifest = parseManifest(readFileSync(manifestPath, 'utf8'), manifestPath);

  // The rows first, then the index, then the manifest — the manifest is what
  // announces the snapshot, so it goes last.
  for (const part of manifest.rows.parts) await put(part.key, join(dir, part.key), true);
  await put(manifest.index.key, join(dir, manifest.index.key), false);
  await put(`${commit}.manifest.json`, manifestPath, false);

  // The vectors, when they have been exported. Their *parts* are written
  // straight to the bucket by the export Worker — a 853 MB file is not
  // something a script should be moving twice — so what is left to publish is
  // the manifest that says what they are, and what is left to check is that
  // the parts are all there at the sizes it claims.
  if (flag('--vectors')) {
    const vectorsPath = join(dir, vectorsManifestKey(commit));
    if (!existsSync(vectorsPath)) {
      throw new Error(
        `--vectors was asked for and there is no ${vectorsPath} — ` +
          `run \`bun scripts/export-vectors.ts --revision ${commit.slice(0, 9)}\` first`,
      );
    }
    const vectors = parseVectorsManifest(readFileSync(vectorsPath, 'utf8'), vectorsPath);
    const inBucket = await listing(`${commit}.vectors.`);
    const wrong = vectors.parts.filter((part) => inBucket.get(part.key) !== part.bytes);
    if (wrong.length > 0) {
      throw new Error(
        `${wrong.length} of ${vectors.parts.length} vectors part(s) are not in the bucket at ` +
          `the size the manifest claims — the export did not finish. First: ${wrong[0]!.key}`,
      );
    }
    console.log(
      `  ${vectors.parts.length} vectors part(s) already in the bucket, ${mb(vectors.bytes)} total`,
    );
    await put(vectorsManifestKey(commit), vectorsPath, false);
  }

  console.log(
    `\n${commit.slice(0, 9)} is published: ${manifest.rows.count} provision(s) in ` +
      `${manifest.rows.parts.length} part(s), ${mb(manifest.rows.bytes)} of rows, ` +
      `${mb(manifest.index.bytes)} of index`,
  );
}

await main();
