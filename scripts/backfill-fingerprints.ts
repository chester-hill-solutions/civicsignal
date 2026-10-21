/**
 * Backfill the fingerprints.
 *
 * The pipeline's reconciliation is **by fingerprint**: a provision whose
 * fingerprint has not changed has not changed. The column that holds the
 * fingerprint was added by a migration to a corpus that was already there, so
 * every one of its 277,857 rows has a NULL fingerprint — and a NULL
 * fingerprint reads as "this row has never been seen", which would make the
 * first cycle after the migration believe that the whole corpus is new and
 * re-embed all of it.
 *
 * So the fingerprints are filled in once, by hand, and **from the rows
 * themselves**: the hash describes what the store holds, not what the corpus
 * says today. That distinction is the whole point. A hash taken from the
 * corpus would say "unchanged" about a row the store holds at an older
 * revision, and the store would never be corrected — the pipeline would be
 * confidently wrong about every row that moved in between.
 *
 * ## Reading and writing
 *
 * The D1 REST API takes one statement at a time, so the throughput comes from
 * having several in flight. The writes are batched into multi-statement
 * requests, and the reads are paged by key rather than by offset — an offset
 * scan at the end of a quarter of a million rows is a scan of the whole
 * table, every time.
 *
 *     bun scripts/backfill-fingerprints.ts             # fill them in
 *     bun scripts/backfill-fingerprints.ts --dry-run   # count, and write nothing
 *     bun scripts/backfill-fingerprints.ts --compare   # check against the corpus
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchWithAuth } from './lib/cloudflare-auth';
import { query } from './lib/d1-load';
import { fingerprint } from '../src/ingest/reconcile';
import { buildRows, parseStatuteXml } from '../src/ingest/statutes';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'ad5ec479b9a421faa2ed06c3d1c2b23a';
const DATABASE_ID = process.env.D1_DATABASE_ID ?? '8056b1a0-f858-4f89-a332-91f7f350eb7b';
const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

const CORPUS_ID = 'statutes-canada';
const CORPUS_DIR = join(process.env.HOME ?? '.', '.cache', 'civicsignal', 'laws-lois-xml');

/** How many rows to read at a time. */
const PAGE = 1000;

/** How many statements to write at a time. */
const BATCH = 100;

/** How many requests to have in flight. */
const CONCURRENCY = 8;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const compare = args.includes('--compare');

interface StoredRow {
  id: string;
  act: string;
  citation: string;
  section: string;
  schedule: string | null;
  part: string | null;
  status: string | null;
  heading: string | null;
  text: string;
  source_url: string | null;
  in_force: number;
}

/** The fingerprint of a row, as the store holds it. */
function storedFingerprint(row: StoredRow): string {
  return fingerprint({
    instrument: row.act,
    text: row.text,
    heading: row.heading,
    section: row.section,
    status: row.status,
    schedule: row.schedule,
    part: row.part,
    source_url: row.source_url,
    in_force: row.in_force,
    citation: row.citation,
  });
}

/** A literal, quoted the way SQLite wants it. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Run statements, and report how many rows each of them changed.
 *
 * The API takes one statement at a time — so a batch of statements is one
 * request with several statements in it, and the answer comes back as one
 * entry per statement.
 */
async function execute(sql: string): Promise<number> {
  const response = await fetchWithAuth(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`D1 refused the statements: ${response.status} ${body.slice(0, 300)}`);
  }
  const result = (await response.json()) as {
    success: boolean;
    result?: { success?: boolean; meta?: { changes?: number }; errors?: { message: string }[] }[];
    errors?: { message: string }[];
  };
  if (!result.success) {
    throw new Error(`D1 refused the statements: ${result.errors?.[0]?.message ?? 'unknown'}`);
  }
  let changes = 0;
  for (const statement of result.result ?? []) {
    if (statement.success === false) {
      throw new Error(`D1 refused a statement: ${statement.errors?.[0]?.message ?? 'unknown'}`);
    }
    changes += statement.meta?.changes ?? 0;
  }
  return changes;
}

/** The corpus's rows, from the local clone. */
function corpusHashes(): Map<string, string> {
  const hashes = new Map<string, string>();
  const dirs: [string, 'acts' | 'regulations', 'en' | 'fr'][] = [
    ['eng/acts', 'acts', 'en'],
    ['eng/regulations', 'regulations', 'en'],
    ['fra/lois', 'acts', 'fr'],
    ['fra/reglements', 'regulations', 'fr'],
  ];
  let files = 0;
  for (const [dir, kind, language] of dirs) {
    const path = join(CORPUS_DIR, dir);
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.xml')) continue;
      const stem = name.replace(/\.xml$/, '');
      const parsed = parseStatuteXml(readFileSync(join(path, name), 'utf8'), {
        citation: kind === 'regulations' ? stem : undefined,
      });
      if (!parsed) continue;
      files++;
      for (const row of buildRows(parsed, { kind, language })) {
        hashes.set(
          row.id,
          fingerprint({
            instrument: row.act,
            text: row.text,
            heading: row.heading,
            section: row.section,
            status: row.status,
            schedule: row.schedule,
            part: row.part,
            source_url: row.source_url,
            in_force: row.in_force,
            citation: row.citation,
          }),
        );
      }
    }
  }
  console.log(`the corpus clone holds ${files} instrument file(s) and ${hashes.size} provision(s)`);
  return hashes;
}

async function main(): Promise<void> {
  console.log(`backfilling the fingerprints of ${CORPUS_ID}`);

  const hashes = new Map<string, string>();
  let after = '';
  for (;;) {
    const rows = await query<StoredRow>(
      `SELECT id, act, citation, section, schedule, part, status, heading, text,
              source_url, in_force
         FROM statute_sections
        WHERE corpus_id = ? AND id > ?
        ORDER BY id
        LIMIT ?`,
      [CORPUS_ID, after, PAGE],
    );
    if (rows.length === 0) break;
    for (const row of rows) hashes.set(row.id, storedFingerprint(row));
    after = rows[rows.length - 1]!.id;
    if (hashes.size % 10_000 < PAGE) {
      console.log(`  ${hashes.size} row(s) read`);
    }
  }
  console.log(`${hashes.size} row(s) read and hashed`);

  if (compare) {
    const corpus = corpusHashes();
    let same = 0;
    let different = 0;
    let only = 0;
    const examples: string[] = [];
    for (const [id, hash] of hashes) {
      const other = corpus.get(id);
      if (other === undefined) {
        only++;
        if (examples.length < 5) examples.push(`${id}: in the store, not in the corpus`);
      } else if (other === hash) {
        same++;
      } else {
        different++;
        if (examples.length < 5) examples.push(`${id}: the store and the corpus disagree`);
      }
    }
    const missing = [...corpus.keys()].filter((id) => !hashes.has(id)).length;
    console.log(
      `  ${same} the same, ${different} different, ${only} only in the store, ${missing} only in the corpus`,
    );
    for (const example of examples) console.log(`    ${example}`);
  }

  if (dryRun) {
    console.log('dry run — nothing was written');
    return;
  }

  const statements = [...hashes].map(
    ([id, hash]) =>
      `UPDATE statute_sections SET text_hash = ${literal(hash)} WHERE id = ${literal(id)} AND corpus_id = ${literal(CORPUS_ID)};`,
  );

  let written = 0;
  let failed = 0;
  let next = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const start = next * BATCH;
      if (start >= statements.length) return;
      next++;
      const chunk = statements.slice(start, start + BATCH).join('\n');
      try {
        written += await execute(chunk);
      } catch (error) {
        failed += Math.min(BATCH, statements.length - start);
        console.error(`  a batch of ${BATCH} statement(s) failed: ${String(error).slice(0, 200)}`);
      }
      if ((written + failed) % 5_000 < BATCH) {
        console.log(`  ${written + failed} row(s) written`);
      }
    }
  });
  await Promise.all(workers);

  console.log(`${written} row(s) written, ${failed} failed`);
}

await main();
