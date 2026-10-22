#!/usr/bin/env bun
/**
 * Export the index's vectors into the snapshot.
 *
 * The vectors are the one part of the corpus that cannot be re-derived by
 * copying — they need the model, and a quarter of a million embeddings is
 * about four hours of GPU. So a snapshot that does not carry them leaves a
 * rebuild costing four hours, and one that carries them makes it a file copy.
 *
 * ## It cannot be a script, so it is a script and a Worker
 *
 * The vectors come **out of Vectorize**, not out of the model: the index
 * already holds them, in the space the product serves from, and exporting is
 * exact — the index stores float32, and float32 → JSON → float64 → float32
 * loses nothing.
 *
 * But the Vectorize **REST** list endpoint returns ids and no values, and no
 * combination of `include_values`, `return_values` or `include=values` changes
 * that. The *binding* returns them, and a binding only exists inside a Worker.
 * So this drives `POST /vectors` on the pipeline Worker, one part at a time,
 * and the Worker packs each part and writes it to R2.
 *
 * ## Why it is in parts, and why it verifies
 *
 * 853 MB cannot be published in one object — that is the same 300 MB ceiling
 * that made the rows parts — so the vectors are parts too, and their manifest
 * says what they are.
 *
 * And a vector that is missing has to be *proved* to belong to a provision
 * that was deliberately not embedded. This used to pre-allocate the whole file
 * and fill it in, which meant a failure half way through left 853 MB of zeroes
 * that looked exactly like a finished export. It was found by reading the file
 * and discovering that every float in it was zero. So now a part is written
 * only when its vectors are all there, and every provision with no vector is
 * checked against the snapshot's own rows.
 *
 *     bun scripts/export-vectors.ts --revision 0507465
 *     bun scripts/export-vectors.ts --revision 0507465 --per-part 10000
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENCODER_CONTRACT } from '../src/encoder';
import {
  indexKey,
  parseManifest,
  vectorsManifestKey,
  vectorsPartKey,
  type VectorsManifest,
} from '../src/ingest/snapshot-format';
import { SnapshotReader, type SnapshotBucket } from '../src/ingest/snapshot-source';
import { FileSnapshotBucket } from './lib/file-snapshot';
import { token } from './lib/cloudflare-auth';

const BUCKET = 'civicsignal-corpus';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'ad5ec479b9a421faa2ed06c3d1c2b23a';
const WORKER = process.env.PIPELINE_URL ?? 'https://civicsignal-pipeline.chester-hill-solutions.workers.dev';
const SECRET = process.env.PIPELINE_SECRET ?? readFileSync(join(process.env.HOME ?? '.', '.civicsignal', 'pipeline-secret'), 'utf8').trim();

const DIMENSIONS = ENCODER_CONTRACT.dimensions;

const args = process.argv.slice(2);
function arg(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const revision = arg('--revision');
const dir = arg('--dir') ?? join('dist', 'snapshot');
const perPart = Number(arg('--per-part') ?? 10_000);
if (!revision) {
  console.error('usage: bun scripts/export-vectors.ts --revision <sha> [--dir dist/snapshot] [--per-part 10000]');
  process.exit(2);
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The snapshot's ids, in the order the index has them. */
function indexIds(): string[] {
  const ids: string[] = [];
  for (const line of readFileSync(join(dir, indexKey(revision!)), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    ids.push((JSON.parse(line) as { id: string }).id);
  }
  return ids;
}

/** The parts as the bucket has them. */
async function bucketSizes(prefix: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  let cursor = '';
  for (;;) {
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects` +
      `?prefix=${encodeURIComponent(prefix)}&per_page=1000` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } });
    const body = (await response.json()) as {
      success: boolean;
      result?: { key: string; size: number }[];
      result_info?: { is_truncated: boolean; cursor: string };
    };
    if (!body.success) throw new Error(`the bucket could not be listed`);
    for (const object of body.result ?? []) sizes.set(object.key, object.size);
    if (!body.result_info?.is_truncated) return sizes;
    cursor = body.result_info.cursor;
  }
}

/** One part, exported by the Worker. */
async function exportPart(
  part: number,
  ids: string[],
): Promise<{ key: string; bytes: number; embedded: number; missing: string[] }> {
  const response = await fetch(`${WORKER}/vectors`, {
    method: 'POST',
    headers: { 'x-pipeline-secret': SECRET, 'content-type': 'application/json' },
    body: JSON.stringify({ commit: revision, part, ids }),
  });
  const body = (await response.json()) as {
    key?: string;
    bytes?: number;
    embedded?: number;
    missing?: string[];
    error?: string;
  };
  if (!response.ok || body.error) {
    throw new Error(`part ${part} failed: ${body.error ?? response.status}`);
  }
  return {
    key: body.key!,
    bytes: body.bytes!,
    embedded: body.embedded!,
    missing: body.missing ?? [],
  };
}

async function main(): Promise<void> {
  const ids = indexIds();
  const expected = ids.length * DIMENSIONS * 4;
  console.log(
    `${ids.length} provision(s), ${DIMENSIONS} dimensions — ${mb(expected)} of vectors in ` +
      `${Math.ceil(ids.length / perPart)} part(s)`,
  );

  // The snapshot's own rows, for the one check that makes zero vectors honest.
  const snapshot: SnapshotReader = new SnapshotReader(
    new FileSnapshotBucket(dir) as unknown as SnapshotBucket,
    revision!,
  );
  const manifest = parseManifest(
    readFileSync(join(dir, `${revision}.manifest.json`), 'utf8'),
    `${revision}.manifest.json`,
  );
  const index = await snapshot.index();

  const parts: VectorsManifest['parts'] = [];
  let embedded = 0;
  const missing: string[] = [];

  for (let from = 0; from < ids.length; from += perPart) {
    const slice = ids.slice(from, from + perPart);
    const part = parts.length;
    const result = await exportPart(part, slice);

    if (result.bytes !== slice.length * DIMENSIONS * 4) {
      throw new Error(
        `part ${part} came back as ${result.bytes} bytes for ${slice.length} vector(s), ` +
          `which should be ${slice.length * DIMENSIONS * 4}`,
      );
    }
    parts.push({ key: result.key, bytes: result.bytes, count: slice.length, from });
    embedded += result.embedded;
    missing.push(...result.missing);

    console.log(
      `  ${result.key} — ${slice.length} vector(s), ${mb(result.bytes)}, ` +
        `${result.missing.length} without a vector`,
    );
  }

  // **The check.** A provision with no vector is a provision that was not
  // embedded, and the only ones that are not embedded are the placeholders.
  // Anything else is a hole in the export that would become a hole in the
  // index, and a hole in the index is a provision that can never be found.
  if (missing.length > 0) {
    const rows = await snapshot.rows(
      missing.map((id) => {
        const entry = index.get(id);
        if (!entry) throw new Error(`${id} has no vector and is not in the snapshot's index`);
        return entry;
      }),
    );
    const wrong = rows.filter((row) => row.status !== 'placeholder');
    if (wrong.length > 0) {
      throw new Error(
        `${wrong.length} of ${missing.length} provision(s) have no vector in the index and are ` +
          `not placeholders — the export would leave them unfindable. First: ` +
          wrong.slice(0, 3).map((row) => `${row.id} (${row.status})`).join(', '),
      );
    }
    console.log(`  ${missing.length} provision(s) have no vector — all of them placeholders`);
  }

  const manifestOut: VectorsManifest = {
    format: 1,
    commit: revision!,
    dims: DIMENSIONS,
    count: ids.length,
    bytes: expected,
    parts,
    embedded,
    notEmbedded: ids.length - embedded,
  };

  // The bucket's own answer, not the Worker's: every part has to be there at
  // the size it says, and the total has to be the file the manifest describes.
  const sizes = await bucketSizes(`${revision}.vectors.`);
  const absent = parts.filter((part) => sizes.get(part.key) !== part.bytes);
  const onDisk = parts.reduce((sum, part) => sum + (sizes.get(part.key) ?? 0), 0);
  if (absent.length > 0 || onDisk !== expected) {
    throw new Error(
      `${absent.length} part(s) are not in the bucket as the export wrote them, and the bucket ` +
        `holds ${mb(onDisk)} against ${mb(expected)}. The export is not published.`,
    );
  }

  const path = join(dir, vectorsManifestKey(revision!));
  writeFileSync(path, `${JSON.stringify(manifestOut, null, 2)}\n`);

  console.log(
    `\n${revision!.slice(0, 9)}: ${ids.length} vector(s), ${mb(onDisk)} in ${parts.length} part(s) — ` +
      `${embedded} embedded, ${ids.length - embedded} not (the placeholders)`,
  );
  console.log(`  ${path}`);
  console.log(
    `  the manifest is not published yet: upload it with ` +
      `\`bun scripts/publish-snapshot.ts --commit ${revision!.slice(0, 9)} --vectors\``,
  );
}

await main();
