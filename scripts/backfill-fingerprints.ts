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
const BATCH = 500;

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

/** The revision the local clone is at. */
function cloneRevision(): { commit: string; date: string } | null {
  const proc = Bun.spawnSync(
    ['git', '-C', CORPUS_DIR, 'log', '-1', '--format=%H%x00%cI'],
    { stdout: 'pipe', stderr: 'ignore' },
  );
  if (proc.exitCode !== 0) return null;
  const [commit, date] = proc.stdout.toString().trim().split('\0');
  if (!commit) return null;
  return { commit, date: (date ?? '').slice(0, 10) };
}

/**
 * Record the revision the store is at.
 *
 * The incremental cycle works by comparing the changed files now with the same
 * files at the revision the store holds — so the store has to *have* a
 * revision, and it has to be the right one: the revision the fingerprints
 * were computed from, which is the revision the local clone is at and the
 * revision the comparison above proved the store matches.
 */
async function recordRevision(rowCount: number): Promise<void> {
  const revision = cloneRevision();
  if (!revision) {
    console.log('the local clone has no revision — corpus_state was left alone');
    return;
  }
  await execute(
    `INSERT INTO corpus_state (corpus_id, commit_sha, commit_date, as_of, row_count, last_run_at)
     VALUES (${literal(CORPUS_ID)}, ${literal(revision.commit)}, ${literal(revision.date)}, ${literal(revision.date)}, ${rowCount}, ${literal(new Date().toISOString())})
     ON CONFLICT (corpus_id) DO UPDATE SET
       commit_sha = excluded.commit_sha,
       commit_date = excluded.commit_date,
       as_of = excluded.as_of,
       row_count = excluded.row_count,
       last_run_at = excluded.last_run_at;`,
  );
  console.log(`corpus_state records ${revision.commit.slice(0, 9)} (${revision.date})`);
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

  // Whether the store and the corpus are the same corpus.
  //
  // This is what decides whether the revision can be recorded: the revision
  // says "the store holds this corpus at this revision", and it can only say
  // that if the comparison agrees.
  let agrees = false;
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
    agrees = different === 0 && only === 0 && missing === 0;
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

  let sent = 0;
  let failed = 0;
  let next = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const start = next * BATCH;
      if (start >= statements.length) return;
      next++;
      const chunk = statements.slice(start, start + BATCH).join('\n');
      try {
        await execute(chunk);
        sent += Math.min(BATCH, statements.length - start);
      } catch (error) {
        failed += Math.min(BATCH, statements.length - start);
        console.error(`  a batch of ${BATCH} statement(s) failed: ${String(error).slice(0, 200)}`);
      }
      if ((sent + failed) % 5_000 < BATCH) {
        console.log(`  ${sent + failed} row(s) written`);
      }
    }
  });
  await Promise.all(workers);

  console.log(`${sent} row(s) written, ${failed} failed`);

  // **The count is the truth, not the number of statements sent.**
  //
  // D1 does not report the rows a multi-statement request changed — the
  // metadata it returns covers one statement — so a counter that adds up what
  // the API says reports a fraction of what happened and looks like a partial
  // failure. The question is whether every row has a fingerprint now, and only
  // the database can answer it.
  const counted = await query<{ total: number; hashed: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN text_hash IS NOT NULL THEN 1 ELSE 0 END) AS hashed
       FROM statute_sections
      WHERE corpus_id = ?`,
    [CORPUS_ID],
  );
  const total = counted[0]?.total ?? 0;
  const hashed = counted[0]?.hashed ?? 0;
  console.log(`${hashed} of ${total} row(s) in ${CORPUS_ID} have a fingerprint`);
  if (hashed !== total) {
    throw new Error(`${total - hashed} row(s) still have no fingerprint`);
  }

  if (agrees) {
    await recordRevision(total);
  } else if (compare) {
    console.log('the store and the corpus are not the same corpus — corpus_state was left alone');
  } else {
    console.log(
      'the corpus was not compared, so the revision was not recorded — run with --compare',
    );
  }
}

await main();
