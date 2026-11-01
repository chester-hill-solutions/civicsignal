/** Bounded client for the existing suspended corpus/vector backup protocol.
 * It never resumes a writer, embeds documents, retries or refreshes credentials. */
import { ENCODER_CONTRACT } from '../../src/encoder';
import { CORPUS_ID } from '../../src/ingest/corpus-rows';
import { IndexDigester, parseVectorsManifest, SNAPSHOT_PARSER_VERSION, vectorsPartKey, type VectorsManifest } from '../../src/ingest/snapshot-format';
import type { SnapshotSource } from '../../src/ingest/snapshot-source';
import { VECTOR_EXPORT_PART_COUNT, type VectorPartReceipt } from '../../services/pipeline/vector-export';

export class VectorBackupError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'VectorBackupError'; }
}
function demand(ok: unknown, code: string): asserts ok { if (!ok) throw new VectorBackupError(code); }
const digest = /^[a-f0-9]{32}$/, sha256 = /^[a-f0-9]{64}$/;
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
export const VECTOR_BACKUP_LIMITS = Object.freeze({ controlMs: 15_000, exportMs: 120_000, maxExportMs: 300_000,
  controlBytes: 16_384, partBytes: 8_192, manifestBytes: 262_144, maxParts: 1000 });
export interface VectorBackupPlan {
  format: 1; corpusId: typeof CORPUS_ID; commit: string; parser: string; indexDigest: string; indexSha256: string;
  count: number; dims: number; bytes: number;
  parts: { part: number; from: number; count: number; partDigest: string }[];
}
/** SnapshotReader verifies index bytes/SHA/order before yielding. Stream a
 * second independent digest and every fixed server partition without keeping IDs. */
export async function planVectorBackup(snapshot: SnapshotSource): Promise<VectorBackupPlan> {
  try {
    const manifest = await snapshot.manifest();
    demand(manifest.commit === snapshot.revision && /^[a-f0-9]{40}$/.test(manifest.commit) &&
      manifest.parser === SNAPSHOT_PARSER_VERSION && typeof manifest.index.sha256 === 'string' && sha256.test(manifest.index.sha256) &&
      digest.test(manifest.index.digest ?? '') && integer(manifest.rows.count) && manifest.rows.count > 0 &&
      Math.ceil(manifest.rows.count / VECTOR_EXPORT_PART_COUNT) <= VECTOR_BACKUP_LIMITS.maxParts, 'INVALID_LOCAL_SNAPSHOT');
    let count = 0, inPart = 0, partDigest = new IndexDigester();
    const globalDigest = new IndexDigester(), parts: VectorBackupPlan['parts'] = [];
    const finish = () => { parts.push({ part: parts.length, from: count - inPart, count: inPart, partDigest: partDigest.digest() });
      inPart = 0; partDigest = new IndexDigester(); };
    for await (const entry of snapshot.indexEntries()) {
      globalDigest.add(entry); partDigest.add(entry); count++; inPart++;
      demand(count <= manifest.rows.count, 'INVALID_LOCAL_SNAPSHOT');
      if (inPart === VECTOR_EXPORT_PART_COUNT) finish();
    }
    if (inPart) finish();
    demand(count === manifest.rows.count && count === manifest.index.entries && globalDigest.digest() === manifest.index.digest, 'INVALID_LOCAL_SNAPSHOT');
    return checkedPlan({ format: 1, corpusId: CORPUS_ID, commit: manifest.commit, parser: manifest.parser,
      indexDigest: manifest.index.digest!, indexSha256: manifest.index.sha256!, count, dims: ENCODER_CONTRACT.dimensions,
      bytes: count * ENCODER_CONTRACT.dimensions * 4, parts });
  } catch { throw new VectorBackupError('INVALID_LOCAL_SNAPSHOT'); }
}
function checkedPlan(p: VectorBackupPlan): VectorBackupPlan {
  demand(p?.format === 1 && p.corpusId === CORPUS_ID && /^[a-f0-9]{40}$/.test(p.commit) && p.parser === SNAPSHOT_PARSER_VERSION &&
    digest.test(p.indexDigest) && sha256.test(p.indexSha256) && integer(p.count) && p.count > 0 && p.dims === ENCODER_CONTRACT.dimensions &&
    integer(p.bytes) && p.bytes === p.count * p.dims * 4 && Array.isArray(p.parts) && p.parts.length > 0 &&
    p.parts.length === Math.ceil(p.count / VECTOR_EXPORT_PART_COUNT) && p.parts.length <= VECTOR_BACKUP_LIMITS.maxParts, 'INVALID_EXPORT_PLAN');
  const parts = p.parts.map((part, n) => {
    const from = n * VECTOR_EXPORT_PART_COUNT, count = Math.min(VECTOR_EXPORT_PART_COUNT, p.count - from);
    demand(part?.part === n && part.from === from && part.count === count && digest.test(part.partDigest), 'INVALID_EXPORT_PLAN');
    return { part: n, from, count, partDigest: part.partDigest };
  });
  return { format: 1, corpusId: CORPUS_ID, commit: p.commit, parser: p.parser, indexDigest: p.indexDigest,
    indexSha256: p.indexSha256, count: p.count, dims: p.dims, bytes: p.bytes, parts };
}
export function vectorBackupOrigin(value: string): string {
  try {
    const u = new URL(value);
    demand(/^https?:\/\/[^@/?#]+\/?$/.test(value) && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash &&
      (u.protocol === 'https:' || u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)), 'INVALID_PIPELINE_ORIGIN');
    return u.origin;
  } catch { throw new VectorBackupError('INVALID_PIPELINE_ORIGIN'); }
}
export function vectorBackupIdentity(coordinatorId: string, suspensionRevision: number): void {
  demand(typeof coordinatorId === 'string' && /^[a-f0-9]{64}$/.test(coordinatorId) && integer(suspensionRevision) && suspensionRevision > 0, 'INVALID_SUSPENSION_IDENTITY');
}
export interface BackupControl {
  corpusId: string; coordinatorId: string;
  coordinator: { format: 1; revision: number; suspended: true; quiescent: true; active: null; queued: 0;
    alarmHandlersActive: 0; alarmAt: null; pending: false; failures: 0; lastFailure: null };
}
function checkedControl(value: unknown, plan: VectorBackupPlan, id: string, revision: number): BackupControl {
  const v = value as Record<string, unknown> | null, c = v?.coordinator as Record<string, unknown> | null;
  demand(v?.corpusId === plan.corpusId && v.coordinatorId === id && c?.format === 1 && c.revision === revision &&
    c.suspended === true && c.quiescent === true && c.active === null && c.queued === 0 && c.alarmHandlersActive === 0 &&
    c.alarmAt === null && c.pending === false && c.failures === 0 && c.lastFailure === null, 'SUSPENSION_NOT_COMPLETE_OR_CHANGED');
  return { corpusId: plan.corpusId, coordinatorId: id, coordinator: { format: 1, revision, suspended: true, quiescent: true,
    active: null, queued: 0, alarmHandlersActive: 0, alarmAt: null, pending: false, failures: 0, lastFailure: null } };
}
function checkedReceipt(value: unknown, plan: VectorBackupPlan, n: number): VectorPartReceipt {
  const r = value as VectorPartReceipt | null, part = plan.parts[n]!;
  demand(r?.format === 1 && r.commit === plan.commit && r.parser === plan.parser && r.indexDigest === plan.indexDigest &&
    r.partDigest === part.partDigest && r.part === n && r.from === part.from && r.count === part.count &&
    r.key === vectorsPartKey(plan.commit, n, plan.parser) && r.bytes === part.count * plan.dims * 4 && sha256.test(r.sha256) &&
    integer(r.embedded) && integer(r.notEmbedded) && r.embedded + r.notEmbedded === part.count, 'PART_RECEIPT_MISMATCH');
  return { format: 1, commit: plan.commit, parser: plan.parser, indexDigest: plan.indexDigest, partDigest: part.partDigest,
    part: n, key: vectorsPartKey(plan.commit, n, plan.parser), from: part.from, count: part.count, bytes: part.count * plan.dims * 4,
    sha256: r!.sha256, embedded: r!.embedded, notEmbedded: r!.notEmbedded };
}
function checkedManifest(value: unknown, plan: VectorBackupPlan, receipts: VectorPartReceipt[]): VectorsManifest {
  try {
    const m = parseVectorsManifest(JSON.stringify(value));
    demand(m.commit === plan.commit && m.parser === plan.parser && m.count === plan.count && m.bytes === plan.bytes &&
      m.dims === plan.dims && m.index.digest === plan.indexDigest && m.index.entries === plan.count && m.parts.length === receipts.length &&
      m.embedded === receipts.reduce((n, r) => n + r.embedded, 0) && m.notEmbedded === receipts.reduce((n, r) => n + r.notEmbedded, 0) &&
      m.parts.every((part, n) => { const r = receipts[n]!; return part.key === r.key && part.from === r.from && part.count === r.count &&
        part.bytes === r.bytes && part.sha256 === r.sha256; }), 'VECTOR_MANIFEST_MISMATCH');
    return { format: 1, commit: plan.commit, parser: plan.parser, dims: plan.dims, count: plan.count, bytes: plan.bytes,
      parts: receipts.map(r => ({ key: r.key, from: r.from, count: r.count, bytes: r.bytes, sha256: r.sha256 })),
      index: { entries: plan.count, digest: plan.indexDigest }, embedded: m.embedded, notEmbedded: m.notEmbedded };
  } catch { throw new VectorBackupError('VECTOR_MANIFEST_MISMATCH'); }
}
export interface VectorBackupRequest { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; redirect: 'error'; signal: AbortSignal }
export type VectorBackupSend = (url: string, request: VectorBackupRequest) => Promise<Response>;
type Step = 'control-initial' | 'part' | 'manifest' | 'control-final';
export type VectorBackupEvent = { kind: 'intent'; request: number; step: Step; part?: number } |
  { kind: 'response'; request: number; step: Step; value: BackupControl | VectorPartReceipt | VectorsManifest };
export async function exportPausedVectors(input: VectorBackupPlan, options: {
  url: string; coordinatorId: string; suspensionRevision: number; secret: string; send?: VectorBackupSend;
  record(event: VectorBackupEvent): void | Promise<void>;
  /** Tests/operators may lower the deadlines; neither may exceed these ceilings. */
  controlMs?: number; exportMs?: number;
}) {
  const plan = checkedPlan(input), origin = vectorBackupOrigin(options.url);
  vectorBackupIdentity(options.coordinatorId, options.suspensionRevision);
  demand(typeof options.secret === 'string' && options.secret.length > 0 && options.secret.length <= 4096 && !/[\r\n]/.test(options.secret), 'INVALID_PIPELINE_SECRET');
  const controlMs = options.controlMs ?? VECTOR_BACKUP_LIMITS.controlMs, exportMs = options.exportMs ?? VECTOR_BACKUP_LIMITS.exportMs;
  demand(integer(controlMs) && controlMs > 0 && controlMs <= VECTOR_BACKUP_LIMITS.controlMs && integer(exportMs) && exportMs > 0 && exportMs <= VECTOR_BACKUP_LIMITS.maxExportMs, 'INVALID_REQUEST_LIMITS');
  const send: VectorBackupSend = options.send ?? ((url, request) => fetch(url, request));
  let requests = 0;
  const maxRequests = plan.parts.length + 3;
  const record = async (event: VectorBackupEvent) => { try { await options.record(event); } catch { throw new VectorBackupError('JOURNAL_WRITE_FAILED'); } };
  async function call(step: Step, part?: number): Promise<unknown> {
    demand(requests < maxRequests, 'REQUEST_CEILING');
    const request = ++requests;
    await record({ kind: 'intent', request, step, ...(part === undefined ? {} : { part }) });
    const control = step.startsWith('control-'), controller = new AbortController();
    const limit = control ? VECTOR_BACKUP_LIMITS.controlBytes : step === 'part' ? VECTOR_BACKUP_LIMITS.partBytes : VECTOR_BACKUP_LIMITS.manifestBytes;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const target = origin + (control ? '/control' : '/vectors');
          const response = await send(target, { method: control ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
            headers: { 'x-pipeline-secret': options.secret, ...(control ? {} : { 'content-type': 'application/json',
              'X-Pipeline-Suspension-Revision': String(options.suspensionRevision) }) },
            ...(control ? {} : { body: JSON.stringify({ commit: plan.commit, parser: plan.parser, indexDigest: plan.indexDigest,
              action: step, ...(part === undefined ? {} : { part }) }) }) });
          demand(response.status === 200 && !response.redirected && (!response.url || response.url === target), 'EXPORT_HTTP_REFUSED');
          if (!control) demand(response.headers.get('x-pipeline-suspension-revision') === String(options.suspensionRevision), 'SUSPENSION_ECHO_MISMATCH');
          const length = response.headers.get('content-length');
          demand(length === null || /^\d+$/.test(length) && Number(length) <= limit, 'RESPONSE_TOO_LARGE');
          const reader = response.body?.getReader();
          demand(reader, 'INVALID_RESPONSE');
          const chunks: Uint8Array[] = []; let size = 0;
          try { for (;;) { const next = await reader!.read(); if (next.done) break; size += next.value.byteLength;
            demand(size <= limit, 'RESPONSE_TOO_LARGE'); chunks.push(next.value); } }
          finally { reader!.releaseLock(); }
          try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Buffer.concat(chunks))); }
          catch { throw new VectorBackupError('INVALID_RESPONSE'); }
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new VectorBackupError('REQUEST_TIMEOUT')); controller.abort(); }, control ? controlMs : exportMs); }),
      ]);
    } catch (error) { throw error instanceof VectorBackupError ? error : new VectorBackupError('EXPORT_TRANSPORT_FAILED'); }
    finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  }
  const initial = checkedControl(await call('control-initial'), plan, options.coordinatorId, options.suspensionRevision);
  await record({ kind: 'response', request: requests, step: 'control-initial', value: initial });
  const receipts: VectorPartReceipt[] = [];
  for (const part of plan.parts) {
    const receipt = checkedReceipt(await call('part', part.part), plan, part.part); receipts.push(receipt);
    await record({ kind: 'response', request: requests, step: 'part', value: receipt });
  }
  const manifest = checkedManifest(await call('manifest'), plan, receipts);
  await record({ kind: 'response', request: requests, step: 'manifest', value: manifest });
  const final = checkedControl(await call('control-final'), plan, options.coordinatorId, options.suspensionRevision);
  await record({ kind: 'response', request: requests, step: 'control-final', value: final });
  return { manifest, initial, final, requests, maxRequests, modelProvenance: 'not-attested' as const };
}
