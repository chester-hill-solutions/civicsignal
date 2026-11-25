#!/usr/bin/env bun
/**
 * Ingest the Justice Laws corpus into section rows.
 *
 * The corpus is `justicecanada/laws-lois-xml` — a git clone, Open Government Licence
 * - Canada, no rate limits. The clone is cached locally and refreshed on demand; the
 * parse is delegated to `src/ingest/statutes.ts`, which is pure and unit-tested.
 *
 *   bun run ingest:statutes                 # refresh the clone, parse, write SQL
 *   bun run ingest:statutes -- --no-fetch   # parse the cached clone only
 *   bun run ingest:statutes -- --lang en    # English only (default: both)
 *   bun run ingest:statutes -- --out dist    # where to write the SQL
 *
 * Output is a .sql file of INSERT statements, ready for:
 *   npx wrangler d1 execute civicsignal --remote --file=dist/statutes.sql
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { buildRows, parseStatuteXml, toInsertStatements } from '../src/ingest/statutes';

const CORPUS_REPO = 'https://github.com/justicecanada/laws-lois-xml.git';
const CORPUS_DIR = join(process.env.HOME ?? '.', '.cache', 'civicsignal', 'laws-lois-xml');
const OUT_DIR = 'dist';

interface Args {
  fetch: boolean;
  corpus: string;
  publishCurrent: boolean;
  lang: 'en' | 'fr' | 'both';
  out: string;
  limit: number | undefined;
}

function parseArgs(argv: string[]): Args {
  const { values } = parseOptions({
    args: argv.filter(arg => arg !== '--'),
    options: {
      'no-fetch': { type: 'boolean', default: false },
      'publish-current': { type: 'boolean', default: false },
      corpus: { type: 'string', default: CORPUS_DIR },
      out: { type: 'string', default: OUT_DIR },
      lang: { type: 'string', default: 'both' },
      limit: { type: 'string' },
    },
  });
  const { lang } = values;
  if (lang !== 'en' && lang !== 'fr' && lang !== 'both') throw new Error('--lang must be en, fr or both.');
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('--limit requires a positive document count per language.');
  if (values['publish-current'] && (limit || lang !== 'both')) throw new Error('--publish-current requires complete exports in both languages.');
  return { corpus: values.corpus, out: values.out, lang, limit, fetch: !values['no-fetch'], publishCurrent: values['publish-current'] };
}

async function ensureCorpus(corpus: string, fetchIt: boolean): Promise<void> {
  if (!existsSync(corpus)) {
    if (!fetchIt) {
      throw new Error(`Corpus not present at ${corpus} and --no-fetch was passed.`);
    }
    mkdirSync(join(corpus, '..'), { recursive: true });
    console.log(`cloning ${CORPUS_REPO} …`);
    const proc = Bun.spawn(['git', 'clone', '--depth', '1', CORPUS_REPO, corpus], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`git clone failed with code ${code}`);
    return;
  }
  if (!fetchIt) return;
  console.log('refreshing the corpus clone …');
  const proc = Bun.spawn(['git', '-C', corpus, 'pull', '--ff-only'], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git pull failed with code ${code}`);
}

/**
 * The corpus names its language directories `eng` and `fra`, not the ISO codes
 * `en` and `fr` the product uses everywhere else.
 */
const CORPUS_LANG_DIR: Record<'en' | 'fr', string> = { en: 'eng', fr: 'fra' };

/** The corpus's directory names, by language. */
const CORPUS_DIRS: Record<'en' | 'fr', [string, 'acts' | 'regulations'][]> = {
  en: [
    ['acts', 'acts'],
    ['regulations', 'regulations'],
  ],
  fr: [
    ['lois', 'acts'],
    ['reglements', 'regulations'],
  ],
};

function readStatuteFiles(corpus: string, lang: 'en' | 'fr'): { kind: 'acts' | 'regulations'; file: string }[] {
  const out: { kind: 'acts' | 'regulations'; file: string }[] = [];
  // The directory names differ by language, and getting them wrong is silent:
  // the French tree is `fra/lois` and `fra/reglements`, not `fra/acts` and
  // `fra/regulations`. Looking in the wrong place finds nothing, and the ingest
  // reports a corpus with no French in it and no error.
  for (const [dirName, kind] of CORPUS_DIRS[lang]) {
    const dir = join(corpus, CORPUS_LANG_DIR[lang], dirName);
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.xml')) continue;
      out.push({ kind, file: join(dir, name) });
    }
  }
  return out;
}

function exportLanguage(args: Args, lang: 'en' | 'fr', directory: string): void {
  const suffix = lang === 'fr' ? '-fr' : '';
  const sql = join(directory, `statutes${suffix}.sql`);
  const jsonl = join(directory, `statutes${suffix}.jsonl`);
  const titles = new Set<string>();
  let files = 0;
  let skipped = 0;
  let rowCount = 0;
  for (const { kind, file } of readStatuteFiles(args.corpus, lang)) {
    const xml = readFileSync(file, 'utf8');
    const stem = file.slice(file.lastIndexOf('/') + 1).replace(/\.xml$/, '');
    const parsed = parseStatuteXml(xml, { citation: kind === 'regulations' ? stem : undefined });
    if (!parsed) {
      if (args.publishCurrent) throw new Error(`Cannot publish an incomplete export. Failed to parse ${file}.`);
      skipped++;
      continue;
    }
    const rows = buildRows(parsed, { kind, language: lang });
    if (rows.length) {
      appendFileSync(sql, toInsertStatements(rows).join('\n') + '\n');
      appendFileSync(jsonl, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      rowCount += rows.length;
      for (const row of rows) titles.add(row.act);
    }
    files++;
    if (files === args.limit) break;
  }
  if (!rowCount) throw new Error(`No ${lang} rows in ${args.corpus}.`);
  const sortedTitles = [...titles].sort((a, b) => b.length - a.length || a.localeCompare(b));
  writeFileSync(join(directory, `act-titles${suffix}.json`), JSON.stringify(sortedTitles));
  console.log(`${lang}: parsed ${files} documents, ${rowCount} sections, ${skipped} skipped`);
}

function sourceRevision(corpus: string): string {
  function git(...args: string[]): string {
    const proc = Bun.spawnSync(['git', '-C', corpus, ...args]);
    if (proc.exitCode !== 0) throw new Error('Cannot read the Justice Canada checkout.');
    return proc.stdout.toString().trim();
  }
  if (git('config', '--get', 'remote.origin.url') !== CORPUS_REPO ||
      git('status', '--porcelain', '--untracked-files=all', '--', 'eng', 'fra')) {
    throw new Error('Publication requires the official checkout with clean language directories.');
  }
  const head = git('rev-parse', 'HEAD');
  if (head !== git('rev-parse', 'refs/remotes/origin/main')) {
    throw new Error('Publication requires the observed Justice Canada main revision.');
  }
  return head;
}

function hashes(directory: string, files: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const block = Buffer.allocUnsafe(1024 * 1024);
  for (const file of files) {
    const hash = createHash('sha256');
    const fd = openSync(join(directory, file), 'r');
    try {
      let size;
      while ((size = readSync(fd, block)) > 0) hash.update(block.subarray(0, size));
    } finally { closeSync(fd); }
    result[file] = hash.digest('hex');
  }
  return result;
}

async function publish(stage: string, root: string, revision: string) {
  const checker = fileURLToPath(new URL('./check-corpus-invariants.mjs', import.meta.url));
  const checked = Bun.spawn(['node', checker, '--exports', stage, '--require-exports'], { stdout: 'inherit', stderr: 'inherit' });
  if (await checked.exited !== 0) throw new Error('Statutes export verification failed.');
  const names = readdirSync(stage).sort();
  const files = hashes(stage, names);
  const receipt = JSON.stringify({ source: CORPUS_REPO, revision, files }, null, 2) + '\n';
  const generation = createHash('sha256').update(receipt).digest('hex');
  writeFileSync(join(stage, 'receipt.json'), receipt);
  const destination = join(root, generation);
  try {
    renameSync(stage, destination);
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    if (readFileSync(join(destination, 'receipt.json'), 'utf8') !== receipt ||
        JSON.stringify(hashes(destination, names)) !== JSON.stringify(files)) {
      throw new Error('Existing statutes generation differs from the verified export.');
    }
  }
  const pointer = join(root, '.current-' + randomUUID());
  symlinkSync(generation, pointer, 'dir');
  try { renameSync(pointer, join(root, 'current')); } finally { rmSync(pointer, { force: true }); }
  console.log(JSON.stringify({ revision, generation, receipt: join(root, 'current', 'receipt.json') }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await ensureCorpus(args.corpus, args.fetch);
  const revision = args.publishCurrent ? sourceRevision(args.corpus) : undefined;
  mkdirSync(args.out, { recursive: true });
  const stage = mkdtempSync(join(args.out, '.statutes-'));
  try {
    const langs: ('en' | 'fr')[] = args.lang === 'both' ? ['en', 'fr'] : [args.lang];
    for (const lang of langs) exportLanguage(args, lang, stage);
    if (revision) {
      if (sourceRevision(args.corpus) !== revision) throw new Error('Source revision changed during export.');
      await publish(stage, args.out, revision);
    } else {
      for (const name of readdirSync(stage)) renameSync(join(stage, name), join(args.out, name));
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

await main();
