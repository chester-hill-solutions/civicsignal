/** Prepare and verify a local, immutable text-cutover bundle. Never contacts Cloudflare. */
import { lstat, mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnapshotReader } from '../src/ingest/snapshot-source';
import type { SnapshotIndexEntry } from '../src/ingest/snapshot-diff';
import { FileSnapshotBucket } from './lib/file-snapshot';
import { sha256File } from './lib/file-integrity';
import { verifyLegacyReceipt } from './lib/legacy-receipt';
import { IndexDigester } from '../src/ingest/snapshot-format';
import { MAX_PROVISION_TEXT_BYTES, prepareProvisionText, provisionTextKey, rowFingerprintWithText, textSha256,
  textReferenceBindings, UPSERT_TEXT_REFERENCE_SQL, type ProvisionTextReference } from '../src/corpora/text-store';
import { COMPACT_CORPUS_SCHEMA, COMPACT_STATUTE_COLUMNS, compactPageDigest, INSERT_COMPACT_STATUTE_SQL,
  verifyCompactRestorePage, type CompactRestorePage, type CompactRestoreStatement } from '../src/corpora/compact-restore';

export interface TextCutoverManifest {
  format: 2;
  corpusId: 'statutes-canada';
  revision: string;
  createdAt: string;
  rowCount: number;
  objectCount: number;
  textBytes: number;
  inputSha256: string;
  referencesSha256: string;
  backupSha256: string;
  clearPlanSha256: string;
  installPlanSha256: string;
  rollbackBindingsSha256: string;
  freshSchemaSha256: string;
  freshPagesSha256: string;
  freshPageCount: number;
  objectStorage: 'files' | 'pack';
  objectsBytes: number;
  objectPackSha256?: string;
  objectIndexSha256: string;
  freshPagesChainSha256?: string;
  publication?: { commit: string; parser: string | null; date: string; asOf: string; lastRunAt: string; rows: number };
  sourceReceiptSha256?: string;
  procedure: string[];
}

export interface CutoverTextReference extends ProvisionTextReference { packOffset?: number }

export { sha256File } from './lib/file-integrity';
export async function* jsonLines(path: string): AsyncGenerator<Record<string, unknown>> {
  const input = await open(path, 'r');
  const buffer = new Uint8Array(64 * 1024);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let pending = '';
  let offset = 0;
  function parse(line: string): Record<string, unknown> {
    if (line.length > 16 * 1024 * 1024) throw new Error('Cutover input row exceeds the size bound.');
    const value = JSON.parse(line) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cutover input must contain JSON objects.');
    return value as Record<string, unknown>;
  }
  try {
    for (;;) {
      const read = await input.read(buffer, 0, buffer.byteLength, offset);
      offset += read.bytesRead;
      pending += decoder.decode(buffer.subarray(0, read.bytesRead), { stream: read.bytesRead !== 0 });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim()) yield parse(line);
      }
      if (pending.length > 16 * 1024 * 1024) throw new Error('Cutover input row exceeds the size bound.');
      if (!read.bytesRead) { if (pending.trim()) yield parse(pending); break; }
    }
  } finally { await input.close(); }
}

function quoted(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

/** A metadata compare-and-swap prevents a stale export from clearing newer text. */
export function clearTextSql(reference: ProvisionTextReference): string {
  return `UPDATE statute_sections SET text='' WHERE id=${quoted(reference.rowId)} AND corpus_id=${quoted(reference.corpusId)} AND text_hash=${quoted(reference.rowFingerprint)} AND EXISTS (SELECT 1 FROM statute_text_refs WHERE row_id=${quoted(reference.rowId)} AND row_fingerprint=${quoted(reference.rowFingerprint)} AND content_sha256=${quoted(reference.contentSha256)} AND object_key=${quoted(reference.objectKey)});`;
}

export function installReferenceSql(reference: ProvisionTextReference): string {
  return `INSERT INTO statute_text_refs(row_id,corpus_id,row_fingerprint,content_sha256,object_key,bytes,created_at)
SELECT ${quoted(reference.rowId)},${quoted(reference.corpusId)},${quoted(reference.rowFingerprint)},${quoted(reference.contentSha256)},${quoted(reference.objectKey)},${reference.bytes},${quoted(reference.createdAt)}
WHERE EXISTS (SELECT 1 FROM statute_sections WHERE id=${quoted(reference.rowId)} AND corpus_id=${quoted(reference.corpusId)} AND text_hash=${quoted(reference.rowFingerprint)})
ON CONFLICT(row_id) DO UPDATE SET corpus_id=excluded.corpus_id,row_fingerprint=excluded.row_fingerprint,content_sha256=excluded.content_sha256,object_key=excluded.object_key,bytes=excluded.bytes,created_at=excluded.created_at;`;
}

async function sealPreparedBundle(directory: string, options: {
  input: string; revision: string; createdAt: string; rowCount: number; objectCount: number; textBytes: number;
  freshPageCount: number; objectStorage: 'files' | 'pack'; objectsBytes: number; onProgress?: (message: string) => void;
  freshPagesChainSha256?: string; publication?: TextCutoverManifest['publication']; sourceReceipt?: string;
}): Promise<TextCutoverManifest> {
  async function hash(path: string) {
    options.onProgress?.(`Hashing ${path.slice(path.lastIndexOf('/') + 1)}.`);
    return sha256File(path);
  }
    const manifest: TextCutoverManifest = {
      format: 2, corpusId: 'statutes-canada', revision: options.revision, createdAt: options.createdAt, rowCount: options.rowCount,
      objectCount: options.objectCount, textBytes: options.textBytes, inputSha256: await hash(options.input),
      referencesSha256: await hash(join(directory, 'references.jsonl')), backupSha256: await hash(join(directory, 'backup.jsonl')),
      clearPlanSha256: await hash(join(directory, 'clear-text.sql')), rollbackBindingsSha256: await hash(join(directory, 'rollback-bindings.jsonl')),
      installPlanSha256: await hash(join(directory, 'install-references.sql')),
      freshSchemaSha256: await hash(join(directory, 'fresh-corpus-schema.sql')), freshPagesSha256: await hash(join(directory, 'fresh-pages.jsonl')),
      freshPageCount: options.freshPageCount, objectStorage: options.objectStorage, objectsBytes: options.objectsBytes,
      ...(options.objectStorage === 'pack' ? { objectPackSha256: await hash(join(directory, 'objects.pack')) } : {}),
      objectIndexSha256: await hash(join(directory, 'object-index.jsonl')),
      ...(options.freshPagesChainSha256 ? { freshPagesChainSha256: options.freshPagesChainSha256 } : {}),
      ...(options.publication ? { publication: options.publication } : {}),
      ...(options.sourceReceipt ? { sourceReceiptSha256: await hash(join(directory, 'source-receipt.json')) } : {}),
      procedure: [
        'Retain this verified bundle and an independent D1 backup before changing production.',
        'Stream object-index.jsonl. Read each bounded object from objects.pack at packOffset/bytes (or objects/<objectKey> in file mode), upload it under objectKey with conditional immutable creation, and verify remote byte count and SHA-256.',
        'Apply the additive reference-table migration, then install-references.sql (fingerprint compare-and-swap).',
        'Enable verify mode and prove complete old/new parity against the same published source and parser revision.',
        'Enable prefer-r2 while D1 text remains intact; observe real routes, cache hits and provider failures.',
        'For the optional in-place path only, execute clear-text.sql after approval and verify strict r2 reads for every current row. This path does not physically compact D1.',
        'For physical storage reduction, leave the original database unchanged. Create a fresh D1 after approval, apply fresh-corpus-schema.sql and the checked bound-write pages in fresh-pages.jsonl. Plain inserts and page journals prevent source-store updates and support retries.',
        'Copy publication state, change/run history and protected auth/workspace tables from the same consistent backup; verify identities, allowances and histories. Keep the existing Vectorize index and usage Durable Object namespace.',
        'Audit all current metadata/text pairs on the fresh store before switching the corpus binding; retain the original database unchanged as rollback.',
        'Fresh-store rollback restores the original binding. For in-place rollback, restore current-row text with rollback-bindings.jsonl before switching to d1; rows changed after export require a fresh verified backup from their current R2 references.',
      ],
    };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

export async function prepareTextCutover(options: { input: string; output: string; revision: string; createdAt?: string; objectStorage?: 'files' | 'pack'; onProgress?: (message: string) => void; publication?: TextCutoverManifest['publication']; sourceReceipt?: string }): Promise<TextCutoverManifest> {
  if (!/^[a-f0-9]{40}(?::[A-Za-z0-9._-]{1,100})?$/.test(options.revision)) throw new Error('Supply the published source SHA and optional parser version as --revision.');
  const output = resolve(options.output);
  const existing = await lstat(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) throw new Error('The cutover output directory already exists; verify and reuse it or select a new destination.');
  const temp = join(dirname(output), `.text-cutover-${randomUUID()}`);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(temp);
  const createdAt = options.createdAt ?? new Date().toISOString();
  if (options.publication) await writeFile(join(temp,'publication.json'),JSON.stringify(options.publication)+'\n',{flag:'wx'});
  if (options.sourceReceipt) await writeFile(join(temp,'source-receipt.json'),await readFile(options.sourceReceipt),{flag:'wx'});
  const objectStorage = options.objectStorage ?? 'files';
  if (objectStorage !== 'files' && objectStorage !== 'pack') throw new Error('Object storage must be files or pack.');
  const files = await Promise.all(['references.jsonl', 'backup.jsonl', 'clear-text.sql', 'install-references.sql', 'rollback-bindings.jsonl', 'fresh-pages.jsonl', 'object-index.jsonl', ...(objectStorage === 'pack' ? ['objects.pack'] : [])].map((name) => open(join(temp, name), 'wx')));
  let count = 0;
  let textBytes = 0;
  let lastId = '';
  const objects = new Map<string, number>();
  let objectBytes = 0;
  let pageCount = 0;
  let fromAfter = '';
  let pageRows = 0;
  let statements: CompactRestoreStatement[] = [];
  let freshPagesChainSha256 = '0'.repeat(64);
  async function flushPage() {
    if (!pageRows) return;
    const page = { page: ++pageCount, fromAfter, through: lastId, rows: pageRows, statements };
    const sha256 = await compactPageDigest(page);
    freshPagesChainSha256 = await textSha256(new Uint8Array(new TextEncoder().encode(freshPagesChainSha256 + sha256)));
    await files[5]!.writeFile(JSON.stringify({ ...page, sha256 }) + '\n');
    fromAfter = lastId; pageRows = 0; statements = [];
  }
  try {
    for await (const row of jsonLines(options.input)) {
      const id = row['id'];
      const text = row['text'];
      const fingerprint = row['text_hash'];
      if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) || id <= lastId ||
          row['corpus_id'] !== 'statutes-canada' || typeof text !== 'string' || typeof fingerprint !== 'string' ||
          rowFingerprintWithText(row, text) !== fingerprint) {
        throw new Error('Input rows must be complete, fingerprint-verified federal statute rows in unique ascending id order.');
      }
      lastId = id;
      const artifact = await prepareProvisionText({ rowId: id, corpusId: 'statutes-canada', rowFingerprint: fingerprint, text, createdAt });
      if (!objects.has(artifact.reference.objectKey)) {
        if (objectStorage === 'pack') await files[7]!.writeFile(artifact.bytes);
        else {
          const path = join(temp, 'objects', artifact.reference.objectKey);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, artifact.bytes, { flag: 'wx' });
        }
        objects.set(artifact.reference.objectKey, objectBytes);
        await files[6]!.writeFile(JSON.stringify({ objectKey: artifact.reference.objectKey, contentSha256: artifact.reference.contentSha256,
          bytes: artifact.reference.bytes, ...(objectStorage === 'pack' ? { packOffset: objectBytes } : {}) }) + '\n');
        objectBytes += artifact.reference.bytes;
      }
      const reference: CutoverTextReference = { ...artifact.reference, ...(objectStorage === 'pack' ? { packOffset: objects.get(artifact.reference.objectKey)! } : {}) };
      await files[0]!.writeFile(JSON.stringify(reference) + '\n');
      await files[1]!.writeFile(JSON.stringify(row) + '\n');
      await files[2]!.writeFile(clearTextSql(artifact.reference) + '\n');
      await files[3]!.writeFile(installReferenceSql(artifact.reference) + '\n');
      // Full text remains in bound parameters, never SQL literals over D1's statement limit.
      await files[4]!.writeFile(JSON.stringify({ query: 'UPDATE statute_sections SET text=? WHERE id=? AND corpus_id=? AND text_hash=?',
        params: [text, id, 'statutes-canada', fingerprint] }) + '\n');
      statements.push({ query: INSERT_COMPACT_STATUTE_SQL, params: COMPACT_STATUTE_COLUMNS.map((name) => name === 'text' ? '' : row[name] ?? null) });
      statements.push({ query: UPSERT_TEXT_REFERENCE_SQL, params: textReferenceBindings(reference) });
      pageRows++;
      if (pageRows === 16) await flushPage();
      count++;
      textBytes += artifact.reference.bytes;
      if (count % 25000 === 0) options.onProgress?.(`Prepared ${count} rows.`);
    }
    if (!count) throw new Error('An empty corpus cannot be cut over.');
    await flushPage();
    await Promise.all(files.map((file) => file.close()));
    await writeFile(join(temp, 'fresh-corpus-schema.sql'), COMPACT_CORPUS_SCHEMA, { flag: 'wx' });
    const manifest = await sealPreparedBundle(temp, { ...options, createdAt, rowCount: count, objectCount: objects.size,
      textBytes, freshPageCount: pageCount, objectStorage, objectsBytes: objectBytes, freshPagesChainSha256 });
    options.onProgress?.(`Verifying ${count} prepared rows.`);
    await verifyTextCutover(temp, options.onProgress);
    // Never replace another prepared bundle, including an unknown earlier outcome.
    await rename(temp, output);
    return manifest;
  } catch (error) {
    await Promise.allSettled(files.map((file) => file.close()));
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

export async function readCutoverObject(directory: string, reference: CutoverTextReference, manifest: TextCutoverManifest, sharedPack?: FileHandle): Promise<Uint8Array<ArrayBuffer>> {
  if (reference.objectKey !== provisionTextKey(reference.contentSha256) || !Number.isSafeInteger(reference.bytes) ||
      reference.bytes < 1 || reference.bytes > MAX_PROVISION_TEXT_BYTES) throw new Error('Invalid cutover object reference.');
  if (manifest.objectStorage === 'files') {
    const path = join(directory, 'objects', reference.objectKey);
    if ((await stat(path)).size !== reference.bytes) throw new Error('Cutover object size mismatch.');
    return new Uint8Array(await readFile(path));
  }
  if (!Number.isSafeInteger(reference.packOffset) || reference.packOffset! < 0 || reference.packOffset! + reference.bytes > manifest.objectsBytes) throw new Error('Invalid cutover object pack range.');
  const pack = sharedPack ?? await open(join(directory, 'objects.pack'), 'r');
  const bytes = new Uint8Array(reference.bytes);
  try {
    let filled = 0;
    while (filled < bytes.byteLength) {
      const read = await pack.read(bytes, filled, bytes.byteLength - filled, reference.packOffset! + filled);
      if (read.bytesRead === 0) throw new Error('Truncated cutover object pack.');
      filled += read.bytesRead;
    }
  } finally { if (!sharedPack) await pack.close(); }
  return bytes;
}

export async function verifyTextCutover(directory: string, onProgress?: (message: string) => void): Promise<TextCutoverManifest> {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as TextCutoverManifest;
  if (manifest.format !== 2 || manifest.corpusId !== 'statutes-canada' || !Number.isSafeInteger(manifest.rowCount) || manifest.rowCount < 1 ||
      !['files','pack'].includes(manifest.objectStorage)) throw new Error('Invalid cutover manifest.');
  const artifacts: [string, string | undefined][] = [['references.jsonl', manifest.referencesSha256], ['backup.jsonl', manifest.backupSha256],
    ['clear-text.sql', manifest.clearPlanSha256], ['install-references.sql', manifest.installPlanSha256], ['rollback-bindings.jsonl', manifest.rollbackBindingsSha256],
    ['fresh-corpus-schema.sql', manifest.freshSchemaSha256], ['fresh-pages.jsonl', manifest.freshPagesSha256], ['object-index.jsonl', manifest.objectIndexSha256],
    ...(manifest.objectStorage === 'pack' ? [['objects.pack', manifest.objectPackSha256] as [string, string | undefined]] : [])];
  if (manifest.sourceReceiptSha256) artifacts.push(['source-receipt.json', manifest.sourceReceiptSha256]);
  for (const [name, expected] of artifacts) {
    if (typeof expected !== 'string' || await sha256File(join(directory, name)) !== expected) throw new Error(`Cutover artifact digest mismatch: ${name}.`);
  }
  if (await readFile(join(directory, 'fresh-corpus-schema.sql'), 'utf8') !== COMPACT_CORPUS_SCHEMA) throw new Error('The compact corpus schema is unsupported.');
  const references = jsonLines(join(directory, 'references.jsonl'))[Symbol.asyncIterator]();
  const pack = manifest.objectStorage === 'pack' ? await open(join(directory, 'objects.pack'), 'r') : undefined;
  let count = 0;
  let bytes = 0;
  let previous = '';
  const objects = new Map<string, { bytes: number; packOffset?: number }>();
  try {
    for await (const row of jsonLines(join(directory, 'backup.jsonl'))) {
      const next = await references.next();
      if (next.done) throw new Error('Cutover reference count mismatch.');
      const reference = next.value as unknown as CutoverTextReference;
      const id = row['id'];
      if (typeof id !== 'string' || id <= previous || reference.rowId !== id || reference.corpusId !== 'statutes-canada' ||
          reference.rowFingerprint !== row['text_hash'] || reference.objectKey !== provisionTextKey(reference.contentSha256) ||
          typeof row['text'] !== 'string' || rowFingerprintWithText(row, row['text']) !== reference.rowFingerprint) throw new Error('Cutover row/reference parity mismatch.');
      previous = id;
      const content = await readCutoverObject(directory, reference, manifest, pack);
      if (content.byteLength !== reference.bytes || await textSha256(content) !== reference.contentSha256 ||
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content) !== row['text']) throw new Error('Cutover object parity mismatch.');
      const existing = objects.get(reference.objectKey);
      if (existing && (existing.bytes !== reference.bytes || existing.packOffset !== reference.packOffset)) throw new Error('Cutover object has inconsistent locations.');
      count++; bytes += content.byteLength; objects.set(reference.objectKey, { bytes: reference.bytes, ...(reference.packOffset === undefined ? {} : { packOffset: reference.packOffset }) });
      if (count % 25000 === 0) onProgress?.(`Verified ${count} backup/object pairs.`);
    }
    if (!(await references.next()).done || count !== manifest.rowCount || bytes !== manifest.textBytes || objects.size !== manifest.objectCount) throw new Error('Cutover manifest counts mismatch.');
  } finally { await references.return?.(undefined); await pack?.close(); }
  let objectCount = 0;
  let objectBytes = 0;
  const indexed = new Set<string>();
  for await (const entry of jsonLines(join(directory, 'object-index.jsonl'))) {
    const key = entry['objectKey'];
    if (typeof key !== 'string' || typeof entry['contentSha256'] !== 'string' || key !== provisionTextKey(entry['contentSha256']) || indexed.has(key)) throw new Error('Invalid cutover object index.');
    const location = objects.get(key);
    if (!location || location.bytes !== entry['bytes'] || location.packOffset !== entry['packOffset'] ||
        (manifest.objectStorage === 'pack' && entry['packOffset'] !== objectBytes)) throw new Error('Cutover object index parity mismatch.');
    objectBytes += location.bytes; objectCount++; indexed.add(key);
  }
  if (objectCount !== manifest.objectCount || objectBytes !== manifest.objectsBytes) throw new Error('Cutover object index count mismatch.');
  let pageCount = 0;
  let pageRows = 0;
  let pageAfter = '';
  let pageChain = '0'.repeat(64);
  const backup = jsonLines(join(directory, 'backup.jsonl'));
  const refs = jsonLines(join(directory, 'references.jsonl'));
  try {
    for await (const value of jsonLines(join(directory, 'fresh-pages.jsonl'))) {
      const page = value as unknown as CompactRestorePage;
      await verifyCompactRestorePage(page);
      pageChain = await textSha256(new Uint8Array(new TextEncoder().encode(pageChain + page.sha256)));
      if (page.page !== ++pageCount || page.fromAfter !== pageAfter) throw new Error('Compact restore page verification failed.');
      for (let at = 0; at < page.statements.length; at += 2) {
        const row = await backup.next();
        const ref = await refs.next();
        if (row.done || ref.done || JSON.stringify(page.statements[at]!.params) !==
            JSON.stringify(COMPACT_STATUTE_COLUMNS.map((name) => name === 'text' ? '' : row.value[name] ?? null)) ||
            JSON.stringify(page.statements[at + 1]!.params) !== JSON.stringify(textReferenceBindings(ref.value as unknown as ProvisionTextReference))) {
          throw new Error('Compact restore plan differs from its verified row backup.');
        }
      }
      pageAfter = page.through; pageRows += page.rows;
    }
    if (!(await backup.next()).done || !(await refs.next()).done) throw new Error('Compact restore plan count mismatch.');
  } finally { await Promise.all([backup.return(undefined), refs.return(undefined)]); }
  if (pageCount !== manifest.freshPageCount || pageRows !== manifest.rowCount) throw new Error('Compact restore plan count mismatch.');
  if (manifest.freshPagesChainSha256 && manifest.freshPagesChainSha256 !== pageChain) throw new Error('Compact restore page-chain mismatch.');
  return manifest;
}

/** Reuse a checked snapshot; never reparse XML or materialize its full index. */
export async function prepareSnapshotTextCutover(options: {
  snapshot: string; output: string; revision: string; receipt?: string; createdAt?: string; objectStorage?: 'files' | 'pack'; onProgress?: (message: string) => void;
}): Promise<TextCutoverManifest> {
  const [revision, parser, extra] = options.revision.split(':');
  if (!revision || !parser || extra) throw new Error('Snapshot preparation requires source SHA:parser revision.');
  const legacy = parser === 'legacy';
  if (legacy && !options.receipt) throw new Error('Legacy preparation requires an explicit checked --receipt.');
  if (!legacy && options.receipt) throw new Error('A legacy receipt cannot relabel a parser-versioned snapshot.');
  const receipt = legacy ? await verifyLegacyReceipt(resolve(options.snapshot), options.receipt!, revision) : undefined;
  const source = new SnapshotReader(new FileSnapshotBucket(resolve(options.snapshot)), revision, legacy ? {} : { parser });
  const manifest = await source.manifest();
  if (receipt && (receipt.source.date !== manifest.date || receipt.source.rows !== manifest.rows.count ||
      manifest.rows.parts.some((part) => !receipt.files[part.key] || receipt.files[part.key]!.bytes !== part.bytes))) throw new Error('The legacy receipt does not describe this snapshot.');
  options.onProgress?.(`Checking ${manifest.rows.parts.length} snapshot parts.`);
  // Hash every immutable source part before any range reads. Index integrity,
  // ordering and full row fingerprints are independently checked by the reader.
  for (const part of manifest.rows.parts) {
    const expected = receipt?.files[part.key]?.sha256 ?? part.sha256;
    if (!expected || (await stat(join(options.snapshot, part.key))).size !== part.bytes ||
        await sha256File(join(options.snapshot, part.key)) !== expected) throw new Error('Snapshot source part digest mismatch.');
  }
  options.onProgress?.('Checking the ordered snapshot index and mapping rows to D1 metadata.');
  await mkdir(dirname(resolve(options.output)), { recursive: true });
  const input = join(dirname(resolve(options.output)), `.text-cutover-input-${randomUUID()}.jsonl`);
  const file = await open(input, 'wx');
  let count = 0;
  let batch: SnapshotIndexEntry[] = [];
  const indexDigest = new IndexDigester();
  async function flush() {
    const rows = await source.rows(batch);
    if (rows.length !== batch.length) throw new Error('Snapshot rows are incomplete.');
    for (let at = 0; at < rows.length; at++) {
      const row = rows[at]!;
      if (row.corpusId !== 'statutes-canada') throw new Error('Snapshot contains another corpus.');
      await file.writeFile(JSON.stringify({ id: row.id, corpus_id: row.corpusId, act: row.instrument, section: row.section,
        heading: row.heading, text: row.text, source_url: row.source_url, jurisdiction: 'CA', in_force: row.in_force,
        topics: null, citation: row.citation, language: row.language, schedule: row.schedule, part: row.part,
        status: row.status, text_hash: batch[at]!.fp, last_changed: row.lastChanged }) + '\n');
      count++;
      if (count % 25000 === 0) options.onProgress?.(`Mapped ${count} snapshot rows.`);
    }
    batch = [];
  }
  try {
    for await (const entry of source.indexEntries()) {
      indexDigest.add(entry);
      batch.push(entry);
      if (batch.length === 64) await flush();
    }
    if (batch.length) await flush();
    if (count !== manifest.rows.count) throw new Error('Snapshot source row count mismatch.');
    if (receipt && indexDigest.digest() !== receipt.source.indexDigest) throw new Error('Legacy fingerprint index differs from its checked receipt.');
    await file.close();
    return await prepareTextCutover({ ...options, input, objectStorage: options.objectStorage ?? 'pack', sourceReceipt: options.receipt,
      publication: { commit: revision, parser: legacy ? null : parser, date: manifest.date, asOf: manifest.date,
        lastRunAt: options.createdAt ?? new Date().toISOString(), rows: manifest.rows.count } });
  } finally { await file.close().catch(() => {}); await rm(input, { force: true }); }
}

/** Resume a completely written local stage after an interrupted seal. Every
 * row, object and restore statement is verified before the directory moves. */
export async function recoverPreparedTextCutover(options: { stage: string; input: string; output: string; revision: string; onProgress?: (message: string) => void }) {
  if (!/^[a-f0-9]{40}(?::[A-Za-z0-9._-]{1,100})?$/.test(options.revision)) throw new Error('Invalid recovery revision.');
  if (await lstat(options.output).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; })) throw new Error('The recovery destination already exists.');
  const stage = resolve(options.stage);
  if (!(await lstat(stage)).isDirectory()) throw new Error('Recovery requires a local staging directory.');
  let rowCount = 0;
  let textBytes = 0;
  let createdAt = '';
  const objects = new Map<string, number>();
  let storage: 'files' | 'pack' | undefined;
  for await (const row of jsonLines(join(stage, 'references.jsonl'))) {
    const reference = row as unknown as CutoverTextReference;
    const rowStorage = reference.packOffset === undefined ? 'files' : 'pack';
    if (storage && storage !== rowStorage || createdAt && createdAt !== reference.createdAt) throw new Error('The recovery references are inconsistent.');
    storage = rowStorage; createdAt = reference.createdAt;
    rowCount++; textBytes += reference.bytes; objects.set(reference.objectKey, reference.bytes);
  }
  if (!storage || !rowCount) throw new Error('Cannot recover an empty cutover stage.');
  let freshPageCount = 0;
  let freshPagesChainSha256 = '0'.repeat(64);
  for await (const row of jsonLines(join(stage, 'fresh-pages.jsonl'))) { freshPageCount++;
    freshPagesChainSha256=await textSha256(new Uint8Array(new TextEncoder().encode(freshPagesChainSha256+String(row['sha256'])))); }
  const publicationPath=join(stage,'publication.json');
  const hasPublication=await lstat(publicationPath).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
  const sourceReceipt=await lstat(join(stage,'source-receipt.json')).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
  const manifestPath = join(stage, 'manifest.json');
  const sealed = await lstat(manifestPath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  const manifest: TextCutoverManifest = sealed ? JSON.parse(await readFile(manifestPath, 'utf8')) as TextCutoverManifest :
    await sealPreparedBundle(stage, { ...options, createdAt, rowCount, objectCount: objects.size, textBytes,
      freshPageCount, freshPagesChainSha256, objectStorage: storage, objectsBytes: [...objects.values()].reduce((sum, bytes) => sum + bytes, 0),
      ...(hasPublication?{publication:JSON.parse(await readFile(publicationPath,'utf8')) as TextCutoverManifest['publication']}:{}),
      ...(sourceReceipt?{sourceReceipt:join(stage,'source-receipt.json')}: {}) });
  if (manifest.revision !== options.revision || manifest.inputSha256 !== await sha256File(options.input)) throw new Error('Recovery does not match the sealed source input or revision.');
  options.onProgress?.(`Verifying ${rowCount} recovered rows.`);
  await verifyTextCutover(stage, options.onProgress);
  await mkdir(dirname(resolve(options.output)), { recursive: true });
  await rename(stage, resolve(options.output));
  return manifest;
}

async function main() {
  const values = new Map<string, string>();
  const args = process.argv.slice(2);
  for (let at = 0; at < args.length; at += 2) {
    const name = args[at]!; const value = args[at + 1];
    if (!['--input', '--snapshot', '--output', '--revision', '--verify', '--objects', '--recover', '--receipt'].includes(name) || !value || value.startsWith('--') || values.has(name)) throw new Error('Use --input <sorted rows.jsonl> or --snapshot <snapshot root>, --output <new bundle directory>, --revision <source SHA[:parser]> [--objects files|pack] [--receipt <checked legacy receipt>], --recover <completed staging directory> with --input/--output/--revision, or --verify <bundle directory>.');
    values.set(name, value);
  }
  if (values.has('--verify')) {
    if (values.size !== 1) throw new Error('--verify cannot be combined with preparation options.');
    console.log(JSON.stringify(await verifyTextCutover(resolve(values.get('--verify')!)), null, 2));
  } else {
    if (values.has('--recover')) {
      if (values.size !== 4 || !values.has('--input') || !values.has('--output') || !values.has('--revision')) throw new Error('Recovery requires --recover, --input, --output and --revision only.');
      console.log(JSON.stringify(await recoverPreparedTextCutover({ stage: values.get('--recover')!, input: values.get('--input')!,
        output: values.get('--output')!, revision: values.get('--revision')!, onProgress: (message) => console.error(message) }), null, 2));
      return;
    }
    if (values.has('--input') === values.has('--snapshot') || !values.get('--output') || !values.get('--revision')) throw new Error('Preparation requires exactly one of --input/--snapshot, plus --output and --revision.');
    const objectStorage = values.get('--objects') ?? (values.has('--snapshot') ? 'pack' : 'files');
    if (objectStorage !== 'files' && objectStorage !== 'pack') throw new Error('--objects must be files or pack.');
    const options = { output: values.get('--output')!, revision: values.get('--revision')!, objectStorage: objectStorage as 'files' | 'pack', onProgress: (message: string) => console.error(message) };
    if (values.has('--receipt') && !values.has('--snapshot')) throw new Error('--receipt requires --snapshot.');
    console.log(JSON.stringify(await (values.has('--snapshot') ? prepareSnapshotTextCutover({ ...options, snapshot: values.get('--snapshot')!, receipt: values.get('--receipt') }) :
      prepareTextCutover({ ...options, input: values.get('--input')! })), null, 2));
  }
}

if (process.argv[1] && /(?:^|[/\\])prepare-text-cutover\.(?:ts|mjs)$/.test(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Cutover preparation failed.'); process.exitCode = 1; });
}
