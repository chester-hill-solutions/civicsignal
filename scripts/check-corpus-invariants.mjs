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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const failures = [];
const notes = [];

/* ── 1. the schema and the insert must agree ───────────────────────────────── */

const migrationsDir = join(ROOT, 'migrations');
const migrationFiles = existsSync(migrationsDir)
  ? readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  : [];
const migrations = migrationFiles.map((f) => readFileSync(join(migrationsDir, f), 'utf8')).join('\n');

/** Every column the statute table has, from CREATE TABLE and from ALTER TABLE. */
function schemaColumns(table) {
  const columns = new Set();
  const create = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\n\\);`).exec(migrations);
  if (create) {
    for (const line of create[1].split('\n')) {
      const match = /^\s*([a-z_]+)\s+[A-Z]/.exec(line);
      if (match) columns.add(match[1]);
    }
  }
  const alter = new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN\\s+([a-z_]+)`, 'g');
  let match;
  while ((match = alter.exec(migrations)) !== null) columns.add(match[1]);
  return columns;
}

function insertColumns(file) {
  const sqlPath = join(ROOT, 'dist', file);
  if (!existsSync(sqlPath)) return null;
  const first = readFileSync(sqlPath, 'utf8').split('\n')[0] ?? '';
  const open = first.indexOf('(');
  const close = first.indexOf(')');
  if (open === -1 || close === -1) return null;
  return new Set(first.slice(open + 1, close).split(',').map((c) => c.trim()));
}

const schema = schemaColumns('statute_sections');
const inserted = insertColumns('statutes.sql');

if (!inserted) {
  notes.push('dist/statutes.sql is not present — skipped the schema check (run the ingest)');
} else {
  const missing = [...inserted].filter((c) => !schema.has(c));
  const extra = [...schema].filter((c) => !inserted.has(c));
  if (missing.length) {
    failures.push(
      `the ingest writes column(s) the table does not have: ${missing.join(', ')} — the load would fail`,
    );
  }
  if (extra.length) {
    failures.push(`the table has column(s) the ingest never writes: ${extra.join(', ')}`);
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
  const corpusPath = join(ROOT, 'dist', file);
  if (!existsSync(corpusPath)) {
    notes.push(`dist/${file} is not present — skipped its rows (run the ingest)`);
    continue;
  }
  let fileRows = 0;
  for (const line of readFileSync(corpusPath, 'utf8').split('\n')) {
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

  const manifestPath = join(ROOT, 'dist', 'statutes.emb.rows.json');
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
