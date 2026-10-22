#!/usr/bin/env bun
/**
 * What vector does the index hold, and which run does it match?
 *
 * Whether the index needs rebuilding turns on this, and it is a **read**:
 * `get_by_ids` hands back the stored vector itself. Compare that with every run
 * of the encoder on disk, and the answer becomes a number rather than an
 * inference.
 *
 * The index was created 2026-10-20 20:53 and never modified. `gemmagpu.emb` is
 * stamped 21:51, an hour **after** that, so it cannot be what the index holds.
 * `gemma.emb` is stamped 17:21 and `gemma300.emb` 17:14, so either could be.
 *
 *     bun scripts/diagnose-stored-vectors.ts [--ids a,b]
 */
import { readFileSync } from 'node:fs';
import { token } from './lib/cloudflare-auth';
import { loadVectorStore, type VectorStore } from '../src/eval/retrieval';

const args = process.argv.slice(2);
const arg = (flag: string, fallback: string): string => {
  const at = args.indexOf(flag);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'ad5ec479b9a421faa2ed06c3d1c2b23a';
const INDEX = arg('--index', 'civicsignal-statutes-gemma');
const REVISION = arg('--revision', '0507465393c224c0491fc8c17c88340217acc656');
const wanted = arg('--ids', 'acts-en-121704,acts-en-88695,acts-en-203599').split(',');

/** The index ids, in the order the exported vectors are in. */
const indexIds: string[] = [];
for (const line of readFileSync(`dist/snapshot/${REVISION}.index.jsonl`, 'utf8').split('\n')) {
  if (line.trim()) indexIds.push((JSON.parse(line) as { id: string }).id);
}
console.log('loading the exported store…');
const exported = loadVectorStore(`dist/snapshot/${REVISION}.store.emb`);

/** The three evaluation runs, each with its own row ids in its own order. */
const runs: { name: string; store: VectorStore; idAt: Map<string, number> }[] = [];
for (const run of [
  { name: 'gemma', path: 'dist/eval-corpus.gemma.emb', rows: 'dist/eval-corpus.gemma.rows.json' },
  { name: 'gemma300', path: 'dist/eval-corpus.gemma300.emb', rows: 'dist/eval-corpus.gemma300.rows.json' },
  { name: 'gemmagpu', path: 'dist/eval-corpus.gemmagpu.emb', rows: 'dist/eval-corpus.gemmagpu.rows.json' },
]) {
  const ids = JSON.parse(readFileSync(run.rows, 'utf8')) as string[];
  runs.push({
    name: run.name,
    store: loadVectorStore(run.path),
    idAt: new Map(ids.map((id, at) => [id, at])),
  });
}

/** The evaluation row for a provision, so a vector is found by provision. */
const evalRowFor = new Map<string, string>();
for (const line of readFileSync('dist/eval-corpus.jsonl', 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const row = JSON.parse(line) as { id: string; act: string; section: string };
  evalRowFor.set(`${row.act}\u0000${row.section}`, row.id);
}

/** Which provision each index id names, from the citation lookups. */
const provision: Record<string, { act: string; section: string }> = {
  'acts-en-121704': { act: 'Criminal Code', section: '322' },
  'acts-en-88695': { act: 'Competition Act', section: '36' },
  'acts-en-203599': { act: 'Canada Elections Act', section: '8' },
};

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let d = 0; d < Math.min(a.length, b.length); d++) {
    dot += a[d]! * b[d]!;
    an += a[d]! * a[d]!;
    bn += b[d]! * b[d]!;
  }
  return dot / (Math.sqrt(an) * Math.sqrt(bn) || 1);
}

function vectorOf(store: VectorStore, at: number): number[] {
  const out: number[] = [];
  for (let d = 0; d < store.dims; d++) out.push(store.vectors[at * store.dims + d]!);
  return out;
}

async function storedVectors(wantedIds: string[]): Promise<{ id: string; values: number[] }[]> {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/vectorize/v2/indexes/${INDEX}/get_by_ids`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ids: wantedIds, returnValues: true, returnMetadata: 'all' }),
  });
  const body = (await response.json()) as {
    success?: boolean;
    result?: { id: string; values?: number[] }[];
    errors?: unknown;
  };
  if (!response.ok || body.success === false) {
    throw new Error(
      `the index refused: ${response.status} ${JSON.stringify(body.errors).slice(0, 200)}`,
    );
  }
  return (body.result ?? [])
    .filter((entry) => Array.isArray(entry.values))
    .map((entry) => ({ id: entry.id, values: entry.values! }));
}

const stored = await storedVectors(wanted);
console.log(`${stored.length} stored vector(s) for ${wanted.length} id(s)\n`);

for (const entry of stored) {
  const position = indexIds.indexOf(entry.id);
  const norm = Math.sqrt(entry.values.reduce((sum, value) => sum + value * value, 0));
  console.log(entry.id);
  console.log(`  stored:            ${entry.values.length} dim(s), |v| = ${norm.toFixed(6)}`);
  if (position !== -1) {
    console.log(`  the export agrees: ${cosine(entry.values, vectorOf(exported, position)).toFixed(6)}`);
  }

  const target = provision[entry.id];
  if (target) {
    const evalId = evalRowFor.get(`${target.act}\u0000${target.section}`);
    for (const run of runs) {
      const at = evalId === undefined ? undefined : run.idAt.get(evalId);
      if (at === undefined) continue;
      console.log(
        `  ${run.name.padEnd(10)} agrees: ${cosine(entry.values, vectorOf(run.store, at)).toFixed(6)}`,
      );
    }
  }
  console.log('');
}
