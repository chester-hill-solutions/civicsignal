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

/** Bytes, as megabytes. */
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

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

/**
 * The instrument files, one at a time, in a stable order.
 *
 * A generator, not an array: the corpus is 878 MB of XML across eleven
 * thousand files, and reading them all before parsing any of them is how this
 * script held more memory than it needed to and more than a Worker has. The
 * listing is read first — twelve thousand names is nothing — and each file is
 * read as it is yielded.
 */
function* instrumentFiles(root: string): Generator<{ path: string; content: string }> {
  const dirs = [
    ['eng/acts', 'acts'],
    ['eng/regulations', 'regulations'],
    ['fra/lois', 'acts'],
    ['fra/reglements', 'regulations'],
  ] as const;
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
      yield { path: `${dir}/${name}`, content: readFileSync(file, 'utf8') };
    }
  }
}

async function main(): Promise<void> {
  const rev = revision ?? parent;
  if (!rev) {
    console.error('a revision is needed: --revision <sha>');
    process.exit(1);
  }

  const date = dateOf(rev);
  const root = tree(rev);
  const names = [...instrumentFiles(root)].length;
  console.log(`${names} instrument file(s) in ${root}, at ${rev.slice(0, 9)} (${date})`);

  // **The rows are written in file order, and only the index is sorted.**
  //
  // The rows used to be collected into a Map, sorted by id, and written — 360
  // MB of rows held at once, plus the 347 MB string they were joined into.
  // That is not an optimisation to be tidier about; it is the difference
  // between a job that can run in a Worker and one that cannot, and it is why
  // the snapshot builder was a script with a clone.
  //
  // It works because **the reader finds a row by its byte offset** and does
  // not care what order the rows are in: `mergeRanges` sorts the ranges it is
  // given. The order that matters is the *index's*, because the diff is a
  // merge of the index against the store's fingerprints, which D1 pages
  // `ORDER BY id`.
  //
  // So the index lines are held (26 MB, not 347), and sorting them is a plain
  // lexicographic sort: every line begins `{"id":"`, so comparing the lines
  // compares the ids — a shorter id that is a prefix of a longer one ends in
  // `"` (0x22) where the longer one has a letter, and sorts first, exactly as
  // the ids themselves do.
  //
  // The one thing the sort has to handle is **duplicates**: a provision can
  // appear in more than one file (a schedule's items carry the instrument's
  // rows too), and the rule is that the last one wins. The sort is stable, so
  // duplicates land adjacent in file order and the last of each run is the one
  // kept — which is what the Map used to do, without the Map. The rows file
  // keeps the duplicates as unreachable bytes: the index points at one of
  // them, and the other is read by nothing.
  const indexPath = join(out, indexKey(rev));
  const indexLines: string[] = [];
  const indexIds: string[] = [];
  let offset = 0;

  function* rowLines(): Generator<string> {
    for (const file of instrumentFiles(root)) {
      for (const row of rowsForFile({
        path: file.path,
        content: file.content,
        date,
        corpusId: CORPUS_ID,
      })) {
        const line = `${JSON.stringify(row)}\n`;
        const bytes = Buffer.byteLength(line);
        indexIds.push(row.id);
        indexLines.push(indexLine({ id: row.id, fp: fingerprint(row), off: offset, len: bytes }));
        offset += bytes;
        yield line;
      }
    }
  }

  const written = writeParts({ out, commit: rev, lines: rowLines(), partBytes });
  console.log(`${written.count} row(s) in ${written.parts.length} part(s) — ${mb(written.bytes)}`);

  // The sort, and the dedup it makes adjacent.
  const order = Int32Array.from(indexIds.keys());
  const sorted = [...order].sort((a, b) => {
    const left = indexIds[a]!;
    const right = indexIds[b]!;
    if (left < right) return -1;
    if (left > right) return 1;
    return a - b;
  });
  const kept: string[] = [];
  let dropped = 0;
  for (let at = 0; at < sorted.length; at++) {
    const next = sorted[at + 1];
    if (next !== undefined && indexIds[next] === indexIds[sorted[at]!]) {
      dropped++;
      continue;
    }
    kept.push(indexLines[sorted[at]!]!);
  }
  writeFileSync(indexPath, kept.join(''));

  const manifest = manifestFor({ out, commit: rev, date, rows: written, partBytes });
  const manifestPath = writeManifest(out, manifest);

  for (const part of written.parts) console.log(`  ${part.key} — ${mb(part.bytes)}`);
  console.log(`  ${indexPath} — ${mb(manifest.index.bytes)}, ${kept.length} entries`);
  console.log(`  ${manifestPath}`);
  if (dropped > 0) {
    console.log(
      `  ${dropped} duplicate row(s) — a provision that appears in more than one file, ` +
        `where the last one wins, as it always has`,
    );
  }
}

await main();
