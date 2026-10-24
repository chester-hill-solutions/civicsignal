/** Full local restore/audit of an offline bundle. Never contacts Cloudflare. */
import { createRequire } from 'node:module';
import type { DatabaseSync as SqliteDatabase, SQLInputValue } from 'node:sqlite';
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonLines, sha256File, verifyTextCutover } from './prepare-text-cutover';
import { FileTextBucket, type PackedTextLocation } from './lib/file-text-bucket';
import { localD1 } from './lib/local-d1';
import { applyCompactRestorePage, COMPACT_CORPUS_SCHEMA, COMPACT_STATUTE_COLUMNS, INSERT_COMPACT_STATUTE_SQL, type CompactRestorePage } from '../src/corpora/compact-restore';
import { auditProvisionTextPage, createR2ProvisionTextStore, type TextParityCheckpoint } from '../src/corpora/text-store';
import { citeProvision } from '../src/mcp/cite';
import { statutesCorpus } from '../src/corpora/adapters';
import type { CorpusContext } from '../src/corpora/types';

// Bun 1.3 supplies bun:sqlite; Node supplies node:sqlite. Both implement the
// prepare/exec/close boundary used by localD1, with the same scalar bindings.
const sqliteModule = createRequire(import.meta.url)(process.versions['bun'] ? 'bun:sqlite' : 'node:sqlite') as {
  Database: typeof SqliteDatabase; DatabaseSync: typeof SqliteDatabase;
};
const DatabaseSync = process.versions['bun'] ? sqliteModule.Database : sqliteModule.DatabaseSync;
export async function verifyTextRestore(options: { bundle: string; output: string; resume?: boolean; onProgress?: (message: string) => void }) {
  const bundle = resolve(options.bundle);
  const output = resolve(options.output);
  const existing = await lstat(output).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && !options.resume) {
    throw new Error('Restore validation requires a new output directory.');
  }
  if (options.resume && !existing?.isDirectory()) throw new Error('Resume requires an existing local restore directory.');
  options.onProgress?.('Verifying the immutable bundle before local restore.');
  const manifest = await verifyTextCutover(bundle, options.onProgress);
  await mkdir(output, { recursive: true });
  const originalPath = join(output, 'original.sqlite');
  const freshPath = join(output, 'compact.sqlite');
  if (options.resume) for (const name of ['original.sqlite','compact.sqlite','object-locations.sqlite']) {
    if (!(await stat(join(output, name))).isFile()) throw new Error('The completed local restore files are required for resume.');
  }
  const original = new DatabaseSync(originalPath);
  const fresh = new DatabaseSync(freshPath);
  const index = new DatabaseSync(join(output, 'object-locations.sqlite'));
  let bucket: FileTextBucket | undefined;
  let originalClosed = false;
  let freshClosed = false;
  let indexClosed = false;
  try {
    if (!options.resume) {
      original.exec(COMPACT_CORPUS_SCHEMA);
      fresh.exec(await readFile(join(bundle, 'fresh-corpus-schema.sql'), 'utf8'));
    }
    const insert = original.prepare(INSERT_COMPACT_STATUTE_SQL);
    let originalCount = 0;
    const originalLookup = original.prepare(`SELECT ${COMPACT_STATUTE_COLUMNS.join(',')} FROM statute_sections WHERE id=?`);
    if (!options.resume) original.exec('BEGIN');
    try {
      for await (const row of jsonLines(join(bundle, 'backup.jsonl'))) {
        const values = COMPACT_STATUTE_COLUMNS.map((name) => row[name] ?? null);
        if (options.resume) {
          const current = originalLookup.get(String(row['id']));
          if (!current || JSON.stringify(COMPACT_STATUTE_COLUMNS.map((name) => current[name])) !== JSON.stringify(values)) throw new Error('The retained original differs from the verified backup.');
        } else insert.run(...values as SQLInputValue[]);
        originalCount++;
      }
      if (!options.resume) original.exec('COMMIT');
    } catch (error) { if (!options.resume) original.exec('ROLLBACK'); throw error; }
    if (originalCount !== manifest.rowCount) throw new Error('Original-store row count mismatch.');
    const sourceSamples = original.prepare(`SELECT * FROM statute_sections WHERE citation='C-6' AND section='8' AND status='in-force' AND heading IS NOT NULL ORDER BY language,id LIMIT 2`).all();
    const samples = sourceSamples.length === 2 ? sourceSamples : original.prepare('SELECT * FROM statute_sections ORDER BY id LIMIT 2').all();
    const originalContext: CorpusContext = { db: localD1(original), fetch, now: () => new Date() };
    const baseline = await Promise.all(samples.map((row) => citeProvision({ act: String(row['act']), section: String(row['section']),
      language: row['language'] === 'fr' ? 'fr' : 'en' }, originalContext)));
    original.close(); originalClosed = true;
    const originalDigest = await sha256File(originalPath);
    const db = localD1(fresh);
    let restored = 0;
    let maxRestorePageBytes = 0;
    if (options.resume) {
      const marker = fresh.prepare('SELECT bundle_sha256,revision FROM corpus_compact_restore WHERE id=1').get();
      const pages = fresh.prepare('SELECT count(*) AS pages,sum(row_count) AS rows FROM corpus_compact_pages').get();
      if (marker?.['bundle_sha256'] !== manifest.freshPagesSha256 || marker['revision'] !== manifest.revision ||
          Number(pages?.['pages']) !== manifest.freshPageCount || Number(pages?.['rows']) !== manifest.rowCount) throw new Error('Resume requires the same fully restored bundle and page journal.');
    }
    for await (const value of jsonLines(join(bundle, 'fresh-pages.jsonl'))) {
      const page = value as unknown as CompactRestorePage;
      maxRestorePageBytes = Math.max(maxRestorePageBytes, Buffer.byteLength(JSON.stringify(page)));
      if (!options.resume) await applyCompactRestorePage(db, page, { bundleSha256: manifest.freshPagesSha256, revision: manifest.revision });
      restored += page.rows;
      if (restored % 25000 < 16) options.onProgress?.(`${options.resume ? 'Checked' : 'Restored'} ${restored} metadata rows.`);
    }
    if (restored !== manifest.rowCount) throw new Error('Compact-store restore count mismatch.');
    // Publication/history/auth copies are a separate protected-backup operation.
    // This local corpus proof supplies only the state needed for the strict audit.
    let uniqueBytes: number;
    let uniqueCount: number;
    if (!options.resume) {
      const pipelineSchema = await readFile(resolve('migrations/0003_pipeline.sql'), 'utf8');
      fresh.exec(pipelineSchema.slice(pipelineSchema.indexOf('CREATE TABLE IF NOT EXISTS corpus_state')));
      fresh.exec(await readFile(resolve('migrations/0006_corpus_mutations.sql'), 'utf8'));
      fresh.exec(await readFile(resolve('migrations/0008_corpus_parser.sql'), 'utf8'));
      const [source, parser = 'legacy'] = manifest.revision.split(':');
      const publication=manifest.publication??{commit:source!,parser:parser==='legacy'?null:parser,date:manifest.createdAt.slice(0,10),asOf:manifest.createdAt,lastRunAt:manifest.createdAt};
      fresh.prepare(`INSERT INTO corpus_state(corpus_id,commit_sha,commit_date,as_of,row_count,last_run_at,parser_version) VALUES(?,?,?,?,?,?,?)`)
        .run('statutes-canada', publication.commit, publication.date, publication.asOf, manifest.rowCount, publication.lastRunAt, publication.parser);
      index.exec('CREATE TABLE locations(object_key TEXT PRIMARY KEY,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,offset INTEGER); BEGIN;');
      const locationInsert = index.prepare('INSERT INTO locations VALUES(?,?,?,?)');
      uniqueBytes = 0; uniqueCount = 0;
      try {
        for await (const row of jsonLines(join(bundle, 'object-index.jsonl'))) {
          locationInsert.run(String(row['objectKey']), String(row['contentSha256']), Number(row['bytes']), row['packOffset'] == null ? null : Number(row['packOffset']));
          uniqueCount++; uniqueBytes += Number(row['bytes']);
        }
        index.exec('COMMIT');
      } catch (error) { index.exec('ROLLBACK'); throw error; }
    } else {
      const counts = index.prepare('SELECT count(*) AS count,sum(bytes) AS bytes FROM locations').get();
      uniqueCount = Number(counts?.['count']); uniqueBytes = Number(counts?.['bytes']);
    }
    if (uniqueCount !== manifest.objectCount || uniqueBytes !== manifest.objectsBytes) throw new Error('Object locator count mismatch.');
    const lookup = index.prepare('SELECT object_key AS objectKey,sha256 AS contentSha256,bytes,offset AS packOffset FROM locations WHERE object_key=?');
    bucket = await FileTextBucket.open(bundle, manifest, (key) => lookup.get(key) as unknown as PackedTextLocation | undefined);
    let checkpoint: TextParityCheckpoint | undefined;
    options.onProgress?.('Starting the complete strict R2 audit.');
    do {
      checkpoint = await auditProvisionTextPage(db, bucket, { expectedRevision: manifest.revision, mode: 'r2', checkpoint });
      if (checkpoint.rowsVerified % 25000 < 8 || checkpoint.complete) options.onProgress?.(`Verified ${checkpoint.rowsVerified} strict R2 metadata/text pairs.`);
    } while (!checkpoint.complete);
    if (checkpoint.bytesVerified !== manifest.textBytes) throw new Error('Hydrated text byte count mismatch.');
    fresh.prepare('ATTACH DATABASE ? AS original').run(originalPath);
    const metadataColumns = COMPACT_STATUTE_COLUMNS.filter((name) => name !== 'text');
    const differences = fresh.prepare(`SELECT count(*) AS count FROM statute_sections c LEFT JOIN original.statute_sections o ON c.id=o.id WHERE o.id IS NULL OR ${metadataColumns.map((name) => `c.${name} IS NOT o.${name}`).join(' OR ')}`).get();
    if (Number(differences?.['count']) !== 0) throw new Error('Restored metadata differs from the original store.');
    if (Number(fresh.prepare('SELECT count(*) AS count FROM statute_sections WHERE text<>?').get('')?.['count']) !== 0) throw new Error('Compact store unexpectedly contains provision text.');
    fresh.exec('DETACH DATABASE original');
    const ctx: CorpusContext = { db, fetch, now: () => new Date(), provisionTexts: createR2ProvisionTextStore(db, bucket, 'r2'),
      embedQuery: async () => [1], vector: { async query(_vector, _limit, filter) { return samples.filter((row) => !filter?.['language'] || row['language'] === filter['language'])
        .map((row) => ({ id: String(row['id']), score: 0.99, metadata: {} })); } } };
    for (let at = 0; at < samples.length; at++) {
      const row = samples[at]!;
      const language = row['language'] === 'fr' ? 'fr' : 'en';
      const exact = await citeProvision({ act: String(row['act']), section: String(row['section']), language }, ctx);
      if (JSON.stringify(exact) !== JSON.stringify(baseline[at])) throw new Error('Restored exact citation parity failed.');
      const semantic = await statutesCorpus.retrieve({ topic: 'public administration', language }, ctx);
      if (!semantic.some((item) => item.id === row['id'] && item.body === row['text'])) throw new Error('Restored shared semantic hydration failed.');
    }
    await bucket.close(); bucket = undefined;
    fresh.close(); freshClosed = true;
    index.close(); indexClosed = true;
    if (await sha256File(originalPath) !== originalDigest) throw new Error('Rollback database was modified by the restore proof.');
    const originalBytes = (await stat(originalPath)).size;
    const compactBytes = (await stat(freshPath)).size;
    const report = { format: 1, revision: manifest.revision, verifiedRows: checkpoint.rowsVerified, verifiedTextBytes: checkpoint.bytesVerified,
      metadataDifferences: Number(differences?.['count']), sourceDatabaseUnchanged: true, originalSha256: originalDigest,
      exactSamples: samples.map((row) => ({ id: row['id'], citation: row['citation'], section: row['section'], language: row['language'] })),
      semanticHydrationSamples: samples.length, originalBytes, compactBytes, savedBytes: originalBytes - compactBytes,
      restorePages: manifest.freshPageCount, maxRestorePageBytes, maxRestoreStatements: 34,
      savedPercent: Number(((1 - compactBytes / originalBytes) * 100).toFixed(2)),
      protectedState: 'Local corpus proof only; production auth/workspace/history must be copied and checked from one protected backup before binding changes.',
      evidence: 'Local SQLite and bounded packed-object reader; no live D1/R2/Vectorize mutation or encoder calls.' };
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  } catch (error) {
    // Keep failed evidence reviewable. Never remove a caller's earlier bundle.
    await writeFile(join(output, 'failed.txt'), error instanceof Error ? error.message + '\n' : 'Restore proof failed.\n');
    throw error;
  } finally {
    await bucket?.close();
    if (!originalClosed) original.close();
    if (!freshClosed) fresh.close();
    if (!indexClosed) index.close();
  }
}

if (process.argv[1] && /(?:^|[/\\])verify-text-restore\.(?:ts|mjs)$/.test(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!(args.length === 4 || args.length === 5 && args[4] === '--resume') || args[0] !== '--bundle' || args[2] !== '--output' || !args[1] || !args[3]) {
    console.error('Use --bundle <verified bundle directory> --output <local validation directory> [--resume].'); process.exitCode = 1;
  } else verifyTextRestore({ bundle: args[1], output: args[3], resume: args[4] === '--resume', onProgress: (message) => console.error(message) })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => { console.error(error instanceof Error ? error.message : 'Local restore failed.'); process.exitCode = 1; });
}
