#!/usr/bin/env bun
/**
 * Export the index's vectors into the snapshot.
 *
 * The vectors are the one part of the corpus that cannot be re-derived by
 * copying — they need the model, and 254,671 embeddings is about four hours
 * of GPU. So a snapshot that does not carry them leaves a rebuild costing
 * four hours, and a snapshot that carries them makes it a file copy.
 *
 * The vectors come **out of Vectorize**, not out of the model: the index
 * already holds them, in the space the product serves from, and exporting is
 * exact — the index stores float32, and float32 → JSON → float64 → float32
 * loses nothing.
 *
 * The file is **fixed width and in the snapshot's order**: vector *i* belongs
 * to the *i*-th id in the snapshot's index. So a row's vector is at
 * `position × 768 × 4` bytes, and no second id list is needed.
 *
 *     bun scripts/export-vectors.ts --revision <sha> --index dist/snapshot/<sha>.index.jsonl
 */
import { closeSync, openSync, readFileSync, statSync, truncateSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fetchWithAuth } from './lib/cloudflare-auth';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'ad5ec479b9a421faa2ed06c3d1c2b23a';
const INDEX_NAME = process.env.VECTORIZE_INDEX ?? 'civicsignal-statutes-gemma';
const DIMENSIONS = Number(process.env.VECTORIZE_DIMENSIONS ?? 768);

const args = process.argv.slice(2);
function arg(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const revision = arg('--revision');
const indexPath = arg('--index');
const out = arg('--out') ?? join('dist', 'snapshot');
if (!revision || !indexPath) {
  console.error('both --revision and --index are needed');
  process.exit(1);
}

/** The snapshot's ids, in order. */
function indexIds(): string[] {
  const ids: string[] = [];
  for (const line of readFileSync(indexPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    ids.push((JSON.parse(line) as { id: string }).id);
  }
  return ids;
}

async function main(): Promise<void> {
  const ids = indexIds();
  const position = new Map<string, number>();
  ids.forEach((id, index) => position.set(id, index));

  const path = join(out, `${revision}.vectors.f32`);
  const fd = openSync(path, 'w+');
  // Pre-allocated: the rows that have no vector — the placeholders, which
  // are written but not embedded — are left as zeroes, and the reader knows
  // to skip them because it knows the row's status.
  const bytes = ids.length * DIMENSIONS * 4;
  truncateSync(path, bytes);
  console.log(`${ids.length} row(s), ${(bytes / 1048576).toFixed(1)} MB of vectors`);

  let written = 0;
  let unknown = 0;
  let seen = 0;
  let cursor: string | undefined;
  do {
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/list?count=1000` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const response = await fetchWithAuth(url, { method: 'GET' });
    if (!response.ok) {
      throw new Error(
        `the index refused to list: ${response.status} ${(await response.text()).slice(0, 200)}`,
      );
    }
    const body = (await response.json()) as {
      result?: {
        vectors?: { id: string; values?: number[] }[];
        nextCursor?: string;
        totalCount?: number;
      };
    };
    const vectors = body.result?.vectors ?? [];
    for (const vector of vectors) {
      seen++;
      const at = position.get(vector.id);
      if (at === undefined) {
        // In the index but not in the snapshot: a provision the corpus no
        // longer holds. Worth saying out loud rather than dropping.
        unknown++;
        continue;
      }
      if (!vector.values || vector.values.length !== DIMENSIONS) {
        // **The REST list endpoint does not return the values.**
        //
        // It returns ids, a cursor and a total count, and no combination of
        // `include_values`, `return_values`, `include=values` or
        // `returnValues` makes it return the vectors themselves. The
        // *binding* — `env.VECTORIZE.list({ returnValues: true })` — does,
        // so the export has to run inside a Worker that has the binding, and
        // write the file to R2.
        //
        // Failing here is deliberate. A file of zeroes would look like a
        // successful export and would destroy the index it was meant to
        // reproduce.
        throw new Error(
          `the index returned ${vector.values?.length ?? 0} dimensions for ${vector.id}, expected ${DIMENSIONS}. ` +
            `The REST list endpoint returns ids only — the export has to run in a Worker with the Vectorize binding.`,
        );
      }
      const bytesOut = Buffer.from(new Float32Array(vector.values).buffer);
      writeSync(fd, bytesOut, 0, bytesOut.length, at * DIMENSIONS * 4);
      written++;
    }
    cursor = body.result?.nextCursor;
    if (written % 25_000 < 1000) console.log(`  ${written} vector(s) written`);
  } while (cursor);
  closeSync(fd);

  console.log(`${written} vector(s) written to ${path}`);
  console.log(`  ${seen} in the index, ${unknown} not in the snapshot`);
  console.log(`  ${ids.length - written} row(s) have no vector — the placeholders, which are not embedded`);
  console.log(`  ${(statSync(path).size / 1048576).toFixed(1)} MB`);
}

await main();
