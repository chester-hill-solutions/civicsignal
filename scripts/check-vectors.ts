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

const DIMS = ENCODER_CONTRACT.dimensions;

/** The index, in its order — the order the vectors are in. */
function indexEntries() {
  const entries: { id: string; fp: string; off: number; len: number }[] = [];
  for (const line of readFileSync(join(dir, indexKey(revision)), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    entries.push(JSON.parse(line) as { id: string; fp: string; off: number; len: number });
  }
  return entries;
}

/** The bytes of a position's vector, out of the part that holds it. */
function vectorAt(position: number, parts: { key: string; bytes: number; count: number; from: number }[]): Float32Array {
  const width = DIMS * 4;
  const part = parts.find((p) => position >= p.from && position < p.from + p.count);
  if (!part) throw new Error(`position ${position} is in no part`);
  const offset = (position - part.from) * width;
  const buffer = readFileSync(join(dir, part.key));
  return new Float32Array(buffer.buffer, buffer.byteOffset + offset, DIMS);
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
        body: JSON.stringify({ texts: chunk, model: ENCODER_CONTRACT.model }),
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

  let worst = 1;
  let wrong = 0;
  sampled.forEach((position, at) => {
    const stored = vectorAt(position, manifest.parts);
    const similarity = cosine(stored, fresh[at]!);
    worst = Math.min(worst, similarity);
    const ok = similarity > 0.999;
    if (!ok) wrong++;
    console.log(
      `  ${ok ? '✓' : '✗'} position ${String(position).padStart(6)}  ${ids[position]}  ` +
        `cosine ${similarity.toFixed(6)}`,
    );
  });

  console.log(`\nworst cosine ${worst.toFixed(6)} across ${sampled.length} position(s), ${wrong} wrong`);
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
