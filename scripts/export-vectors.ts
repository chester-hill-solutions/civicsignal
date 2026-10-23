#!/usr/bin/env bun
/** Existing-vector backup only. Live execution requires a completed, drained
 * suspension and a new local journal; dry-run never reads a credential. */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_PARSER_VERSION, vectorsManifestKey } from '../src/ingest/snapshot-format';
import { SnapshotReader } from '../src/ingest/snapshot-source';
import { VECTOR_EXPORT_PART_COUNT } from '../services/pipeline/vector-export';
import { FileSnapshotBucket } from './lib/file-snapshot';
import { exportPausedVectors, planVectorBackup, VectorBackupError, VECTOR_BACKUP_LIMITS,
  vectorBackupIdentity, vectorBackupOrigin, type VectorBackupSend } from './lib/vector-export-client';

function argumentsFor(argv: string[]) {
  const values = new Map<string, string>(); let dryRun = false;
  const allowed = ['--revision', '--parser', '--dir', '--per-part', '--url', '--coordinator-id', '--suspension-revision', '--journal'];
  for (let n = 0; n < argv.length; n++) {
    const flag = argv[n]!;
    if (flag === '--dry-run' && !dryRun) { dryRun = true; continue; }
    const value = argv[++n];
    if (!allowed.includes(flag) || values.has(flag) || !value || value.startsWith('--')) throw new VectorBackupError('INVALID_ARGUMENTS');
    values.set(flag, value);
  }
  const commit = values.get('--revision'), parser = values.get('--parser') ?? SNAPSHOT_PARSER_VERSION, directory = values.get('--dir');
  if (!commit || !/^[a-f0-9]{40}$/.test(commit) || parser !== SNAPSHOT_PARSER_VERSION || !directory ||
      values.has('--per-part') && values.get('--per-part') !== String(VECTOR_EXPORT_PART_COUNT)) throw new VectorBackupError('INVALID_ARGUMENTS');
  const url = values.get('--url'), coordinatorId = values.get('--coordinator-id'), revisionText = values.get('--suspension-revision'), journal = values.get('--journal');
  if (url !== undefined) vectorBackupOrigin(url);
  if (!dryRun && (!url || !coordinatorId || !revisionText || !journal)) throw new VectorBackupError('EXPLICIT_LIVE_ARGUMENTS_REQUIRED');
  if (coordinatorId !== undefined || revisionText !== undefined) {
    if (!coordinatorId || !revisionText || !/^[1-9]\d*$/.test(revisionText)) throw new VectorBackupError('INVALID_SUSPENSION_IDENTITY');
    vectorBackupIdentity(coordinatorId, Number(revisionText));
  }
  return { commit, parser, directory: resolve(directory), dryRun, url, coordinatorId, suspensionRevision: Number(revisionText), journal };
}
function absent(path: string): boolean {
  try { lstatSync(path); return false; } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return true;
    throw error;
  }
}
function syncDirectory(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function requireJournalParent(path: string) {
  let parent;
  try { parent = lstatSync(path); }
  catch { throw new VectorBackupError('JOURNAL_PARENT_REQUIRED'); }
  const uid = process.getuid?.();
  if (!parent.isDirectory() || parent.isSymbolicLink() || uid === undefined || parent.uid !== uid ||
      (parent.mode & 0o777) !== 0o700) throw new VectorBackupError('JOURNAL_PARENT_NOT_PRIVATE');
}
/** Injected tests use only synthetic snapshots and a local fake transport. */
export async function exportVectorsCli(argv: string[], dependencies: { getSecret?(): string | undefined; send?: VectorBackupSend } = {}) {
  let ledger: number | undefined;
  const record = (event: unknown) => { writeFileSync(ledger!, JSON.stringify(event) + '\n'); fsyncSync(ledger!); };
  try {
    const args = argumentsFor(argv);
    const plan = await planVectorBackup(new SnapshotReader(new FileSnapshotBucket(args.directory), args.commit, { parser: args.parser }));
    const planned = { commit: plan.commit, parser: plan.parser, indexDigest: plan.indexDigest, count: plan.count, parts: plan.parts.length,
      bytes: plan.bytes, maxRequests: plan.parts.length + 3, limits: VECTOR_BACKUP_LIMITS, modelProvenance: 'not-attested' as const };
    if (args.dryRun) return { ...planned, dryRun: true, writes: false };
    const output = resolve(args.directory, vectorsManifestKey(plan.commit, plan.parser)), journal = resolve(args.journal!);
    if (output === journal) throw new VectorBackupError('JOURNAL_PATH_CONFLICT');
    if (!absent(output)) throw new VectorBackupError('LOCAL_MANIFEST_EXISTS');
    // The operator supplies a durable existing parent; creating an ancestor
    // here would require syncing its own parent before any remote request.
    requireJournalParent(dirname(journal));
    try { ledger = openSync(journal, 'wx', 0o600); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw new VectorBackupError('JOURNAL_ALREADY_EXISTS'); throw error; }
    syncDirectory(dirname(journal));
    // Persist identity and every intent before transport. The secret is absent
    // from this journal, from result normalization, and from thrown messages.
    record({ kind: 'plan', format: 1, plan, origin: vectorBackupOrigin(args.url!), coordinatorId: args.coordinatorId,
      suspensionRevision: args.suspensionRevision, maxRequests: planned.maxRequests });
    const secret = (dependencies.getSecret ?? (() => process.env.PIPELINE_SECRET))();
    if (!secret) throw new VectorBackupError('PIPELINE_SECRET_ENV_REQUIRED');
    const result = await exportPausedVectors(plan, { url: args.url!, coordinatorId: args.coordinatorId!,
      suspensionRevision: args.suspensionRevision, secret, send: dependencies.send, record });
    const text = JSON.stringify(result.manifest, null, 2) + '\n';
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    let fd: number;
    try { fd = openSync(output, 'wx', 0o600); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw new VectorBackupError('LOCAL_MANIFEST_EXISTS'); throw error; }
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(dirname(output));
    record({ kind: 'complete', requests: result.requests, manifestSha256: createHash('sha256').update(text).digest('hex'), modelProvenance: result.modelProvenance });
    return { ...planned, dryRun: false, writes: true, requests: result.requests, suspensionRevision: args.suspensionRevision, coordinatorId: args.coordinatorId };
  } catch (error) {
    const safe = error instanceof VectorBackupError ? error : new VectorBackupError('LOCAL_VECTOR_BACKUP_FAILED');
    if (ledger !== undefined) { try { record({ kind: 'failed', code: safe.code }); } catch { /* Retain the exclusive journal and all prior intents. */ } }
    throw safe;
  } finally { if (ledger !== undefined) closeSync(ledger); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  exportVectorsCli(process.argv.slice(2)).then(value => console.log(JSON.stringify(value))).catch(error => {
    console.error(JSON.stringify({ failed: true, code: error instanceof VectorBackupError ? error.code : 'LOCAL_VECTOR_BACKUP_FAILED' })); process.exitCode = 1;
  });
}
