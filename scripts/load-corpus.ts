/**
 * Load the corpus into D1.
 *
 * The SQL file the ingest writes cannot do this job, and the reason is worth
 * recording.
 *
 * **`wrangler d1 execute --file` sends the statement text literally**, and D1
 * refuses a statement over 100 KB with `SQLITE_TOOBIG`. The corpus's longest
 * provision is 303,526 characters — one row is 607 KB of SQL — so a handful of
 * provisions cannot be loaded as literals at any batch size. A bound parameter
 * is a separate value rather than part of the statement, and the same row
 * loads in one statement of a few hundred bytes.
 *
 * So the load goes through the D1 query API with bound parameters. It is also
 * the better way round for reasons that have nothing to do with the limit: a
 * literal has to be escaped, and the corpus is full of apostrophes, quotes and
 * semicolons.
 *
 * The corpus is a *rebuildable* thing — the upstream repository is its backup —
 * so this script only ever inserts. It is safe to run twice; the second run
 * replaces the rows.
 *
 *     bun scripts/load-corpus.ts                       # both languages
 *     bun scripts/load-corpus.ts --lang fr             # one of them
 *     bun scripts/load-corpus.ts --dry-run             # count only
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeRows, type Row } from './lib/d1-load';

const ROOT = new URL('..', import.meta.url).pathname;

interface Args {
  lang: 'en' | 'fr' | 'both';
  dryRun: boolean;
  limit: number | undefined;
  skip: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { lang: 'both', dryRun: false, limit: undefined, skip: 0 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--lang') {
      const value = argv[++i];
      if (value !== 'en' && value !== 'fr' && value !== 'both') {
        throw new Error(`--lang must be one of en, fr, both (got "${value ?? ''}")`);
      }
      args.lang = value;
    } else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--limit') {
      args.limit = Number(argv[++i]);
      if (!Number.isSafeInteger(args.limit) || args.limit < 1) {
        throw new Error('--limit must be a positive integer');
      }
    } else if (arg === '--skip') {
      args.skip = Number(argv[++i]);
      if (!Number.isSafeInteger(args.skip) || args.skip < 0) {
        throw new Error('--skip must be a non-negative integer');
      }
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function rowsFor(lang: 'en' | 'fr'): Row[] {
  const file = join(ROOT, 'dist', lang === 'fr' ? 'statutes-fr.jsonl' : 'statutes.jsonl');
  const text = readFileSync(file, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const langs = args.lang === 'both' ? (['en', 'fr'] as const) : ([args.lang] as const);

  for (const lang of langs) {
    let rows = rowsFor(lang);
    if (args.limit) rows = rows.slice(0, args.limit);

    // The checkpoint is the last durable record of how far the job got. The
    // rows are in a fixed order, so "how far" is a number, and the number is
    // written after every few hundred rows.
    const checkpoint = join(ROOT, 'dist', `.load-checkpoint-${lang}`);
    let skip = args.skip;
    if (skip === 0 && existsSync(checkpoint)) {
      const saved = Number(readFileSync(checkpoint, 'utf8').trim());
      if (Number.isFinite(saved) && saved > 0) {
        console.log(`  resuming: ${saved.toLocaleString()} row(s) are already loaded`);
        skip = saved;
      }
    }
    if (skip) rows = rows.slice(skip);
    const characters = rows.reduce((sum, r) => sum + String(r['text'] ?? '').length, 0);
    console.log(
      `load-corpus: ${rows.length.toLocaleString()} ${lang} row(s), ` +
        `${(characters / 1e6).toFixed(1)}M characters`,
    );
    if (args.dryRun) continue;

    /**
     * The rows that are **done**, and the first one that is not.
     *
     * The checkpoint says how far the job got, and "how far" has to mean "the
     * first row that is not loaded" — not "the number of rows we attempted".
     * An earlier version counted attempts, so a row that failed was counted as
     * done, the checkpoint walked past it, and the row was never loaded and
     * never loaded again: 7,741 provisions missing from a corpus that reported
     * itself complete.
     *
     * So the checkpoint is the first gap, and a failure holds it there. The
     * workers run six at a time, so the first gap is at most six rows behind
     * the work.
     */
    const done = new Set<number>();
    let firstGap = 0;
    const advance = (): void => {
      while (done.has(firstGap)) firstGap++;
    };

    const started = Date.now();
    const result = await writeRows(rows, {
      onRow: (index, ok) => {
        if (ok) done.add(index);
        advance();
      },
      onProgress: (sent, total) => {
        // The checkpoint, often: a crash costs a second's work.
        if (sent % 500 === 0) {
          writeFileSync(checkpoint, String(skip + firstGap));
        }
        if (sent % 2_000 === 0 || sent === total) {
          const rate = sent / ((Date.now() - started) / 1000);
          const left = Math.round((total - sent) / rate);
          console.log(
            `  ${sent.toLocaleString()} / ${total.toLocaleString()} ` +
              `(${rate.toFixed(0)}/s, about ${Math.round(left / 60)} min left)`,
          );
        }
      },
    });
    writeFileSync(checkpoint, String(skip + firstGap));

    if (result.failed) {
      throw new Error(`${result.failed} row(s) failed to load — the corpus is incomplete.`);
    }
    console.log(`load-corpus: ${lang} loaded`);
  }
}

await main();
