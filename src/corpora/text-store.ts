import type { CorpusDatabase } from '@chester-hill-solutions/corpus';
import { fingerprint, type FingerprintedRow } from '../ingest/reconcile';

export type CorpusTextMode = 'd1' | 'verify' | 'prefer-r2' | 'r2';
export const MAX_PROVISION_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_HYDRATED_TEXT_BYTES = 16 * 1024 * 1024;
const PREFIX = 'statute-text/sha256/';

export function parseCorpusTextMode(value: string | undefined): CorpusTextMode {
  if (value === undefined || value === 'd1') return 'd1';
  if (value === 'verify' || value === 'prefer-r2' || value === 'r2') return value;
  throw new ProvisionTextError('Invalid provision text mode.');
}

export interface ProvisionTextReference {
  rowId: string;
  corpusId: string;
  rowFingerprint: string;
  contentSha256: string;
  objectKey: string;
  bytes: number;
  createdAt: string;
}

export interface TextObjectReader {
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
}

export interface TextObjectBucket extends TextObjectReader {
  put(key: string, bytes: Uint8Array<ArrayBuffer>, options: { onlyIf: { etagDoesNotMatch: string }; httpMetadata: { contentType: string } }): Promise<unknown | null>;
}

export interface ProvisionTextReader {
  hydrate(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
}

export class ProvisionTextError extends Error {
  constructor(message = 'Verified provision text is unavailable.') {
    super(message);
    this.name = 'ProvisionTextError';
  }
}

export async function textSha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function provisionTextKey(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new ProvisionTextError('Invalid provision text digest.');
  return `${PREFIX}${sha256}.txt`;
}

export function rowFingerprintWithText(row: Record<string, unknown>, text: string): string {
  return fingerprint({
    id: String(row['id']), instrument: String(row['act'] ?? row['instrument']), text,
    heading: row['heading'] == null ? null : String(row['heading']), section: String(row['section']),
    status: row['status'] as FingerprintedRow['status'], schedule: row['schedule'] == null ? null : String(row['schedule']),
    part: row['part'] == null ? null : Number(row['part']), source_url: String(row['source_url']),
    in_force: row['in_force'] === true || row['in_force'] === 1 ? 1 : 0, citation: String(row['citation']),
  });
}

export async function prepareProvisionText(options: {
  rowId: string; corpusId: string; rowFingerprint: string; text: string; createdAt?: string;
}): Promise<{ reference: ProvisionTextReference; bytes: Uint8Array<ArrayBuffer> }> {
  if (!options.rowId || !options.corpusId || !/^[a-f0-9]{32}$/.test(options.rowFingerprint)) {
    throw new ProvisionTextError('A provision identity and valid row fingerprint are required.');
  }
  const bytes = new Uint8Array(new TextEncoder().encode(options.text));
  if (!bytes.byteLength || bytes.byteLength > MAX_PROVISION_TEXT_BYTES ||
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== options.text) {
    throw new ProvisionTextError('Provision text must be non-empty valid UTF-8 within the supported size bound.');
  }
  const contentSha256 = await textSha256(bytes);
  return { bytes, reference: { rowId: options.rowId, corpusId: options.corpusId,
    rowFingerprint: options.rowFingerprint, contentSha256, objectKey: provisionTextKey(contentSha256),
    bytes: bytes.byteLength, createdAt: options.createdAt ?? new Date().toISOString() } };
}

function validateReference(reference: ProvisionTextReference): void {
  if (!reference.rowId || !reference.corpusId || !/^[a-f0-9]{32}$/.test(reference.rowFingerprint) ||
      reference.objectKey !== provisionTextKey(reference.contentSha256) ||
      !Number.isSafeInteger(reference.bytes) || reference.bytes < 1 || reference.bytes > MAX_PROVISION_TEXT_BYTES) {
    throw new ProvisionTextError('Invalid provision text reference.');
  }
}

export async function readVerifiedProvisionText(bucket: TextObjectReader, reference: ProvisionTextReference): Promise<string> {
  validateReference(reference);
  const object = await bucket.get(reference.objectKey);
  if (!object || object.size !== reference.bytes) throw new ProvisionTextError();
  const reader = object.body.getReader();
  const bytes = new Uint8Array(reference.bytes);
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > bytes.byteLength) {
        await reader.cancel();
        throw new ProvisionTextError();
      }
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
  } finally { reader.releaseLock(); }
  if (size !== reference.bytes || await textSha256(bytes) !== reference.contentSha256) throw new ProvisionTextError();
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch { throw new ProvisionTextError(); }
}

/** Conditional creation makes retries safe and never replaces existing immutable bytes. */
export async function writeImmutableProvisionText(bucket: TextObjectBucket,
  artifact: Awaited<ReturnType<typeof prepareProvisionText>>): Promise<ProvisionTextReference> {
  validateReference(artifact.reference);
  if (artifact.bytes.byteLength !== artifact.reference.bytes ||
      await textSha256(artifact.bytes) !== artifact.reference.contentSha256) throw new ProvisionTextError();
  await bucket.put(artifact.reference.objectKey, artifact.bytes, {
    onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  });
  // An existing object is acceptable only if its immutable bytes still verify.
  await readVerifiedProvisionText(bucket, artifact.reference);
  return artifact.reference;
}

function referenceFromRow(row: Record<string, unknown>): ProvisionTextReference {
  return { rowId: String(row['row_id']), corpusId: String(row['corpus_id']), rowFingerprint: String(row['row_fingerprint']),
    contentSha256: String(row['content_sha256']), objectKey: String(row['object_key']), bytes: Number(row['bytes']), createdAt: String(row['created_at']) };
}

export function createR2ProvisionTextStore(db: CorpusDatabase, bucket: TextObjectReader, mode: CorpusTextMode): ProvisionTextReader {
  if (!['d1', 'verify', 'prefer-r2', 'r2'].includes(mode)) throw new ProvisionTextError('Invalid provision text mode.');
  return {
    async hydrate(rows) {
      if (mode === 'd1' || rows.length === 0) return rows;
      const refs = new Map<string, ProvisionTextReference>();
      for (let start = 0; start < rows.length; start += 100) {
        const ids = rows.slice(start, start + 100).map((row) => String(row['id']));
        try {
          const result = await db.prepare(`SELECT row_id, corpus_id, row_fingerprint, content_sha256, object_key, bytes, created_at
            FROM statute_text_refs WHERE row_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<Record<string, unknown>>();
          for (const value of result.results ?? []) { const ref = referenceFromRow(value); refs.set(ref.rowId, ref); }
        } catch {
          if (mode !== 'prefer-r2') throw new ProvisionTextError();
        }
      }
      // Candidate sets may contain hundreds of rows. Concurrency alone does
      // not bound the decoded strings retained until reranking completes.
      const retained = new Map<string, number>();
      for (const row of rows) {
        const reference = refs.get(String(row['id']));
        if (reference && Number.isSafeInteger(reference.bytes) && reference.bytes > 0) retained.set(reference.objectKey, reference.bytes);
        if (typeof row['text'] === 'string' && row['text'].length) retained.set(`d1:${String(row['id'])}`, new TextEncoder().encode(row['text']).byteLength);
      }
      if ([...retained.values()].reduce((sum, bytes) => sum + bytes, 0) > MAX_HYDRATED_TEXT_BYTES) throw new ProvisionTextError('The provision text request exceeds its hydration bound.');
      const loaded = new Map<string, Promise<string>>();
      const output: Record<string, unknown>[] = Array(rows.length);
      let position = 0;
      async function worker() {
        while (position < rows.length) {
          const at = position++;
          const row = rows[at]!;
          const fallback = typeof row['text'] === 'string' && row['text'].length > 0 ? row['text'] : undefined;
          try {
            const reference = refs.get(String(row['id']));
            if (!reference || reference.rowFingerprint !== row['text_hash'] || reference.corpusId !== row['corpus_id']) throw new ProvisionTextError();
            validateReference(reference);
            let pending = loaded.get(reference.objectKey);
            if (!pending) { pending = readVerifiedProvisionText(bucket, reference); loaded.set(reference.objectKey, pending); }
            const text = await pending;
            if (rowFingerprintWithText(row, text) !== reference.rowFingerprint ||
                (mode === 'verify' && text !== fallback)) throw new ProvisionTextError();
            output[at] = { ...row, text: mode === 'verify' ? fallback : text };
          } catch {
            if (mode !== 'prefer-r2' || fallback === undefined || rowFingerprintWithText(row, fallback) !== row['text_hash']) throw new ProvisionTextError();
            output[at] = row;
          }
        }
      }
      const outcomes = await Promise.allSettled(Array.from({ length: Math.min(8, rows.length) }, () => worker()));
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      return output;
    },
  };
}

/** Used by offline tooling and the ingestion transaction after immutable upload. */
export function textReferenceBindings(reference: ProvisionTextReference): unknown[] {
  validateReference(reference);
  return [reference.rowId, reference.corpusId, reference.rowFingerprint, reference.contentSha256,
    reference.objectKey, reference.bytes, reference.createdAt];
}

export const UPSERT_TEXT_REFERENCE_SQL = `INSERT INTO statute_text_refs
  (row_id, corpus_id, row_fingerprint, content_sha256, object_key, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(row_id) DO UPDATE SET corpus_id=excluded.corpus_id, row_fingerprint=excluded.row_fingerprint,
  content_sha256=excluded.content_sha256, object_key=excluded.object_key, bytes=excluded.bytes, created_at=excluded.created_at`;

export interface TextParityCheckpoint {
  revision: string;
  rowCount: number;
  mutationCount: number;
  after: string;
  rowsVerified: number;
  bytesVerified: number;
  complete: boolean;
}

async function publication(db: CorpusDatabase) {
  const result = await db.prepare(`SELECT commit_sha, parser_version, row_count,
    (SELECT count(*) FROM corpus_mutations WHERE corpus_id='statutes-canada') AS mutation_count,
    (SELECT count(*) FROM corpus_mutations WHERE corpus_id='statutes-canada' AND payload IS NOT NULL) AS pending
    FROM corpus_state WHERE corpus_id=?`).bind('statutes-canada').all<Record<string, unknown>>();
  const state = result.results?.[0];
  if (!state || !Number.isSafeInteger(Number(state['row_count'])) || Number(state['row_count']) < 1 || Number(state['pending']) !== 0) {
    throw new ProvisionTextError('A non-empty published corpus with a drained ingestion outbox is required for text parity.');
  }
  return { revision: `${String(state['commit_sha'])}:${String(state['parser_version'] ?? 'legacy')}`,
    rowCount: Number(state['row_count']), mutationCount: Number(state['mutation_count']) };
}

/** One bounded Workflow/operations step. Reuse its checkpoint until complete.
 * Ingestion must be quiescent for the full audit; revision and journal counters
 * reject publication or ingestion changes across page boundaries. */
export async function auditProvisionTextPage(db: CorpusDatabase, bucket: TextObjectReader, options: {
  expectedRevision: string; mode: 'verify' | 'r2'; checkpoint?: TextParityCheckpoint; pageSize?: number;
}): Promise<TextParityCheckpoint> {
  const pageSize = options.pageSize ?? 8;
  if (options.mode !== 'verify' && options.mode !== 'r2') throw new ProvisionTextError('Text parity requires strict verify or r2 mode.');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 8) throw new ProvisionTextError('Text parity pages must contain between 1 and 8 rows.');
  const before = await publication(db);
  const previous = options.checkpoint;
  if (before.revision !== options.expectedRevision || (previous &&
      (previous.revision !== before.revision || previous.rowCount !== before.rowCount || previous.mutationCount !== before.mutationCount))) {
    throw new ProvisionTextError('The corpus changed during text parity; start a new audit from its verified publication.');
  }
  if (previous?.complete) return previous;
  const result = await db.prepare(`SELECT id,corpus_id,act,citation,section,status,schedule,part,heading,text,text_hash,
    source_url,jurisdiction,in_force,topics,language FROM statute_sections
    WHERE corpus_id=? AND id>? ORDER BY id LIMIT ?`).bind('statutes-canada', previous?.after ?? '', pageSize + 1).all<Record<string, unknown>>();
  const rows = (result.results ?? []).slice(0, pageSize);
  const hydrated = await createR2ProvisionTextStore(db, bucket, options.mode).hydrate(rows);
  const after = await publication(db);
  if (before.revision !== after.revision || before.rowCount !== after.rowCount || before.mutationCount !== after.mutationCount) {
    throw new ProvisionTextError('The corpus changed during text parity; start a new audit from its verified publication.');
  }
  const rowsVerified = (previous?.rowsVerified ?? 0) + rows.length;
  const complete = (result.results?.length ?? 0) <= pageSize;
  if (rowsVerified > before.rowCount || (complete && rowsVerified !== before.rowCount)) throw new ProvisionTextError('Published corpus row count does not match the text parity scan.');
  return { ...before, after: String(rows.at(-1)?.['id'] ?? previous?.after ?? ''), rowsVerified,
    bytesVerified: (previous?.bytesVerified ?? 0) + hydrated.reduce((total, row) => total + new TextEncoder().encode(String(row['text'])).byteLength, 0), complete };
}
