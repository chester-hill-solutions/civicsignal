#!/usr/bin/env bun
/**
 * Measure what a corpus commit actually costs to ingest.
 *
 * The corpus repo changes every three to eight days, and a commit rewrites a
 * handful of instruments — the amending regulation that was just made, and every
 * instrument it amends, re-consolidated.
 *
 * This asks the question the continuous pipeline is designed around: **how many
 * provisions change in a typical commit?** The answer sets the embedding cost of
 * an incremental run, and it decides whether the pipeline re-embeds a handful of
 * provisions or a whole Act.
 *
 *   bun scripts/measure-corpus-change.ts [commit]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStatuteXml, buildRows } from '../src/ingest/statutes';

const CORPUS_DIR = join(process.env.HOME ?? '.', '.cache', 'civicsignal', 'laws-lois-xml');

function git(args: string[]): string {
  return execFileSync('git', ['-C', CORPUS_DIR, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function gitFile(commit: string, path: string): string | null {
  try {
    return execFileSync('git', ['-C', CORPUS_DIR, 'show', `${commit}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** The rows of one instrument file, keyed by row id. */
function rowsOf(xml: string, path: string): Map<string, string> {
  const stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.xml$/, '');
  const kind = path.includes('/regulations/') ? 'regulations' : 'acts';
  const parsed = parseStatuteXml(xml, { citation: kind === 'regulations' ? stem : undefined });
  if (!parsed) return new Map();
  const rows = buildRows(parsed, { kind, language: 'en' });
  return new Map(rows.map((r) => [r.id, r.text]));
}

const commit = process.argv[2] ?? 'HEAD';
const files = git(['show', '--name-only', '--format=', commit])
  .split('\n')
  .filter((f) => f.endsWith('.xml') && (f.startsWith('eng/acts/') || f.startsWith('eng/regulations/')));

console.log(`commit ${commit.slice(0, 9)} — ${files.length} English instrument file(s) changed`);

let added = 0;
let changed = 0;
let removed = 0;
let unchanged = 0;
let instrumentsTouched = 0;
const biggest: { instrument: string; changed: number }[] = [];

for (const file of files) {
  const next = gitFile(commit, file);
  const previous = gitFile(`${commit}~1`, file);
  if (next === null) continue;

  const after = rowsOf(next, file);
  if (previous === null) {
    // A new instrument: every one of its provisions is new.
    added += after.size;
    instrumentsTouched++;
    biggest.push({ instrument: file, changed: after.size });
    continue;
  }
  const before = rowsOf(previous, file);

  let fileChanged = 0;
  for (const [id, text] of after) {
    const old = before.get(id);
    if (old === undefined) {
      added++;
      fileChanged++;
    } else if (old !== text) {
      changed++;
      fileChanged++;
    } else {
      unchanged++;
    }
  }
  for (const id of before.keys()) {
    if (!after.has(id)) {
      removed++;
      fileChanged++;
    }
  }
  if (fileChanged > 0) {
    instrumentsTouched++;
    biggest.push({ instrument: file, changed: fileChanged });
  }
}

const touched = added + changed + removed;
console.log(`  instruments whose provisions actually changed: ${instrumentsTouched}`);
console.log(`  provisions added:    ${added.toLocaleString()}`);
console.log(`  provisions changed:  ${changed.toLocaleString()}`);
console.log(`  provisions removed:  ${removed.toLocaleString()}`);
console.log(`  provisions unchanged: ${unchanged.toLocaleString()}`);
console.log(`  -> ${touched.toLocaleString()} of ${(touched + unchanged).toLocaleString()} provisions (${((100 * touched) / (touched + unchanged)).toFixed(2)}%)`);
console.log(`  -> re-embedding cost at \$0.36 per 138,750 provisions: \$${((touched / 138750) * 0.36).toFixed(4)}`);

biggest.sort((a, b) => b.changed - a.changed);
console.log('  the most-changed instruments:');
for (const entry of biggest.slice(0, 6)) {
  console.log(`    ${String(entry.changed).padStart(6)}  ${entry.instrument}`);
}

void existsSync;
void readFileSync;
