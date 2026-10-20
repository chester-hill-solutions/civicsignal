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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRows, parseStatuteXml, toInsertStatements, type StatuteSectionRow } from '../src/ingest/statutes';

const CORPUS_REPO = 'https://github.com/justicecanada/laws-lois-xml.git';
const CORPUS_DIR = join(process.env.HOME ?? '.', '.cache', 'civicsignal', 'laws-lois-xml');
const OUT_DIR = 'dist';

interface Args {
  fetch: boolean;
  lang: 'en' | 'fr' | 'both';
  out: string;
  limit: number | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { fetch: true, lang: 'both', out: OUT_DIR, limit: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `bun run x -- --flag` passes a literal `--` through; it is a separator, not an
    // argument. Skipping it matters: without this, `--lang` is read as the language.
    if (arg === '--') continue;
    if (arg === '--no-fetch') args.fetch = false;
    else if (arg === '--lang') {
      const value = argv[++i];
      if (value !== 'en' && value !== 'fr' && value !== 'both') {
        throw new Error(`--lang must be one of en, fr, both (got "${value ?? ''}")`);
      }
      args.lang = value;
    } else if (arg === '--out') args.out = argv[++i] ?? OUT_DIR;
    else if (arg === '--limit') args.limit = Number(argv[++i]);
  }
  return args;
}

async function ensureCorpus(fetchIt: boolean): Promise<void> {
  if (!existsSync(CORPUS_DIR)) {
    if (!fetchIt) {
      throw new Error(`Corpus not present at ${CORPUS_DIR} and --no-fetch was passed.`);
    }
    mkdirSync(join(CORPUS_DIR, '..'), { recursive: true });
    console.log(`cloning ${CORPUS_REPO} …`);
    const proc = Bun.spawn(['git', 'clone', '--depth', '1', CORPUS_REPO, CORPUS_DIR], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`git clone failed with code ${code}`);
    return;
  }
  if (!fetchIt) return;
  console.log('refreshing the corpus clone …');
  const proc = Bun.spawn(['git', '-C', CORPUS_DIR, 'pull', '--ff-only'], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  await proc.exited;
}

/**
 * The corpus names its language directories `eng` and `fra`, not the ISO codes
 * `en` and `fr` the product uses everywhere else.
 */
const CORPUS_LANG_DIR: Record<'en' | 'fr', string> = { en: 'eng', fr: 'fra' };

function readStatuteFiles(lang: 'en' | 'fr'): { kind: 'acts' | 'regulations'; file: string }[] {
  const out: { kind: 'acts' | 'regulations'; file: string }[] = [];
  for (const kind of ['acts', 'regulations'] as const) {
    const dir = join(CORPUS_DIR, CORPUS_LANG_DIR[lang], kind);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.xml')) continue;
      out.push({ kind, file: join(dir, name) });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await ensureCorpus(args.fetch);

  const langs: ('en' | 'fr')[] = args.lang === 'both' ? ['en', 'fr'] : [args.lang];
  const rows: StatuteSectionRow[] = [];
  let files = 0;
  let skipped = 0;

  for (const lang of langs) {
    for (const { kind, file } of readStatuteFiles(lang)) {
      const xml = readFileSync(file, 'utf8');
      // A regulation's citation is its file stem; a statute's is in the document.
      const stem = file.slice(file.lastIndexOf('/') + 1).replace(/\.xml$/, '');
      const parsed = parseStatuteXml(xml, { citation: kind === 'regulations' ? stem : undefined });
      if (!parsed) {
        skipped++;
        continue;
      }
      rows.push(...buildRows(parsed, { kind, language: lang }));
      files++;
      if (args.limit && files >= args.limit) break;
    }
  }

  const withText = rows.filter((r) => r.text.length > 0);
  console.log(
    `parsed ${files} document(s) into ${rows.length} section(s) (${withText.length} with text; ${skipped} skipped)`,
  );
  if (rows.length === 0) {
    console.error('no rows parsed — check the corpus clone and the --lang flag');
    process.exit(1);
  }

  mkdirSync(args.out, { recursive: true });
  const sqlPath = join(args.out, 'statutes.sql');
  writeFileSync(sqlPath, toInsertStatements(rows).join('\n'));
  console.log(`wrote ${sqlPath}`);

  const jsonlPath = join(args.out, 'statutes.jsonl');
  writeFileSync(jsonlPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`wrote ${jsonlPath}`);

  // The instrument titles, for citation parsing. Longest first, so that
  // "Canada Labour Code" wins over a shorter title that is a substring of it.
  const titles = [...new Set(rows.map((r) => r.act))].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const titlesPath = join(args.out, 'act-titles.json');
  writeFileSync(titlesPath, JSON.stringify(titles));
  console.log(`wrote ${titlesPath} — ${titles.length} instrument titles`);
}

await main();
