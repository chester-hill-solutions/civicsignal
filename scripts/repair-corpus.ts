#!/usr/bin/env bun
/**
 * Repair the corpus in D1.
 *
 * The load checkpoints, and a checkpoint is a claim about the past: "the first
 * N rows are loaded". An earlier version of the load counted the rows it
 * *attempted* rather than the rows that were *written*, so a row that failed
 * counted as done, the checkpoint walked past it, and the row was never loaded
 * and never loaded again. The load reported itself complete and left 7,741
 * provisions missing — a corpus that was quietly a little smaller than it
 * claimed, which is the failure mode that a citation cannot detect.
 *
 * So the load's checkpoint is fixed, and this is the other half: **a way to ask
 * the database what it has** rather than trusting a file about it. The corpus
 * is 277,857 rows and the store is the product, so the two have to be
 * reconciled — and the cheapest reconciliation is to read the ids out and diff
 * them.
 *
 *     bun scripts/repair-corpus.ts                 # both languages
 *     bun scripts/repair-corpus.ts --lang fr       # one of them
 *     bun scripts/repair-corpus.ts --dry-run       # report, write nothing
 *     bun scripts/repair-corpus.ts --prune         # also delete rows the corpus does not have
 *
 * The rows it writes are only the missing ones, so a repair after a bad run
 * costs minutes rather than the two hours a full reload costs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { query, writeRows, type Row } from './lib/d1-load';

const ROOT = new URL('..', import.meta.url).pathname;

interface Args {
  lang: 'en' | 'fr' | 'both';
  dryRun: boolean;
  prune: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { lang: 'both', dryRun: false, prune: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--lang') {
      const value = argv[++i];
      if (value !== 'en' && value !== 'fr' && value !== 'both') {
        throw new Error(`--lang must be one of en, fr, both (got "${value ?? ''}")`);
      }
      args.lang = value;
    } else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--prune') args.prune = true;
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

  let totalMissing = 0;
  let totalStale = 0;

  for (const lang of langs) {
    const rows = rowsFor(lang);
    const corpusIds = new Set(rows.map((row) => String(row['id'])));
    const stored = await query<{ id: string }>(
      'SELECT id FROM statute_sections WHERE language = ?',
      [lang],
    );
    const storedIds = new Set(stored.map((row) => row.id));

    const missing = rows.filter((row) => !storedIds.has(String(row['id'])));
    const stale = [...storedIds].filter((id) => !corpusIds.has(id));

    console.log(
      `repair-corpus: ${lang} — the corpus has ${corpusIds.size.toLocaleString()} rows, ` +
        `the store has ${storedIds.size.toLocaleString()}, ` +
        `${missing.length.toLocaleString()} missing, ${stale.length.toLocaleString()} stale`,
    );

    totalMissing += missing.length;
    totalStale += stale.length;

    if (args.dryRun || missing.length === 0) {
      if (missing.length) {
        console.log('  (dry run: nothing was written)');
      }
    } else {
      const started = Date.now();
      const result = await writeRows(missing, {
        onProgress: (sent, total) => {
          if (sent % 1_000 === 0 || sent === total) {
            const rate = sent / ((Date.now() - started) / 1000);
            console.log(
              `  ${sent.toLocaleString()} / ${total.toLocaleString()} ` +
                `(${rate.toFixed(0)}/s)`,
            );
          }
        },
      });
      console.log(
        `repair-corpus: ${lang} — wrote ${(result.sent - result.failed).toLocaleString()} row(s)` +
          (result.failed ? `, ${result.failed} failed` : ''),
      );
    }

    if (stale.length && args.prune) {
      console.log(`repair-corpus: ${lang} — deleting ${stale.length.toLocaleString()} stale row(s)`);
      for (const id of stale) {
        await query('DELETE FROM statute_sections WHERE id = ?', [id]);
      }
    } else if (stale.length) {
      console.log(`  ${stale.length.toLocaleString()} stale row(s) (--prune to delete them)`);
    }
  }

  if (totalMissing) {
    console.log(`repair-corpus: ${totalMissing.toLocaleString()} row(s) were missing`);
  } else {
    console.log('repair-corpus: the store and the corpus agree');
  }
  if (totalStale) {
    console.log(`repair-corpus: ${totalStale.toLocaleString()} stale row(s) — run with --prune`);
  }
}

await main();
