import { SNAPSHOT_PARSER_VERSION } from '../../src/ingest/snapshot-format';
import type { SnapshotControlEnv } from './revision-control';

export const SNAPSHOT_STAGE_ID = 'civicsignal-v1-stage-snapshot-20261022';
export const SNAPSHOT_STAGE_COMMIT = '0507465393c224c0491fc8c17c88340217acc656';
export const SNAPSHOT_STAGE_DATE = '2026-10-15';
export const SNAPSHOT_PROBE_PREFIX = 'diagnostics/stage-2026-10-23/';
export const SNAPSHOT_PROBE_MAX_BYTES = 1024;
export const SNAPSHOT_PROBE_MARKER = 'snapshot-staging-probe-v1';

export interface StagingProbeControls extends SnapshotControlEnv {
  SNAPSHOT_STAGE_ID?: string;
}
export interface StagingProbeEvent { cron: string; scheduledTime: number }
type ReceiptPhase = 'entered' | 'completed' | 'failed';
export type ProbeBucket = Pick<R2Bucket, 'get' | 'put'>;

/** This entrypoint may only observe the one reviewed, pinned staging target. */
export function assertStagingProbe(env: StagingProbeControls): void {
  if (env.SNAPSHOT_STAGE_ID !== SNAPSHOT_STAGE_ID ||
      env.SNAPSHOT_PINNED_COMMIT !== SNAPSHOT_STAGE_COMMIT ||
      env.SNAPSHOT_PINNED_DATE !== SNAPSHOT_STAGE_DATE ||
      SNAPSHOT_PARSER_VERSION !== 'statutes-v2') {
    throw new Error('Snapshot staging probe configuration is invalid.');
  }
}

function assertEvent(event: StagingProbeEvent): void {
  if (!Number.isSafeInteger(event.scheduledTime) || event.scheduledTime < 0 ||
      typeof event.cron !== 'string' || event.cron.length === 0 || event.cron.length > 128 ||
      !/^[\x20-\x7e]+$/.test(event.cron)) {
    throw new Error('Snapshot staging probe event is invalid.');
  }
}

export async function probeEventPrefix(event: StagingProbeEvent): Promise<string> {
  assertEvent(event);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(event.cron)));
  const digest = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${SNAPSHOT_PROBE_PREFIX}${event.scheduledTime}-${digest}/`;
}

function marker(event: StagingProbeEvent, phase: ReceiptPhase): void {
  // No headers, exception text, credentials or wall-clock data enter a receipt/log.
  console.log(JSON.stringify({ marker: SNAPSHOT_PROBE_MARKER, phase, cron: event.cron, scheduledTime: event.scheduledTime }));
}

async function writeReceipt(bucket: ProbeBucket, prefix: string, event: StagingProbeEvent, phase: ReceiptPhase): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify({
    format: 1, marker: SNAPSHOT_PROBE_MARKER, stageId: SNAPSHOT_STAGE_ID,
    commit: SNAPSHOT_STAGE_COMMIT, date: SNAPSHOT_STAGE_DATE, parser: SNAPSHOT_PARSER_VERSION,
    cron: event.cron, scheduledTime: event.scheduledTime, phase,
    meaning: phase === 'completed' ? 'scheduled handler returned; Workflow completion is separate' : 'scheduled handler observation',
  }) + '\n');
  if (bytes.byteLength > SNAPSHOT_PROBE_MAX_BYTES) throw new Error('Snapshot staging probe receipt exceeds its bound.');
  const key = prefix + phase + '.json';
  await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
  const stored = await bucket.get(key);
  if (!stored || stored.size !== bytes.byteLength || stored.size > SNAPSHOT_PROBE_MAX_BYTES) {
    throw new Error('Snapshot staging probe receipt could not be verified.');
  }
  const actual = new Uint8Array(await stored.arrayBuffer());
  if (actual.length !== bytes.length || actual.some((byte, at) => byte !== bytes[at])) {
    throw new Error('Snapshot staging probe immutable receipt conflicts.');
  }
  marker(event, phase);
}

/** At most three immutable objects per cron/time, including failed replay.
 * Payloads are identical on replay; R2's upload timestamp supplies observation time.
 * The delegate is the unchanged real scheduled handler, called only after entry
 * is durable. Its deterministic Workflow ID still owns publication uniqueness. */
export async function runStagingProbe(
  env: StagingProbeControls & { CORPUS: ProbeBucket },
  event: StagingProbeEvent,
  delegate: () => Promise<void>,
): Promise<void> {
  assertStagingProbe(env);
  const prefix = await probeEventPrefix(event);
  let failure = 'Snapshot staging probe entry receipt failed.';
  try {
    await writeReceipt(env.CORPUS, prefix, event, 'entered');
    failure = 'Snapshot staging scheduled handler failed.';
    await delegate();
    failure = 'Snapshot staging probe completion receipt failed.';
    await writeReceipt(env.CORPUS, prefix, event, 'completed');
  } catch {
    // Preserve entry/failed receipts independently. Never propagate a raw
    // provider/source exception (which could contain unreviewed diagnostic data).
    try { await writeReceipt(env.CORPUS, prefix, event, 'failed'); } catch { /* R2 may itself be unavailable. */ }
    throw new Error(failure);
  }
}
