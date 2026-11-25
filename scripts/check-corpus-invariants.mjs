#!/usr/bin/env node
/**
 * Corpus invariants.
 *
 * The corpus is the product, and the things that go wrong in it go wrong quietly:
 * a row whose id collides with another is replaced rather than added, a column the
 * insert names but the table does not have makes the load fail, and a provision
 * that is not law looks exactly like one that is until somebody cites it.
 *
 * Each check below is one of those failures, stated as an invariant.
 */
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const ROOT = new URL('..', import.meta.url).pathname;
const failures = [];
const notes = [];
const directoryArg = process.argv.indexOf('--exports');
const exportsDirectory = directoryArg < 0 ? join(ROOT, 'dist') : process.argv[directoryArg + 1];
if (!exportsDirectory) throw new Error('--exports requires a directory');
if (process.argv.includes('--require-exports')) {
  for (const file of ['statutes.sql', 'statutes-fr.sql', 'statutes.jsonl', 'statutes-fr.jsonl']) {
    if (!existsSync(join(exportsDirectory, file))) failures.push(`Missing required local export: ${file}`);
  }
}

/* ── 1. the schema and the insert must agree ───────────────────────────────── */

const migrationsDir = join(ROOT, 'migrations');
const migrationFiles = existsSync(migrationsDir)
  ? readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  : [];
const migrations = migrationFiles.map((f) => readFileSync(join(migrationsDir, f), 'utf8')).join('\n');

/** Ask SQLite for the schema after all migrations, including dropped columns. */
function statuteColumns() {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migrations);
    return new Set(db.prepare('PRAGMA table_info(statute_sections)').all().map(row => row.name));
  } finally { db.close(); }
}

function insertColumns(file) {
  const sqlPath = join(exportsDirectory, file);
  if (!existsSync(sqlPath)) return null;
  const fd = openSync(sqlPath, 'r');
  const header = Buffer.alloc(4096);
  let count;
  try { count = readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
  const first = header.toString('utf8', 0, count);
  const open = first.indexOf('(');
  const close = first.indexOf(')');
  if (!first.startsWith('INSERT ') || open === -1 || close <= open) throw new Error(`Invalid INSERT header in ${file}`);
  return new Set(first.slice(open + 1, close).split(',').map((c) => c.trim()));
}

/**
 * The columns the pipeline's store writes, from its own statement.
 *
 * The corpus has two writers: the ingest, which loads the corpus, and the
 * pipeline, which keeps it up to date. The pipeline writes the fingerprint
 * and the date of the revision that last changed a row — the two columns the
 * reconciliation depends on — so an invariant about what the table's columns
 * are written by has to know about both.
 */
function pipelineColumns() {
  const path = join(ROOT, 'src', 'corpora', 'd1-store.ts');
  if (!existsSync(path)) return null;
  const source = readFileSync(path, 'utf8');
  const match = /INSERT INTO statute_sections\s*\(([\s\S]*?)\)\s*VALUES/.exec(source);
  if (!match) return null;
  return new Set(match[1].split(',').map((c) => c.trim()));
}

const schema = statuteColumns();
const inserted = insertColumns('statutes.sql');
const pipeline = pipelineColumns();

if (!inserted) {
  notes.push('dist/statutes.sql is not present — skipped the schema check (run the ingest)');
} else {
  const missing = [...inserted].filter((c) => !schema.has(c));
  const written = new Set([...inserted, ...(pipeline ?? [])]);
  const extra = [...schema].filter((c) => !written.has(c));
  if (missing.length) {
    failures.push(
      `the ingest writes column(s) the table does not have: ${missing.join(', ')} — the load would fail`,
    );
  }
  if (extra.length) {
    failures.push(`the table has column(s) nothing writes: ${extra.join(', ')}`);
  }
  if (!missing.length && !extra.length) {
    notes.push(`the schema and the insert agree on ${inserted.size} columns`);
  }

  // The French rows go in the same table, so they have to write the same
  // columns — a French insert with a different shape would load a third of the
  // columns as null, which looks like data and is not.
  const frenchInserted = insertColumns('statutes-fr.sql');
  if (!frenchInserted) {
    notes.push('dist/statutes-fr.sql is not present — skipped the French schema check (run the ingest)');
  } else {
    const frenchMissing = [...frenchInserted].filter((c) => !inserted.has(c));
    const frenchExtra = [...inserted].filter((c) => !frenchInserted.has(c));
    if (frenchMissing.length || frenchExtra.length) {
      failures.push(
        `the French insert does not have the same columns as the English one` +
          (frenchMissing.length ? `; it writes ${frenchMissing.join(', ')} that the English does not` : '') +
          (frenchExtra.length ? `; it omits ${frenchExtra.join(', ')}` : ''),
      );
    } else {
      notes.push('the French insert has the same columns as the English one');
    }
  }
}

/* ── 2. the rows ──────────────────────────────────────────────────────────── */

/**
 * The corpus files, in the order they are loaded.
 *
 * The two languages are **one corpus**, and the store's primary key is the row
 * id. So the ids have to be unique across *both* files, not just within each:
 * an id that appears in the English rows and again in the French rows is not
 * two rows, it is one row replaced by another, and the corpus silently loses
 * half its content.
 */
const CORPUS_FILES = [
  { file: 'statutes.jsonl', language: 'en' },
  { file: 'statutes-fr.jsonl', language: 'fr' },
];

const ids = new Set();
const duplicates = [];
let rows = 0;
let placeholders = 0;
let repealed = 0;
const byLanguage = new Map();

for (const { file, language } of CORPUS_FILES) {
  const corpusPath = join(exportsDirectory, file);
  if (!existsSync(corpusPath)) {
    notes.push(`dist/${file} is not present — skipped its rows (run the ingest)`);
    continue;
  }
  let fileRows = 0;
  const lines = createInterface({ input: createReadStream(corpusPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    rows++;
    fileRows++;
    const row = JSON.parse(line);
    if (ids.has(row.id)) duplicates.push(row.id);
    ids.add(row.id);
    if (row.status === 'placeholder') placeholders++;
    if (row.status === 'repealed') repealed++;
    if (!row.status) {
      failures.push(`row ${row.id} has no status`);
      break;
    }
    // A row in the French file that says it is English is a row that will be
    // filtered out by the language lens and never found again.
    if (row.language !== language) {
      failures.push(
        `row ${row.id} is in ${file} but its language is "${row.language}" — the language lens would hide it`,
      );
      break;
    }
  }
  if (!fileRows) failures.push(`${file} contains no rows`);
  byLanguage.set(language, fileRows);
}

if (rows > 0) {
  if (duplicates.length) {
    failures.push(
      `${duplicates.length} row id(s) collide — the store would replace one with another: ` +
        duplicates.slice(0, 3).join(', '),
    );
  }
  const split = [...byLanguage.entries()].map(([l, n]) => `${n.toLocaleString()} ${l}`).join(', ');
  notes.push(
    `${rows.toLocaleString()} rows, ${ids.size.toLocaleString()} distinct ids (${split}), ` +
      `${placeholders.toLocaleString()} placeholders, ${repealed.toLocaleString()} repealed`,
  );

  /* ── 3. the index manifest ───────────────────────────────────────────────── */

  const manifestPath = join(exportsDirectory, 'statutes.emb.rows.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const unknown = manifest.filter((id) => !ids.has(id));
    if (unknown.length) {
      failures.push(`the index manifest names ${unknown.length} row(s) the corpus does not have`);
    }
    const placeholdersIndexed = manifest.filter((id) => id.startsWith('__placeholder__')).length;
    if (placeholdersIndexed) {
      failures.push(`${placeholdersIndexed} placeholder row(s) are in the index`);
    }
    notes.push(`the index holds ${manifest.length.toLocaleString()} of ${rows.toLocaleString()} rows`);
  }
}

if (failures.length) {
  console.error('corpus-invariants: FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('corpus-invariants: ok');
for (const note of notes) console.log(`  - ${note}`);
