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
import { fetchWithAuth } from './lib/cloudflare-auth';

const ROOT = new URL('..', import.meta.url).pathname;

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'ad5ec479b9a421faa2ed06c3d1c2b23a';
const DATABASE_ID = process.env.D1_DATABASE_ID ?? '8056b1a0-f858-4f89-a332-91f7f350eb7b';

/** The columns, in the order the parameters are given. */
const COLUMNS = [
  'id',
  'corpus_id',
  'act',
  'citation',
  'section',
  'status',
  'schedule',
  'part',
  'heading',
  'text',
  'source_url',
  'jurisdiction',
  'in_force',
  'language',
  'topics',
  'search_text',
] as const;

const PLACEHOLDERS = COLUMNS.map(() => '?').join(', ');
const INSERT_SQL = `INSERT OR REPLACE INTO statute_sections (${COLUMNS.join(', ')}) VALUES (${PLACEHOLDERS})`;

/**
 * How many loads run at once.
 *
 * The D1 REST API has no batch endpoint — `/query` takes one statement — so the
 * throughput comes from having several in flight. The account's own limit is
 * what bounds it, and the answer comes back as a 429 when it is reached, so
 * this is tuned to stay under it rather than to find it.
 */
const CONCURRENCY = 6;

interface Args {
  lang: 'en' | 'fr' | 'both';
  dryRun: boolean;
  limit: number | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { lang: 'both', dryRun: false, limit: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--lang') {
      const value = argv[++i];
      if (value !== 'en' && value !== 'fr' && value !== 'both') {
        throw new Error(`--lang must be one of en, fr, both (got "${value ?? ''}")`);
      }
      args.lang = value;
    } else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--limit') args.limit = Number(argv[++i]);
  }
  return args;
}

interface Row {
  [key: string]: unknown;
}

function rowsFor(lang: 'en' | 'fr'): Row[] {
  const file = join(ROOT, 'dist', lang === 'fr' ? 'statutes-fr.jsonl' : 'statutes.jsonl');
  const text = readFileSync(file, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);
}

/** The parameters for one row, in the order the placeholders expect them. */
function paramsFor(row: Row): unknown[] {
  return COLUMNS.map((column) => {
    const value = row[column];
    if (value === undefined || value === null) return null;
    return value as string | number;
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const langs = args.lang === 'both' ? (['en', 'fr'] as const) : ([args.lang] as const);

  for (const lang of langs) {
    let rows = rowsFor(lang);
    if (args.limit) rows = rows.slice(0, args.limit);
    const characters = rows.reduce((sum, r) => sum + String(r['text'] ?? '').length, 0);
    console.log(
      `load-corpus: ${rows.length.toLocaleString()} ${lang} row(s), ` +
        `${(characters / 1e6).toFixed(1)}M characters`,
    );
    if (args.dryRun) continue;

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

    let sent = 0;
    let failed = 0;
    const started = Date.now();
    let next = 0;

    /** One load, with the retry a rate limit needs. */
    const load = async (row: Row): Promise<void> => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await fetchWithAuth(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql: INSERT_SQL, params: paramsFor(row) }),
        });

        if (response.status === 429 || response.status >= 500) {
          // A rate limit or a transient failure: back off and try again. The
          // row is not lost, because nothing was written.
          await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
          continue;
        }
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`D1 refused row ${row['id']}: ${response.status} ${body.slice(0, 300)}`);
        }
        const result = (await response.json()) as { success: boolean; errors?: { message: string }[] };
        if (!result.success) {
          throw new Error(`D1 refused row ${row['id']}: ${result.errors?.[0]?.message ?? 'unknown'}`);
        }
        return;
      }
      throw new Error(`D1 kept refusing row ${row['id']}`);
    };

    const workers = Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const index = next++;
        if (index >= rows.length) return;
        try {
          await load(rows[index]!);
        } catch (error) {
          failed++;
          console.error(`  ${String(error).slice(0, 200)}`);
        }
        sent++;
        // The checkpoint, often: a crash costs a second's work.
        if (sent % 500 === 0) {
          writeFileSync(checkpoint, String(args.skip + sent));
        }
        if (sent % 2_000 === 0 || sent === rows.length) {
          const rate = sent / ((Date.now() - started) / 1000);
          const left = Math.round((rows.length - sent) / rate);
          console.log(
            `  ${sent.toLocaleString()} / ${rows.length.toLocaleString()} ` +
              `(${rate.toFixed(0)}/s, about ${Math.round(left / 60)} min left)`,
          );
        }
      }
    });
    await Promise.all(workers);

    if (failed) {
      throw new Error(`${failed} row(s) failed to load — the corpus is incomplete.`);
    }
    console.log(`load-corpus: ${lang} loaded`);
  }
}

await main();
