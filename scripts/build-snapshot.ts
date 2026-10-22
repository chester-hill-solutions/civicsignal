#!/usr/bin/env bun
/**
 * Build a corpus snapshot.
 *
 * A snapshot is the corpus as rows, with a fingerprint per row, in a form that
 * can be read in pieces:
 *
 *   <commit>.manifest.json    what it is: the count, the size, the parts
 *   <commit>.index.jsonl      id, fingerprint, byte offset and length of each row
 *   <commit>.rows.NNN.jsonl   the rows, one JSON object per line, sorted by id
 *
 * The **index** is the diff. Two index files, compared, give the changed ids,
 * the gone ids and the new ids — exactly, in about twenty megabytes. The
 * **rows** are read in pieces: the index carries each row's offset and length,
 * so one row is one HTTP range request.
 *
 * The rows are **parts** because a single object cannot be published —
 * neither wrangler nor the Cloudflare API will upload more than 300 MB, and
 * the rows are three hundred and forty-seven. The offsets stay global, so the
 * part size is a publishing detail and nothing else.
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
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rowsForFile } from '../src/ingest/corpus-rows';
import { fingerprint } from '../src/ingest/reconcile';
import { indexKey, indexLine, DEFAULT_PART_BYTES } from '../src/ingest/snapshot-format';
import { manifestFor, writeManifest, writeParts } from './lib/part-writer';

const CORPUS_DIR = join(process.env.HOME ?? '.', '.cache', 'civicsignal', 'laws-lois-xml');
const CORPUS_ID = 'statutes-canada';

const args = process.argv.slice(2);
const revision = arg('--revision');
const partBytes = Number(arg('--part-bytes') ?? DEFAULT_PART_BYTES);
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

/**
 * The revision's date.
 *
 * It is the commit's own date, and it goes on every row as `lastChanged` —
 * the date the corpus last changed the provision. This used to be
 * `rev.slice(0, 10)`, which is the first ten characters of the **sha**: every
 * row in the snapshot carried a date of `0507465393`. The diff never noticed,
 * because `lastChanged` is deliberately not part of a fingerprint — it is not
 * something a provision *is* — but the store persists it, and a provision's
 * date is a thing the product shows.
 */
function dateOf(rev: string): string {
  const proc = Bun.spawnSync(
    ['git', '-C', CORPUS_DIR, 'show', '-s', '--format=%cs', rev],
    { stdout: 'pipe', stderr: 'ignore' },
  );
  const date = proc.stdout.toString().trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`the clone does not know the date of ${rev}`);
  }
  return date;
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

  const date = dateOf(rev);
  const root = tree(rev);
  const files = instrumentFiles(root);
  console.log(`${files.length} instrument file(s) in ${root}, at ${rev.slice(0, 9)} (${date})`);

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
      date,
      corpusId: CORPUS_ID,
    })) {
      rows.set(row.id, row);
    }
  }
  console.log(`${rows.size} row(s)`);

  // The rows, sorted by id, and the index that points at them.
  //
  // The two are written in one pass: the index is what says where each row
  // is, so the offsets come from the pass that writes them, and there is no
  // way for the two to disagree about a row's position.
  const ids = [...rows.keys()].sort();
  const indexPath = join(out, indexKey(rev));
  let offset = 0;
  const index: string[] = [];

  function* rowLines(): Generator<string> {
    for (const id of ids) {
      const row = rows.get(id);
      const line = `${JSON.stringify(row)}\n`;
      const bytes = Buffer.byteLength(line);
      index.push(indexLine({ id, fp: fingerprint(row as never), off: offset, len: bytes }));
      offset += bytes;
      yield line;
    }
  }

  const written = writeParts({ out, commit: rev, lines: rowLines(), partBytes });
  // `indexLine` carries its own newline — it is "the entry's bytes as the file
  // holds them" — so the lines are joined with nothing. Joining with a newline
  // is how the index came to have a blank line between every entry: two
  // hundred and seventy-seven thousand of them, one byte each, invisible to
  // every reader because a blank line is skipped.
  writeFileSync(indexPath, index.join(''));

  const manifest = manifestFor({ out, commit: rev, date, rows: written, partBytes });
  const manifestPath = writeManifest(out, manifest);

  const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
  console.log(`${written.count} row(s) in ${written.parts.length} part(s) — ${mb(written.bytes)}`);
  for (const part of written.parts) console.log(`  ${part.key} — ${mb(part.bytes)}`);
  console.log(`  ${indexPath} — ${mb(manifest.index.bytes)}`);
  console.log(`  ${manifestPath}`);
}

await main();
