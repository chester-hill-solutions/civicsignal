#!/usr/bin/env bun
/**
 * Build a corpus snapshot.
 *
 * A snapshot is the corpus as rows, with a fingerprint per row, in a form that
 * can be read in pieces. Two files per revision:
 *
 *   <commit>.rows.jsonl    the rows, one JSON object per line, sorted by id
 *   <commit>.index.jsonl   id, fingerprint, byte offset and length of each row
 *
 * The **index** is the diff. Two index files, compared, give the changed ids,
 * the gone ids and the new ids — exactly, in about twenty megabytes. The
 * **rows** are read in pieces: the index carries each row's offset and length,
 * so one row is one HTTP range request.
 *
 *     bun scripts/build-snapshot.ts --revision <sha> --out dist/snapshot
 *     bun scripts/build-snapshot.ts --parent <sha> --out dist/snapshot
 *
 * The revision comes from the local clone's git history, because the snapshot
 * is the corpus at a *revision* and the clone knows which one that was.
 *
 * **One parser.** The rows are built by `rowsForFile` — the same function the
 * pipeline uses — because the snapshot and the store have to be comparable. If
 * they were built by different code, the diff between two snapshots would be a
 * diff of parsers rather than a diff of law.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rowsForFile } from '../src/ingest/corpus-rows';
import { fingerprint } from '../src/ingest/reconcile';

const CORPUS_DIR = join(process.env.HOME ?? '.', '.cache', 'civicsignal', 'laws-lois-xml');
const CORPUS_ID = 'statutes-canada';

const args = process.argv.slice(2);
const revision = arg('--revision');
const parent = arg('--parent');
const out = arg('--out') ?? join('dist', 'snapshot');

function arg(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/**
 * The corpus's tree at a revision.
 *
 * `git archive` writes the tree at exactly that revision — the clone is a
 * shallow one, so the parent is not in its history, and a snapshot of a
 * revision has to be that revision's tree and not whatever the working
 * directory happens to hold.
 */
function tree(rev: string): string {
  const root = join(
    process.env.TMPDIR ?? '/tmp',
    `civicsignal-snapshot-${rev.slice(0, 9)}`,
  );
  Bun.spawnSync(['rm', '-rf', root]);
  Bun.spawnSync(['mkdir', '-p', root]);
  const proc = Bun.spawnSync(
    ['git', '-C', CORPUS_DIR, 'archive', '--format=tar', rev, 'eng', 'fra'],
    { stdout: 'pipe', stderr: 'ignore' },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`the clone at ${CORPUS_DIR} could not archive ${rev}`);
  }
  const extract = Bun.spawnSync(['tar', '-x', '-C', root], {
    stdin: new Blob([proc.stdout]),
    stdout: 'ignore',
    stderr: 'ignore',
  });
  if (extract.exitCode !== 0) throw new Error(`the archive of ${rev} could not be unpacked`);
  return root;
}

/** The instrument files, in a stable order. */
function instrumentFiles(root: string): { path: string; content: string }[] {
  const dirs = [
    ['eng/acts', 'acts'],
    ['eng/regulations', 'regulations'],
    ['fra/lois', 'acts'],
    ['fra/reglements', 'regulations'],
  ] as const;
  const out: { path: string; content: string }[] = [];
  for (const [dir] of dirs) {
    const path = join(root, dir);
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.xml')) continue;
      const file = join(path, name);
      out.push({
        path: `${dir}/${name}`,
        content: readFileSync(file, 'utf8'),
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const rev = revision ?? parent;
  if (!rev) {
    console.error('a revision is needed: --revision <sha>');
    process.exit(1);
  }

  const root = tree(rev);
  const files = instrumentFiles(root);
  console.log(`${files.length} instrument file(s) in ${root}`);

  // The rows, keyed by id.
  //
  // A row can appear in more than one file — a schedule's items carry the
  // instrument's rows too — and the id is the corpus's own identifier for a
  // provision, so the last one wins and the count tells us if that happened.
  const rows = new Map<string, unknown>();
  for (const file of files) {
    for (const row of rowsForFile({
      path: file.path,
      content: file.content,
      date: rev.slice(0, 10),
      corpusId: CORPUS_ID,
    })) {
      rows.set(row.id, row);
    }
  }
  console.log(`${rows.size} row(s)`);

  // The rows, sorted by id, and the index that points at them.
  const ids = [...rows.keys()].sort();
  const rowsPath = join(out, `${rev}.rows.jsonl`);
  const indexPath = join(out, `${rev}.index.jsonl`);
  Bun.spawnSync(['mkdir', '-p', out]);

  let offset = 0;
  const index: string[] = [];
  const chunks: string[] = [];
  for (const id of ids) {
    const line = `${JSON.stringify(rows.get(id))}\n`;
    const bytes = Buffer.byteLength(line);
    index.push(
      JSON.stringify({
        id,
        fp: fingerprint(rows.get(id) as never),
        off: offset,
        len: bytes,
      }),
    );
    chunks.push(line);
    offset += bytes;
  }
  writeFileSync(rowsPath, chunks.join(''));
  writeFileSync(indexPath, `${index.join('\n')}\n`);

  console.log(`${rowsPath} — ${(offset / 1048576).toFixed(1)} MB`);
  console.log(`${indexPath} — ${(statSync(indexPath).size / 1048576).toFixed(1)} MB`);
}

await main();
