#!/usr/bin/env bun
/**
 * Check a snapshot.
 *
 * The snapshot is a new way of reading the corpus, so it needs to be checked
 * against the two things it claims to be equivalent to.
 *
 *   --vs-store          the index's fingerprints against the store's
 *                       `text_hash`, row for row. If these differ, the diff
 *                       is comparing two different corpora and nothing
 *                       downstream means anything.
 *
 *   --diff OLD NEW      the diff between two index files: the changed ids,
 *                       the gone ids and the new ids. This is what the cycle
 *                       will do, and it has to agree with what the cycle
 *                       already did.
 *
 *   --offsets ROWS      that the index's byte offsets point at the rows it
 *                       says they do. The offsets are the part most likely to
 *                       be subtly wrong, and a wrong offset is a wrong
 *                       provision rather than an error.
 *
 *     bun scripts/check-snapshot.ts --vs-store --index dist/snapshot/<sha>.index.jsonl
 *     bun scripts/check-snapshot.ts --diff old.index.jsonl new.index.jsonl
 *     bun scripts/check-snapshot.ts --offsets dist/snapshot/<sha>.rows.jsonl
 */
import { openSync, readFileSync, readSync, closeSync } from 'node:fs';
import { query } from './lib/d1-load';

const CORPUS_ID = 'statutes-canada';
const args = process.argv.slice(2);

function arg(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
function flag(name: string): boolean {
  return args.includes(name);
}

/** One index file, read. */
interface IndexEntry {
  id: string;
  fp: string;
  off: number;
  len: number;
}

function readIndex(path: string): Map<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as IndexEntry;
    entries.set(entry.id, entry);
  }
  return entries;
}

/** The store's fingerprints, row for row. */
async function storeFingerprints(): Promise<Map<string, string>> {
  const fingerprints = new Map<string, string>();
  let after = '';
  for (;;) {
    const rows = await query<{ id: string; text_hash: string }>(
      `SELECT id, text_hash FROM statute_sections
        WHERE corpus_id = ? AND id > ? AND text_hash IS NOT NULL
        ORDER BY id LIMIT 1000`,
      [CORPUS_ID, after],
    );
    if (rows.length === 0) break;
    for (const row of rows) fingerprints.set(row.id, row.text_hash);
    after = rows[rows.length - 1]!.id;
  }
  return fingerprints;
}

async function main(): Promise<void> {
  if (flag('--vs-store')) {
    const path = arg('--index');
    if (!path) throw new Error('--vs-store needs --index');
    const index = readIndex(path);
    const store = await storeFingerprints();
    let same = 0;
    let different = 0;
    const examples: string[] = [];
    for (const [id, entry] of index) {
      const stored = store.get(id);
      if (stored === undefined) {
        different++;
        if (examples.length < 5) examples.push(`${id}: in the snapshot, not in the store`);
      } else if (stored === entry.fp) {
        same++;
      } else {
        different++;
        if (examples.length < 5) examples.push(`${id}: the snapshot and the store disagree`);
      }
    }
    const missing = [...store.keys()].filter((id) => !index.has(id)).length;
    console.log(
      `${index.size} row(s) in the snapshot, ${store.size} in the store: ` +
        `${same} the same, ${different} different, ${missing} only in the store`,
    );
    for (const example of examples) console.log(`  ${example}`);
    if (different === 0 && missing === 0) console.log('  the two are the same corpus');
  }

  if (flag('--diff')) {
    const paths = args.filter((a) => a.endsWith('.index.jsonl'));
    if (paths.length < 2) throw new Error('--diff needs two index files');
    const before = readIndex(paths[0]!);
    const after = readIndex(paths[1]!);
    const changed: string[] = [];
    const gone: string[] = [];
    const came: string[] = [];
    for (const [id, entry] of after) {
      const previous = before.get(id);
      if (!previous) came.push(id);
      else if (previous.fp !== entry.fp) changed.push(id);
    }
    for (const id of before.keys()) if (!after.has(id)) gone.push(id);
    console.log(`${changed.length} changed, ${gone.length} gone, ${came.length} came`);
    for (const id of [...changed, ...gone, ...came].slice(0, 10)) console.log(`  ${id}`);
  }

  if (flag('--offsets')) {
    const rowsPath = arg('--offsets');
    const indexPath = arg('--index');
    if (!rowsPath || !indexPath) throw new Error('--offsets needs --offsets and --index');
    const index = readIndex(indexPath);
    const fd = openSync(rowsPath, 'r');
    // The buffer is sized to the longest row, not to a guess: the corpus's
    // longest provisions are megabytes long, and a check that skips the rows
    // too long for its buffer is a check that skips the ones most likely to
    // be wrong.
    const longest = Math.max(...[...index.values()].map((entry) => entry.len));
    const buffer = Buffer.alloc(longest);
    let checked = 0;
    let wrong = 0;
    const examples: string[] = [];
    for (const [id, entry] of index) {
      const read = readSync(fd, buffer, 0, entry.len, entry.off);
      const line = buffer.subarray(0, read).toString('utf8').trim();
      let row: { id?: string };
      try {
        row = JSON.parse(line) as { id?: string };
      } catch {
        wrong++;
        if (examples.length < 5) examples.push(`${id}: the bytes at ${entry.off} are not JSON`);
        continue;
      }
      if (row.id !== id) {
        wrong++;
        if (examples.length < 5) examples.push(`${id}: the bytes at ${entry.off} are ${row.id}`);
        continue;
      }
      checked++;
    }
    closeSync(fd);
    console.log(`${checked} offset(s) checked, ${wrong} wrong`);
    for (const example of examples) console.log(`  ${example}`);
  }
}

await main();
