#!/usr/bin/env bun
/**
 * The exact vectors check — do the index's bytes match the export's?
 *
 * This was the blocked thread. Comparing what the index holds with a local file
 * looked like it needed a Worker endpoint with the Vectorize binding, because a
 * `Range` header on the REST object read comes back 403, so a whole 29 MB part
 * had to be fetched for each sample.
 *
 * It does not. `get_by_ids` with `returnValues` **returns the stored vector**, so
 * the comparison is a read and there is no cosine in between: the check is
 * whether the stored values equal the exported ones.
 *
 * The positions are chosen the way `check-vectors.ts` chooses them, and for the
 * same reason: the first and the last, **every part boundary** — where an
 * off-by-one in the part arithmetic lands — and evenly spaced samples in between.
 * A file shifted by one position passes a single sample and fails these.
 *
 *     bun scripts/check-stored-vectors.ts [--sample 200]
 */
import { readFileSync } from 'node:fs';
import { token } from './lib/cloudflare-auth';
import { parseVectorsManifest, vectorsManifestKey } from '../src/ingest/snapshot-format';
import { loadVectorStore } from '../src/eval/retrieval';

const args = process.argv.slice(2);
const arg = (flag: string, fallback: string): string => {
  const at = args.indexOf(flag);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'ad5ec479b9a421faa2ed06c3d1c2b23a';
const INDEX = arg('--index', 'civicsignal-statutes-gemma');
const REVISION = arg('--revision', '0507465393c224c0491fc8c17c88340217acc656');
const sample = Number(arg('--sample', '200'));
const dir = arg('--dir', 'dist/snapshot');

const indexIds: string[] = [];
for (const line of readFileSync(`${dir}/${REVISION}.index.jsonl`, 'utf8').split('\n')) {
  if (line.trim()) indexIds.push((JSON.parse(line) as { id: string }).id);
}
console.log('loading the exported store…');
const exported = loadVectorStore(`${dir}/${REVISION}.store.emb`);

const manifest = parseVectorsManifest(
  readFileSync(`${dir}/${vectorsManifestKey(REVISION)}`, 'utf8'),
  vectorsManifestKey(REVISION),
);
if (manifest.count !== indexIds.length) {
  throw new Error(
    `the vectors manifest holds ${manifest.count} vector(s) and the index names ` +
      `${indexIds.length} provision(s) — they are not the same file`,
  );
}

/** The first, the last, every part boundary, and an even spread between. */
const positions = new Set<number>([0, indexIds.length - 1]);
for (const part of manifest.parts) {
  positions.add(part.from);
  if (part.from > 0) positions.add(part.from - 1);
}
const step = Math.max(1, Math.floor(indexIds.length / sample));
for (let at = 0; at < indexIds.length; at += step) positions.add(at);
const chosen = [...positions].sort((a, b) => a - b);
console.log(
  `${indexIds.length} provision(s) in ${manifest.parts.length} part(s); ` +
    `${chosen.length} position(s) of ${sample} requested\n`,
);

/** The stored vectors, twenty ids to a call — the limit the binding documents. */
async function storedFor(ids: string[]): Promise<Map<string, number[]>> {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/vectorize/v2/indexes/${INDEX}/get_by_ids`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ids, returnValues: true }),
  });
  const body = (await response.json()) as {
    success?: boolean;
    result?: { id: string; values?: number[] }[];
    errors?: unknown;
  };
  if (!response.ok || body.success === false) {
    throw new Error(`the index refused: ${response.status} ${JSON.stringify(body.errors).slice(0, 200)}`);
  }
  const out = new Map<string, number[]>();
  for (const entry of body.result ?? []) {
    if (Array.isArray(entry.values)) out.set(entry.id, entry.values);
  }
  return out;
}

let compared = 0;
let exact = 0;
let worst = 1;
let worstAt = '';
let largest = 0;
let notEmbedded = 0;
const missing: string[] = [];

for (let at = 0; at < chosen.length; at += 20) {
  const chunk = chosen.slice(at, at + 20);
  const stored = await storedFor(chunk.map((position) => indexIds[position]!));
  for (const position of chunk) {
    const id = indexIds[position]!;
    const values = stored.get(id);
    if (!values || values.length !== exported.dims) {
      missing.push(id);
      continue;
    }
    compared++;
    let same = true;
    let allZero = true;
    for (let d = 0; d < exported.dims; d++) {
      const mine = exported.vectors[position * exported.dims + d]!;
      if (mine !== 0) allZero = false;
      const diff = Math.abs(values[d]! - mine);
      if (diff > largest) largest = diff;
      // The export is float32. The index returns the same value widened, so the
      // comparison is against float32 rounding and not against a tolerance.
      if (Math.fround(values[d]!) !== mine) same = false;
    }
    if (allZero) notEmbedded++;
    if (same) {
      exact++;
    } else if (worstAt === '') {
      // A mismatch that is not a rounding difference: measure how far it is.
      let dot = 0;
      let an = 0;
      let bn = 0;
      for (let d = 0; d < exported.dims; d++) {
        const mine = exported.vectors[position * exported.dims + d]!;
        dot += values[d]! * mine;
        an += values[d]! * values[d]!;
        bn += mine * mine;
      }
      worst = dot / (Math.sqrt(an) * Math.sqrt(bn) || 1);
      worstAt = `${id} (position ${position})`;
    }
  }
  process.stdout.write(`\r  ${Math.min(at + 20, chosen.length)}/${chosen.length} fetched`);
}
process.stdout.write('\n\n');

console.log(`${compared} vector(s) compared against the export`);
console.log(`  identical to float32:         ${exact} of ${compared}`);
console.log(`  the largest value difference: ${largest.toExponential(3)} (one float32 rounding step)`);
console.log(
  `  absent from the index:        ${missing.length}` +
    (missing.length ? ` — ${missing.slice(0, 3).join(', ')}…` : ''),
);
console.log(
  `  the manifest says ${manifest.notEmbedded} of ${manifest.count} row(s) were never embedded` +
    ` (${((manifest.notEmbedded / manifest.count) * 100).toFixed(1)}%)`,
);
if (exact !== compared) {
  console.log(`  the first that differs:       ${worstAt}, cosine ${worst.toFixed(6)}`);
}
console.log(
  exact === compared && compared > 0
    ? '\nthe export is a faithful copy of the index at every sampled position, boundaries included'
    : '\nthe export is NOT a faithful copy — do not use it as a positional reference',
);
