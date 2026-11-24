import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { QUALIFICATION_RECEIPT_BYTES } from '../../services/snapshot/qualification-store';
import { CORPUS_REPO } from '../../src/ingest/source';
import { requestSourceHead, type SourceHeadSend } from '../../src/ingest/source-head';
import { verifyStagedR2Admission, type StagedPublicationPacketPin } from '../verify-staged-snapshot';
import { FRESH_SNAPSHOT_STAGE_ID } from './snapshot-calendar';
import { MissingSnapshotDiagnostic, readSnapshotCfBytes, requireSnapshotWorkflowInstanceAbsent, snapshotWorkflowInstanceArgs } from './snapshot-hosted-admission';
import type { runStagedSnapshotPublication } from './snapshot-publication-window';
import { stagingNames } from './staging-config';

type ObservePublication = Parameters<typeof runStagedSnapshotPublication>[1]['observePublication'];
type AdmitPublication = Parameters<typeof runStagedSnapshotPublication>[1]['admit'];
type Target = Parameters<ObservePublication>[0];
type MissingDiagnostics = Record<'failed' | 'existing', null>;

const bucket = stagingNames('20261022').corpus;
const pending = z.enum(['queued', 'running', 'waiting']);
const status = z.object({ status: z.string() });
const completed = z.object({ status: z.literal('complete'), start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }), trigger: z.object({ source: z.literal('binding') }),
  params: z.unknown(), output: z.unknown() });
const resultEnvelope = z.object({ success: z.literal(true), result: status.passthrough() });
const metadataBytes = 64 * 1024;

function readJson(bytes: Buffer, maximum: number): unknown {
  try {
    if (bytes.length > maximum) throw new Error('size');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new Error('SNAPSHOT_CF_PUBLICATION_RESPONSE');
  }
}

function responseMetadata(bytes: Buffer) {
  const value = readJson(bytes, metadataBytes);
  const wrapped = resultEnvelope.safeParse(value);
  return wrapped.success ? wrapped.data.result : value;
}

function boundTarget(target: Target) {
  const { qualification: { identity: { id }, digest, instanceId, prefix } } = target;
  if (target.worker !== FRESH_SNAPSHOT_STAGE_ID || target.bucket !== bucket || !/^[a-z][a-z0-9-]{0,39}$/.test(id) ||
    !/^[a-f0-9]{64}$/.test(digest) || instanceId !== `qual-${digest}` || prefix !== `qualifications/${id}/${digest}/`) {
    throw new Error('SNAPSHOT_CF_PUBLICATION_TARGET');
  }
}

export function requireSnapshotCfUnusedInstance(target: Target, signal: AbortSignal, read = readSnapshotCfBytes) {
  boundTarget(target);
  return requireSnapshotWorkflowInstanceAbsent(target.qualification.instanceId, signal, read);
}

/** Called inside the guarded publication window after the owner approves the packet and its read budget. */
export function createSnapshotCfAdmissionReader(options: { packetPath: string; packetPin?: StagedPublicationPacketPin; reviewId: string; r2ReadToken: string },
  send: SourceHeadSend = fetch, read = readSnapshotCfBytes): AdmitPublication {
  if (!options.reviewId.trim() || options.reviewId.length > 128) throw new Error('SNAPSHOT_CF_PUBLICATION_REVIEW');
  return async (target, signal) => {
    boundTarget(target);
    signal.throwIfAborted();
    const currentSource = await requestSourceHead(`https://api.github.com/repos/${CORPUS_REPO}`, 'main',
      { Accept: 'application/vnd.github+json', 'User-Agent': 'CivicSignal-staging-admission' }, (url, init) =>
        send(url, { ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal }));
    if (!isDeepStrictEqual(currentSource, target.qualification.identity.revision)) throw new Error('SNAPSHOT_CF_PUBLICATION_SOURCE');
    signal.throwIfAborted();
    const instance = await requireSnapshotCfUnusedInstance(target, signal, read);
    signal.throwIfAborted();
    const r2 = await verifyStagedR2Admission(options.packetPath, options.r2ReadToken, send, signal, options.packetPin);
    signal.throwIfAborted();
    if (r2.qualification !== target.qualification.digest || r2.namespace !== target.qualification.prefix || r2.bucket !== target.bucket) {
      throw new Error('SNAPSHOT_CF_PUBLICATION_PACKET');
    }
    return { reviewId: options.reviewId, currentSource, observedAt: r2.observedAt, instanceAbsent: instance.instanceAbsent,
      prefixEmpty: r2.prefixEmpty, manifestAbsent: r2.manifestAbsent, canonical: r2.canonical };
  };
}

async function requireMissing(keys: Readonly<Record<'failed' | 'existing', string>>, signal: AbortSignal,
  read: typeof readSnapshotCfBytes): Promise<MissingDiagnostics> {
  for (const key of [keys.failed, keys.existing]) {
    signal.throwIfAborted();
    try { await read(['r2', 'objects', 'get', key, '--bucket-name', bucket], signal); }
    catch (error) {
      if (error instanceof MissingSnapshotDiagnostic && error.key === key) continue;
      throw error;
    }
    throw new Error('SNAPSHOT_CF_PUBLICATION_DIAGNOSTICS_PRESENT');
  }
  return { failed: null, existing: null };
}

/** Reserve at most maxInstanceReads statuses, seven receipt GETs and two exact absence GETs. */
export function createSnapshotCfOutcomeReader(options: {
  maxInstanceReads: number;
  pollIntervalMs: number;
  confirmMissing?(keys: Readonly<Record<'failed' | 'existing', string>>, signal: AbortSignal): Promise<MissingDiagnostics>;
}, read = readSnapshotCfBytes): ObservePublication {
  const { maxInstanceReads, pollIntervalMs } = options;
  const confirmMissing = options.confirmMissing ?? ((keys, signal) => requireMissing(keys, signal, read));
  if (!Number.isSafeInteger(maxInstanceReads) || maxInstanceReads < 1 ||
    !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 2_147_483_647) {
    throw new Error('SNAPSHOT_CF_PUBLICATION_BUDGET');
  }
  return async (target, signal) => {
    boundTarget(target);
    const q = target.qualification;
    const readObject = async (suffix: string) => {
      signal.throwIfAborted();
      const bytes = await read(['r2', 'objects', 'get', q.prefix + suffix, '--bucket-name', bucket], signal);
      return readJson(bytes, QUALIFICATION_RECEIPT_BYTES);
    };
    for (let attempt = 0; attempt < maxInstanceReads; attempt++) {
      signal.throwIfAborted();
      const instance = responseMetadata(await read(snapshotWorkflowInstanceArgs(q.instanceId), signal));
      const terminal = completed.safeParse(instance);
      if (terminal.success) {
        const { start, end, params, output } = terminal.data;
        if (!isDeepStrictEqual(params, { revision: q.identity.revision, qualification: q.digest })) {
          throw new Error('SNAPSHOT_CF_PUBLICATION_INSTANCE_PARAMS');
        }
        const decodedOutput = typeof output === 'string' ? readJson(Buffer.from(output), metadataBytes) : output;
        const diagnostics = { admitted: await readObject('diagnostics/admitted.json'), discovered: await readObject('diagnostics/discovered.json'),
          delegated: await readObject('diagnostics/delegated.json'), published: await readObject('diagnostics/published.json') };
        const attempts = { discovery: await readObject('attempts/discovery.json'), authoritative: await readObject('attempts/authoritative.json'),
          archive: await readObject('attempts/archive.json') };
        signal.throwIfAborted();
        const missing = await confirmMissing({ failed: q.prefix + 'diagnostics/failed.json',
          existing: q.prefix + 'diagnostics/existing.json' }, signal);
        signal.throwIfAborted();
        if (missing.failed !== null || missing.existing !== null) throw new Error('SNAPSHOT_CF_PUBLICATION_DIAGNOSTICS_ABSENCE');
        return { instance: { id: q.instanceId, status: 'complete', startedAt: start, endedAt: end, output: decodedOutput },
          diagnostics: { ...diagnostics, failed: null, existing: null }, attempts };
      }
      if (!pending.safeParse(status.safeParse(instance).data?.status).success) throw new Error('SNAPSHOT_CF_PUBLICATION_INSTANCE');
      if (attempt + 1 < maxInstanceReads) await sleep(pollIntervalMs, undefined, { signal });
    }
    throw new Error('SNAPSHOT_CF_PUBLICATION_INSTANCE_READS_EXHAUSTED');
  };
}
