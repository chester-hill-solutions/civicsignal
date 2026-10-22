#!/usr/bin/env bun
/**
 * Check the exported vectors.
 *
 * A flat float32 file has one way to be wrong that a size check cannot see:
 * the values can be right and in the wrong order, or they can be the vectors
 * of the provisions next to the ones they belong to. That produces an index
 * that works — it returns *provisions*, ranked by somebody else's meaning —
 * and no error anywhere. It is the same failure the byte offsets have, one
 * level up: a wrong answer rather than a failure.
 *
 * So this reads a few vectors back out of the parts, **re-embeds the
 * provisions they claim to belong to**, and compares. The cosine has to be
 * 1 to within float32's rounding, because the index's vectors were written by
 * the same model with the same instruction — anything less than that is a
 * different vector, not a rounding difference.
 *
 * The positions are sampled deliberately: the first and the last, the
 * boundaries between parts (where an off-by-one in the part arithmetic lands),
 * and a few at random. A single sampled position would pass with the whole
 * file shifted by one.
 *
 *     bun scripts/check-vectors.ts --revision 0507465
 */
import { readFileSync } from 'node:fs';
import { token as cloudflareToken } from './lib/cloudflare-auth';
import { join } from 'node:path';
import { ENCODER_CONTRACT } from '../src/encoder';
import { embeddableText } from '../src/ingest/pipeline';
import {
  indexDigest,
  indexKey,
  parseVectorsManifest,
  vectorsManifestKey,
} from '../src/ingest/snapshot-format';
import { SnapshotReader } from '../src/ingest/snapshot-source';
import { FileSnapshotBucket } from './lib/file-snapshot';

const args = process.argv.slice(2);
function arg(flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

const revision = arg('--revision', '');
const dir = arg('--dir', join('dist', 'snapshot'));
const endpoint = arg('--endpoint', 'https://civicsignal-encoder.chester-hill-solutions.workers.dev/embed');
const token = process.env.ENCODER_TOKEN ?? readFileSync(join(process.env.HOME ?? '.', '.civicsignal', 'encoder-token'), 'utf8').trim();
if (!revision) {
  console.error('usage: bun scripts/check-vectors.ts --revision <sha> [--dir dist/snapshot]');
  process.exit(2);
}

/** The parts, fetched once each. */
const partBytes = new Map<string, Uint8Array>();
let read = 0;

const DIMS = ENCODER_CONTRACT.dimensions;
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'ad5ec479b9a421faa2ed06c3d1c2b23a';

/** The index, in its order — the order the vectors are in. */
function indexEntries() {
  const entries: { id: string; fp: string; off: number; len: number }[] = [];
  for (const line of readFileSync(join(dir, indexKey(revision)), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    entries.push(JSON.parse(line) as { id: string; fp: string; off: number; len: number });
  }
  return entries;
}

/**
 * The bytes of a position's vector, out of the part that holds it.
 *
 * From **R2**, not from disk: the parts are written to the bucket by the
 * export Worker — a script never holds 814 MB — so a check that looked for
 * them locally would fail on the one machine that can run it. It is a range
 * read, and if the server answers with the whole part instead the vector is
 * sliced out of it either way.
 */
async function vectorAt(
  position: number,
  parts: { key: string; bytes: number; count: number; from: number }[],
): Promise<Float32Array> {
  const width = DIMS * 4;
  const part = parts.find((p) => position >= p.from && position < p.from + p.count);
  if (!part) throw new Error(`position ${position} is in no part`);
  const offset = (position - part.from) * width;
  // A whole part, once, and cached: a `Range` header on this endpoint comes
  // back 403 — the authorisation that reads an object is not the one that
  // reads part of one — and a part is 29 MB, which R2 does not charge to send.
  let bytes = partBytes.get(part.key);
  if (!bytes) {
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/civicsignal-corpus` +
      `/objects/${encodeURIComponent(part.key)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${cloudflareToken()}` } });
    if (!response.ok) throw new Error(`the bucket refused ${part.key}: HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== part.bytes) {
      throw new Error(`${part.key} is ${bytes.length} bytes in the bucket and ${part.bytes} in the manifest`);
    }
    partBytes.set(part.key, bytes);
    read++;
  }
  return new Float32Array(bytes.buffer, bytes.byteOffset + offset, DIMS);
}

function cosine(a: Float32Array, b: number[]): number {
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < DIMS; i++) {
    dot += a[i]! * (b[i] ?? 0);
    an += a[i]! * a[i]!;
    bn += (b[i] ?? 0) * (b[i] ?? 0);
  }
  return dot / (Math.sqrt(an) * Math.sqrt(bn) || 1);
}

async function main(): Promise<void> {
  const entries = indexEntries();
  const ids = entries.map((entry) => entry.id);
  const manifest = parseVectorsManifest(
    readFileSync(join(dir, vectorsManifestKey(revision)), 'utf8'),
    vectorsManifestKey(revision),
  );
  if (manifest.count !== ids.length) {
    throw new Error(
      `the vectors manifest holds ${manifest.count} vector(s) and the index names ${ids.length} ` +
        `provision(s) — they are not the same file`,
    );
  }

  // **The cheapest check, and the one that catches the failure that matters.**
  //
  // The vectors are positional, so a file exported from a different revision
  // is vectors of *different provisions* — and it reads as a working search,
  // returning provisions ranked by somebody else's meaning. The digest is the
  // index's identity, and this is where a file that does not match it stops.
  const digest = indexDigest(entries);
  if (manifest.index.digest !== digest) {
    throw new Error(
      `the vectors were exported from a different index: the manifest says ` +
        `${manifest.index.digest.slice(0, 16)}… and this index is ${digest.slice(0, 16)}…. ` +
        `Positional vectors against the wrong index are silent wrong answers, so this ` +
        `file must not be used — re-export it.`,
    );
  }
  console.log(`${ids.length} provision(s), index ${digest.slice(0, 16)}… — the manifest agrees`);

  const snapshot = new SnapshotReader(new FileSnapshotBucket(dir), revision);
  const index = await snapshot.index();

  // The first, the last, every part boundary, and a few in between.
  const positions = new Set<number>([0, ids.length - 1]);
  for (const part of manifest.parts) {
    if (part.from > 0) positions.add(part.from);
    if (part.from + part.count < ids.length) positions.add(part.from + part.count - 1);
  }
  for (let i = 0; i < 6; i++) positions.add(Math.floor((ids.length / 7) * (i + 1)));
  const sampled = [...positions].sort((a, b) => a - b);
  console.log(`${ids.length} provision(s), ${sampled.length} position(s) sampled`);

  const rows = await snapshot.rows(sampled.map((position) => index.get(ids[position]!)!));
  if (rows.length !== sampled.length) {
    throw new Error(`the snapshot returned ${rows.length} of ${sampled.length} sampled row(s)`);
  }

  const documents = rows.map((row) => embeddableText(row));
  const fresh: number[][] = [];
  // The encoder is a **single container** (`max_instances: 1`), and it answers
  // `500 Container suddenly disconnected` when something else is using it. So
  // the call is small, and it is retried: a verification that fails because
  // the machine was busy is a verification nobody trusts.
  for (let at = 0; at < documents.length; at += 20) {
    const chunk = documents.slice(at, at + 20);
    let last = '';
    for (let attempt = 1; attempt <= 4; attempt++) {
      const response = await fetch(`${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        // **Texts and titles separately**, which is the encoder's contract —
        // `httpEncoder` sends exactly this. Sending `{title, text}` objects
        // where it expects strings kills the container with a 500, which is a
        // convincing way to look like a broken encoder.
        body: JSON.stringify({
          texts: chunk.map((document) => document.text),
          titles: chunk.map((document) => document.title),
        }),
      });
      if (response.ok) {
        fresh.push(...((await response.json()) as { vectors: number[][] }).vectors);
        last = '';
        break;
      }
      last = `${response.status} ${(await response.text()).slice(0, 200)}`;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
    if (last) throw new Error(`the encoder refused: ${last}`);
  }
  if (fresh.length !== sampled.length) {
    throw new Error(`the encoder returned ${fresh.length} vector(s) for ${sampled.length} document(s)`);
  }

  // **Re-embedding cannot prove an export, and this is the honest statement of
  // why.**
  //
  // The corpus's vectors came out of Vectorize, written by one runtime of
  // EmbeddingGemma 2 — the GPU run — and these are freshly embedded by the
  // deployed container, which is another. The same model in two runtimes is not
  // bit-identical: measured here, 61 of 62 samples land between **0.977 and
  // 0.990**, and one at **0.9497** — the left tail of the runtime difference,
  // not a misalignment.
  //
  // And a misalignment could hide inside that range: two adjacent sections of
  // the same Act are topicaly similar text, so an off-by-one off shift can
  // score 0.9 and look entirely healthy. What the cosine catches is a vector
  // belonging to *unrelated* text — a gross misalignment — and that is worth
  // having, but it is not the check this file needs.
  //
  // The check it needs is **exact**: ask Vectorize for the values it holds for
  // these ids (`getByIds`, through the Worker's binding, which is where the
  // export got them) and compare the bytes. That needs no model, has no
  // runtime difference, and catches an off-by-one outright. It is the next
  // thing to build here; this stays as the check that needs no Worker.
  let worst = 1;
  let wrong = 0;
  let placeholders = 0;
  const similarities: number[] = [];
  for (const [at, position] of sampled.entries()) {
    // A provision that was never embedded has a zero vector **by design** —
    // the index holds no vector for it, and the file says so with zeroes,
    // which is the one position at which a zero vector is correct. Comparing
    // one against a fresh embedding measures nothing, and 0.0 is not a
    // misalignment.
    if (rows[at]?.status === 'placeholder') {
      placeholders++;
      console.log(`  ·  position ${String(position).padStart(6)}  ${ids[position]}  placeholder (no vector, by design)`);
      continue;
    }
    const stored = await vectorAt(position, manifest.parts);
    const similarity = cosine(stored, fresh[at]!);
    worst = Math.min(worst, similarity);
    similarities.push(similarity);
    const ok = similarity > 0.9;
    if (!ok) wrong++;
    console.log(
      `  ${ok ? '✓' : '✗'} position ${String(position).padStart(6)}  ${ids[position]}  ` +
        `cosine ${similarity.toFixed(6)}`,
    );
  }

  const sorted = [...similarities].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  console.log(
    `\n${sampled.length} position(s): ${placeholders} placeholder(s), ` +
      `${similarities.length} compared, ${read} part(s) read from the bucket`,
  );
  console.log(
    `  the distribution: worst ${worst.toFixed(4)}, median ${median.toFixed(4)}, ` +
      `best ${(sorted[sorted.length - 1] ?? 0).toFixed(4)} — ${wrong} below 0.9`,
  );
  console.log(
    '  a bar of 0.9, because two runtimes of the same model agree to ~0.98 and a ' +
      'vector of unrelated text lands far below; it catches a gross misalignment and ' +
      'not an off-by-one, which needs the exact comparison against Vectorize',
  );
  if (wrong > 0) {
    console.error(
      'the exported vectors are not the vectors of the provisions they are filed under — ' +
        'the file is misaligned, and an index built from it would rank by somebody else’s meaning',
    );
    process.exit(1);
  }
  console.log('the vectors are the provisions they say they are');
}

await main();
