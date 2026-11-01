import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTextSql, installReferenceSql, jsonLines, prepareSnapshotTextCutover, prepareTextCutover, readCutoverObject, recoverPreparedTextCutover, verifyTextCutover, type CutoverTextReference } from '../scripts/prepare-text-cutover';
import { IndexDigester } from '../src/ingest/snapshot-format';
import { COMPACT_CORPUS_SCHEMA, applyCompactRestorePage, compactPageDigest, type CompactRestorePage } from '../src/corpora/compact-restore';
import { createR2ProvisionTextStore, rowFingerprintWithText, writeImmutableProvisionText, type ProvisionTextReference } from '../src/corpora/text-store';
import { statutesCorpus } from '../src/corpora/adapters';
import { citeProvision } from '../src/mcp/cite';
import type { CorpusContext } from '../src/corpora/types';
import { testD1 } from './helpers/d1';
import { memoryTextBucket } from './helpers/text-bucket';
import { verifyTextRestore } from '../scripts/verify-text-restore';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const finish of cleanup.splice(0)) await finish(); });

async function firstJsonLine(path: string) {
  for await (const row of jsonLines(path)) return row;
  throw new Error('Fixture contains no rows.');
}

async function createCutoverFixture() {
  const root = await mkdtemp(join(tmpdir(), 'civicsignal-text-cutover-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const fixture = testD1();
  cleanup.push(fixture.close);
  for (const [language, text] of [['en', 'An original rule.'], ['fr', 'Une règle originale.']]) {
    const row: Record<string, unknown> = { id: `acts-${language}-1`, corpus_id: 'statutes-canada', act: 'Test Act', citation: 'T-1', section: '1',
      status: 'in-force', schedule: null, part: null, heading: null, text, source_url: `https://laws-lois.justice.gc.ca/${language}/acts/T-1/section-1.html`, in_force: 1 };
    const hash = rowFingerprintWithText(row, text);
    fixture.sqlite.prepare(`INSERT INTO statute_sections(id,corpus_id,act,citation,section,status,heading,text,source_url,in_force,language,text_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(String(row['id']), 'statutes-canada', 'Test Act', 'T-1', '1', 'in-force', null, text, String(row['source_url']), 1, language, hash);
  }
  const input = join(root, 'source.jsonl');
  await writeFile(input, fixture.sqlite.prepare('SELECT * FROM statute_sections ORDER BY id').all().map((row) => JSON.stringify(row)).join('\n') + '\n');
  const output = join(root, 'bundle');
  const revision = 'a'.repeat(40) + ':parser-v2';
  const ctx: CorpusContext = { db: fixture.db, fetch, now: () => new Date() };
  return { ...fixture, ...memoryTextBucket(), root, input, output, revision, ctx };
}

describe('offline text cutover bundle', () => {
  it('reads JSONL across bounded UTF-8 chunks and rejects malformed bytes and oversized rows', async () => {
    const fixture = await createCutoverFixture();
    const text = 'é'.repeat(40000);
    await writeFile(fixture.input, JSON.stringify({ id: 'a', text }) + '\n' + JSON.stringify({ id: 'b', text: 'after the boundary' }));
    const rows: Record<string, unknown>[] = [];
    for await (const row of jsonLines(fixture.input)) rows.push(row);
    expect(rows).toEqual([{ id: 'a', text }, { id: 'b', text: 'after the boundary' }]);
    await writeFile(fixture.input, new Uint8Array([0xff]));
    await expect(jsonLines(fixture.input).next()).rejects.toThrow();
    await writeFile(fixture.input, 'x'.repeat(16 * 1024 * 1024 + 1));
    await expect(jsonLines(fixture.input).next()).rejects.toThrow('size bound');
  });

  it('recovers interrupted local sealing without replacing a bundle or trusting an inconsistent source identity', async () => {
    const fixture = await createCutoverFixture();
    const manifest = await prepareTextCutover({ input: fixture.input, output: fixture.output, revision: fixture.revision, objectStorage: 'pack' });
    const stage = join(fixture.root, 'complete-stage');
    await rename(fixture.output, stage);
    await expect(recoverPreparedTextCutover({ stage, input: fixture.input, output: fixture.output, revision: 'b'.repeat(40) })).rejects.toThrow('sealed source');
    expect(await recoverPreparedTextCutover({ stage, input: fixture.input, output: fixture.output, revision: fixture.revision })).toEqual(manifest);
    await rename(fixture.output, stage);
    await rm(join(stage, 'manifest.json'));
    expect(await recoverPreparedTextCutover({ stage, input: fixture.input, output: fixture.output, revision: fixture.revision })).toMatchObject({ rowCount: 2, objectStorage: 'pack' });
    await expect(recoverPreparedTextCutover({ stage: fixture.output, input: fixture.input, output: fixture.output, revision: fixture.revision })).rejects.toThrow('already exists');
  });

  it('maps verified snapshot rows without XML parsing and rejects corrupted source parts', async () => {
    const fixture = await createCutoverFixture();
    const snapshot = join(fixture.root, 'snapshot');
    await mkdir(join(snapshot, 'snapshots', 'parser-v2'), { recursive: true });
    const prefix = `snapshots/parser-v2/${'a'.repeat(40)}`;
    const rows = fixture.sqlite.prepare('SELECT * FROM statute_sections ORDER BY id').all();
    let offset = 0;
    const digester = new IndexDigester();
    const index: string[] = [];
    const lines = rows.map((row) => {
      const line = JSON.stringify({ id: row['id'], corpusId: row['corpus_id'], instrument: row['act'], citation: row['citation'],
        section: row['section'], status: row['status'], schedule: row['schedule'], part: row['part'], heading: row['heading'], text: row['text'],
        source_url: row['source_url'], in_force: row['in_force'], language: row['language'], embedText: '', lastChanged: '2026-10-15' }) + '\n';
      const entry = { id: String(row['id']), fp: String(row['text_hash']), off: offset, len: Buffer.byteLength(line) };
      offset += entry.len; index.push(JSON.stringify(entry)); digester.add(entry); return line;
    }).join('');
    const indexText = index.join('\n') + '\n';
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    const partKey = prefix + '.rows.000.jsonl';
    await writeFile(join(snapshot, partKey), lines);
    await writeFile(join(snapshot, prefix + '.index.jsonl'), indexText);
    await writeFile(join(snapshot, prefix + '.manifest.json'), JSON.stringify({ format: 1, commit: 'a'.repeat(40), parser: 'parser-v2', date: '2026-10-15',
      rows: { count: 2, bytes: Buffer.byteLength(lines), partBytes: 2048, parts: [{ key: partKey, bytes: Buffer.byteLength(lines), sha256: sha(lines) }] },
      index: { key: prefix + '.index.jsonl', bytes: Buffer.byteLength(indexText), entries: 2, sha256: sha(indexText), digest: digester.digest() } }));
    expect(await prepareSnapshotTextCutover({ snapshot, output: fixture.output, revision: fixture.revision })).toMatchObject({ objectStorage: 'pack', rowCount: 2 });
    await writeFile(join(snapshot, partKey), lines.replace('original', 'tampered'));
    await expect(prepareSnapshotTextCutover({ snapshot, output: join(fixture.root, 'bad-source'), revision: fixture.revision })).rejects.toThrow('source part digest mismatch');
  });

  it('runs the standalone local fresh-store proof against every fixture row', async () => {
    const fixture = await createCutoverFixture();
    await prepareTextCutover({ input: fixture.input, output: fixture.output, revision: fixture.revision, objectStorage: 'pack' });
    const report = await verifyTextRestore({ bundle: fixture.output, output: join(fixture.root, 'proof') });
    expect(report).toMatchObject({ verifiedRows: 2, metadataDifferences: 0, sourceDatabaseUnchanged: true, semanticHydrationSamples: 2 });
    expect(await verifyTextRestore({ bundle: fixture.output, output: join(fixture.root, 'proof'), resume: true })).toMatchObject({
      verifiedRows: 2, metadataDifferences: 0, originalSha256: report.originalSha256, sourceDatabaseUnchanged: true });
    await expect(verifyTextRestore({ bundle: fixture.output, output: join(fixture.root, 'proof') })).rejects.toThrow('new output directory');
  });

  it('restores a fresh compact store with packed text, preserves bilingual exact/semantic reads and leaves the rollback store intact', async () => {
    const fixture = await createCutoverFixture();
    const original = fixture.sqlite.prepare('SELECT * FROM statute_sections ORDER BY id').all();
    const baseline = await Promise.all((['en', 'fr'] as const).map((language) => citeProvision({ act: 'Test Act', section: '1', language }, fixture.ctx)));
    const manifest = await prepareTextCutover({ input: fixture.input, output: fixture.output, revision: fixture.revision, objectStorage: 'pack' });
    const fresh = testD1({ schema: await readFile(join(fixture.output, 'fresh-corpus-schema.sql'), 'utf8') });
    cleanup.push(fresh.close);
    const identity = { bundleSha256: manifest.freshPagesSha256, revision: manifest.revision };
    for await (const value of jsonLines(join(fixture.output, 'fresh-pages.jsonl'))) {
      const page = value as unknown as CompactRestorePage;
      expect((await applyCompactRestorePage(fresh.db, page, identity)).skipped).toBe(false);
      expect((await applyCompactRestorePage(fresh.db, page, identity)).skipped).toBe(true);
    }
    expect(fresh.sqlite.prepare('SELECT count(*) AS count,sum(length(text)) AS bytes FROM statute_sections').get()).toMatchObject({ count: 2, bytes: 0 });
    expect(fresh.sqlite.prepare('PRAGMA table_info(statute_sections)').all().map((column) => column['name'])).not.toContain('search_text');
    const references = new Map<string, CutoverTextReference>();
    for await (const value of jsonLines(join(fixture.output, 'references.jsonl'))) {
      const reference = value as unknown as CutoverTextReference;
      references.set(reference.objectKey, reference);
    }
    const bucket = { async get(key: string) {
      const reference = references.get(key);
      if (!reference) return null;
      return { size: reference.bytes, body: new Response(await readCutoverObject(fixture.output, reference, manifest)).body! };
    } };
    const ctx: CorpusContext = { db: fresh.db, fetch, now: () => new Date(),
      provisionTexts: createR2ProvisionTextStore(fresh.db, bucket, 'r2'), embedQuery: async () => [0.1],
      vector: { async query(_vector, _count, filter) { return original.filter((row) => !filter?.['language'] || row['language'] === filter['language'])
        .map((row) => ({ id: String(row['id']), score: 0.99, metadata: {} })); } } };
    expect(await Promise.all((['en', 'fr'] as const).map((language) => citeProvision({ act: 'Test Act', section: '1', language }, ctx)))).toEqual(baseline);
    for (const language of ['en', 'fr'] as const) {
      const matches = await statutesCorpus.retrieve({ topic: 'original rule', language }, ctx);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.body).toBe(original.find((row) => row['language'] === language)?.['text']);
    }
    const compact = fresh.sqlite.prepare('SELECT * FROM statute_sections ORDER BY id').all();
    const hydrated = await ctx.provisionTexts!.hydrate(compact);
    expect(hydrated.map((row) => rowFingerprintWithText(row, String(row['text'])))).toEqual(original.map((row) => row['text_hash']));
    // Binding rollback uses the retained source database; it requires no text
    // rewrite and remains possible even after all packed objects disappear.
    references.clear();
    expect(fixture.sqlite.prepare('SELECT * FROM statute_sections ORDER BY id').all()).toEqual(original);
    expect(await Promise.all((['en', 'fr'] as const).map((language) => citeProvision({ act: 'Test Act', section: '1', language }, fixture.ctx)))).toEqual(baseline);
  });

  it('rejects populated stores, reordered pages, altered statements and a different restore identity', async () => {
    const fixture = await createCutoverFixture();
    const manifest = await prepareTextCutover({ input: fixture.input, output: fixture.output, revision: fixture.revision, objectStorage: 'pack' });
    const page = await firstJsonLine(join(fixture.output, 'fresh-pages.jsonl')) as unknown as CompactRestorePage;
    const fresh = testD1({ schema: COMPACT_CORPUS_SCHEMA });
    cleanup.push(fresh.close);
    const identity = { bundleSha256: manifest.freshPagesSha256, revision: manifest.revision };
    const outOfOrder = { ...page, page: 2 };
    outOfOrder.sha256 = await compactPageDigest({ page: outOfOrder.page, fromAfter: outOfOrder.fromAfter, through: outOfOrder.through, rows: outOfOrder.rows, statements: outOfOrder.statements });
    await expect(applyCompactRestorePage(fresh.db, outOfOrder, identity)).rejects.toThrow('cursor order');
    const bad = structuredClone(page);
    bad.statements[0]!.query = 'DELETE FROM statute_sections';
    await expect(applyCompactRestorePage(fresh.db, bad, identity)).rejects.toThrow('Unexpected compact restore statement');
    const sqlFailure = structuredClone(page);
    sqlFailure.statements[0]!.params[2] = null;
    sqlFailure.sha256 = await compactPageDigest({ page: sqlFailure.page, fromAfter: sqlFailure.fromAfter, through: sqlFailure.through, rows: sqlFailure.rows, statements: sqlFailure.statements });
    await expect(applyCompactRestorePage(fresh.db, sqlFailure, identity)).rejects.toThrow('NOT NULL');
    expect(fresh.sqlite.prepare('SELECT count(*) AS count FROM corpus_compact_restore').get()?.['count']).toBe(0);
    expect(fresh.sqlite.prepare('SELECT count(*) AS count FROM statute_sections').get()?.['count']).toBe(0);
    // The required marker tables and empty-target checks stop even a valid
    // restore plan from mutating the original database.
    fixture.sqlite.exec('CREATE TABLE corpus_compact_restore(id INTEGER PRIMARY KEY,bundle_sha256 TEXT,revision TEXT); CREATE TABLE corpus_compact_pages(page INTEGER PRIMARY KEY,sha256 TEXT,after_id TEXT,row_count INTEGER);');
    await expect(applyCompactRestorePage(fixture.db, page, identity)).rejects.toThrow('fresh empty');
    await applyCompactRestorePage(fresh.db, page, identity);
    await expect(applyCompactRestorePage(fresh.db, page, { ...identity, revision: 'another' })).rejects.toThrow('another compact restore');
    const altered = structuredClone(page);
    altered.statements[0]!.params[5] = 'unverified text';
    await expect(applyCompactRestorePage(fresh.db, altered, identity)).rejects.toThrow('identity mismatch');
  });

  it('proves bilingual old/new parity and bound-parameter rollback through actual read adapters', async () => {
    const fixture = await createCutoverFixture();
    const baseline = await Promise.all((['en', 'fr'] as const).map((language) => citeProvision({ act: 'Test Act', section: '1', language }, fixture.ctx)));
    const manifest = await prepareTextCutover({ input: fixture.input, output: fixture.output, revision: fixture.revision, createdAt: '2026-10-22T00:00:00Z' });
    expect(manifest).toMatchObject({ rowCount: 2, objectCount: 2 });
    expect(await verifyTextCutover(fixture.output)).toEqual(manifest);
    for await (const value of jsonLines(join(fixture.output, 'references.jsonl'))) {
      const reference = value as unknown as ProvisionTextReference;
      const bytes = new Uint8Array(await readFile(join(fixture.output, 'objects', reference.objectKey)));
      await writeImmutableProvisionText(fixture.bucket, { reference, bytes });
    }
    fixture.sqlite.exec(await readFile(join(fixture.output, 'install-references.sql'), 'utf8'));
    fixture.ctx.provisionTexts = createR2ProvisionTextStore(fixture.db, fixture.bucket, 'verify');
    expect(await Promise.all((['en', 'fr'] as const).map((language) => citeProvision({ act: 'Test Act', section: '1', language }, fixture.ctx)))).toEqual(baseline);
    fixture.sqlite.exec(await readFile(join(fixture.output, 'clear-text.sql'), 'utf8'));
    expect(fixture.sqlite.prepare('SELECT sum(length(text)) AS bytes FROM statute_sections').get()?.bytes).toBe(0);
    fixture.ctx.provisionTexts = createR2ProvisionTextStore(fixture.db, fixture.bucket, 'r2');
    expect(await Promise.all((['en', 'fr'] as const).map((language) => citeProvision({ act: 'Test Act', section: '1', language }, fixture.ctx)))).toEqual(baseline);
    for await (const rollback of jsonLines(join(fixture.output, 'rollback-bindings.jsonl'))) {
      fixture.sqlite.prepare(String(rollback['query'])).run(...rollback['params'] as (string | number | null)[]);
    }
    fixture.ctx.provisionTexts = createR2ProvisionTextStore(fixture.db, fixture.bucket, 'd1');
    fixture.objects.clear();
    expect(await Promise.all((['en', 'fr'] as const).map((language) => citeProvision({ act: 'Test Act', section: '1', language }, fixture.ctx)))).toEqual(baseline);
  });

  it('does not overwrite existing bundles or accept reordered, duplicate or tampered input', async () => {
    const fixture = await createCutoverFixture();
    await prepareTextCutover({ input: fixture.input, output: fixture.output, revision: fixture.revision });
    await expect(prepareTextCutover({ input: fixture.input, output: fixture.output, revision: fixture.revision })).rejects.toThrow('already exists');
    const lines = (await readFile(fixture.input, 'utf8')).trim().split('\n');
    await writeFile(fixture.input, [...lines].reverse().join('\n'));
    await expect(prepareTextCutover({ input: fixture.input, output: join(fixture.root, 'unsorted'), revision: fixture.revision })).rejects.toThrow('unique ascending');
    await writeFile(fixture.input, lines[0] + '\n' + lines[0] + '\n');
    await expect(prepareTextCutover({ input: fixture.input, output: join(fixture.root, 'duplicate'), revision: fixture.revision })).rejects.toThrow('unique ascending');
    const wrong = JSON.parse(lines[0]!) as Record<string, unknown>;
    wrong['text'] = 'Tampered text without a matching row fingerprint.';
    await writeFile(fixture.input, JSON.stringify(wrong) + '\n');
    await expect(prepareTextCutover({ input: fixture.input, output: join(fixture.root, 'tampered'), revision: fixture.revision })).rejects.toThrow('fingerprint-verified');
  });

  it('detects corruption of immutable objects and executable plans before cutover', async () => {
    const fixture = await createCutoverFixture();
    await prepareTextCutover({ input: fixture.input, output: fixture.output, revision: fixture.revision });
    const reference = await firstJsonLine(join(fixture.output, 'references.jsonl')) as unknown as ProvisionTextReference;
    await writeFile(join(fixture.output, 'objects', reference.objectKey), 'corrupt');
    await expect(verifyTextCutover(fixture.output)).rejects.toThrow(/object (?:size|parity) mismatch/);
    const next = join(fixture.root, 'plan-tamper');
    await prepareTextCutover({ input: fixture.input, output: next, revision: fixture.revision });
    await writeFile(join(next, 'install-references.sql'), 'DROP TABLE statute_sections;');
    await expect(verifyTextCutover(next)).rejects.toThrow('artifact digest mismatch');
  });

  it('keeps changed rows safe from stale reference install, clearing and rollback', async () => {
    const fixture = await createCutoverFixture();
    await prepareTextCutover({ input: fixture.input, output: fixture.output, revision: fixture.revision });
    const reference = await firstJsonLine(join(fixture.output, 'references.jsonl')) as unknown as ProvisionTextReference;
    const updated = 'A later revision already changed this row.';
    fixture.sqlite.prepare('UPDATE statute_sections SET text=?,text_hash=? WHERE id=?').run(updated, 'b'.repeat(32), reference.rowId);
    fixture.sqlite.exec(installReferenceSql(reference));
    expect(fixture.sqlite.prepare('SELECT count(*) AS count FROM statute_text_refs').get()?.count).toBe(0);
    fixture.sqlite.exec(clearTextSql(reference));
    expect(fixture.sqlite.prepare('SELECT text FROM statute_sections WHERE id=?').get(reference.rowId)?.text).toBe(updated);
    const rollback = await firstJsonLine(join(fixture.output, 'rollback-bindings.jsonl'));
    fixture.sqlite.prepare(String(rollback['query'])).run(...rollback['params'] as (string | number | null)[]);
    expect(fixture.sqlite.prepare('SELECT text FROM statute_sections WHERE id=?').get(reference.rowId)?.text).toBe(updated);
  });
});

