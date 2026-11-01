import type { CorpusRevision } from '../../src/ingest/source';
import { manifestKey, parseManifest, SNAPSHOT_PARSER_VERSION } from '../../src/ingest/snapshot-format';
import { assertSnapshotRevision, assertSourceRevision, type SnapshotControlEnv } from './revision-control';
import { qualificationReceipt } from './qualification-store';
import { SourceHeadError } from '../../src/ingest/source-head';

export const QUALIFICATION_STAGE_ID = 'civicsignal-v1-stage-snapshot-20261022';
export const QUALIFICATION_MARKER = 'snapshot-first-publication-v1';
/** Our qualification's spend-admission cap, not a scheduler delivery promise. */
export const QUALIFICATION_SOURCE_START_WINDOW_MS = 15 * 60 * 1000;
export const SOURCE_PHASES = ['discovery', 'authoritative', 'archive'] as const;
export type SourcePhase = typeof SOURCE_PHASES[number];
export interface QualificationControls extends SnapshotControlEnv {
  SNAPSHOT_STAGE_ID?: string;
  SNAPSHOT_QUALIFICATION_ID?: string;
  SNAPSHOT_QUALIFICATION_CRON?: string;
  SNAPSHOT_QUALIFICATION_TIME?: string;
  SNAPSHOT_QUALIFICATION_DEADLINE?: string;
}
export interface QualificationEvent { cron: string; scheduledTime: number }
export interface QualificationIdentity {
  format: 1; stageId: string; id: string; revision: CorpusRevision; parser: string;
  event: QualificationEvent; sourceAttempts: 3; sourceStartWindowMs: number;
  /** Absent only on retained legacy identities; new execution requires it. */
  runtimeDeadline?: number;
}
export interface Qualification {
  identity: QualificationIdentity; digest: string; prefix: string; instanceId: string;
}
export type QualificationBucket = Pick<R2Bucket, 'get' | 'head' | 'put'>;
export interface QualificationWorkflowBinding {
  create(options: { id: string; params: QualificationParams }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
}
export interface QualificationParams { revision: CorpusRevision; qualification: string }

/** A reviewed calendar event, real source revision and parser jointly determine
 * both identities. No configured output path or alternate source URL is accepted. */
export async function qualificationIdentity(env: QualificationControls): Promise<Qualification> {
  const revision = { commit: env.SNAPSHOT_PINNED_COMMIT ?? '', date: env.SNAPSHOT_PINNED_DATE ?? '' };
  assertSnapshotRevision(env, revision);
  const id = env.SNAPSHOT_QUALIFICATION_ID;
  const time = env.SNAPSHOT_QUALIFICATION_TIME;
  const cron = env.SNAPSHOT_QUALIFICATION_CRON;
  if (env.SNAPSHOT_STAGE_ID !== QUALIFICATION_STAGE_ID || !id || !/^[a-z][a-z0-9-]{0,39}$/.test(id) ||
    !time || !/^(0|[1-9]\d{0,15})$/.test(time) || typeof cron !== 'string' || SNAPSHOT_PARSER_VERSION !== 'statutes-v2') throw new Error('Qualification configuration is invalid.');
  const scheduledTime = Number(time), at = new Date(scheduledTime);
  if (!Number.isSafeInteger(scheduledTime) || !Number.isFinite(at.getTime()) || scheduledTime % 60000 !== 0 ||
    cron !== `${at.getUTCMinutes()} ${at.getUTCHours()} ${at.getUTCDate()} ${at.getUTCMonth() + 1} *`) throw new Error('Qualification calendar is invalid.');
  const identity: QualificationIdentity = { format: 1, stageId: QUALIFICATION_STAGE_ID, id, revision,
    parser: SNAPSHOT_PARSER_VERSION, event: { cron, scheduledTime }, sourceAttempts: 3, sourceStartWindowMs: QUALIFICATION_SOURCE_START_WINDOW_MS };
  if (env.SNAPSHOT_QUALIFICATION_DEADLINE !== undefined) {
    const raw = env.SNAPSHOT_QUALIFICATION_DEADLINE, deadline = Number(raw);
    if (!/^[1-9]\d{0,15}$/.test(raw) || !Number.isSafeInteger(deadline) || deadline <= scheduledTime ||
      deadline > scheduledTime + 3 * 60 * 60 * 1000) throw new Error('Qualification runtime deadline is invalid.');
    identity.runtimeDeadline = deadline;
  }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(identity)))), n => n.toString(16).padStart(2, '0')).join('');
  return { identity, digest, prefix: `qualifications/${id}/${digest}/`, instanceId: `qual-${digest}` };
}

export function qualificationRecord(q: Qualification, phase: string) {
  return { marker: QUALIFICATION_MARKER, identity: q.identity, digest: q.digest, instanceId: q.instanceId, phase };
}

export function qualificationSourceWindow(q: Qualification, now: () => number = Date.now): 'early' | 'open' | 'expired' | 'invalid-clock' {
  const at = now();
  if (!Number.isFinite(at)) return 'invalid-clock';
  if (at < q.identity.event.scheduledTime) return 'early';
  return at < q.identity.event.scheduledTime + q.identity.sourceStartWindowMs ? 'open' : 'expired';
}
export function assertQualificationSourceWindow(q: Qualification, now: () => number = Date.now): void {
  const at = now();
  assertQualificationRuntimeDeadline(q, at);
  if (qualificationSourceWindow(q, () => at) !== 'open') throw new Error('Qualification source-start window is closed.');
}
export function assertQualificationRuntimeDeadline(q: Qualification, at: number): void {
  const deadline = q.identity.runtimeDeadline;
  if (!Number.isSafeInteger(deadline) || deadline! <= q.identity.event.scheduledTime || deadline! > q.identity.event.scheduledTime + 10800000 ||
    !Number.isFinite(at) || at >= deadline!) throw new Error('Qualification runtime deadline is missing or closed.');
}

/** Exactly one acknowledged owner per phase, across isolates, step retries and
 * Workflow restarts. A failure/lost ACK consumes that phase without a refund. */
export async function reserveSourceAttempt(bucket: QualificationBucket, q: Qualification, phase: SourcePhase, now: () => number = Date.now): Promise<void> {
  if (!SOURCE_PHASES.includes(phase)) throw new Error('Qualification source phase is invalid.');
  assertQualificationSourceWindow(q, now);
  if (!await qualificationReceipt(bucket, q.prefix + `attempts/${phase}.json`, qualificationRecord(q, phase))) throw new Error('Qualification source attempt is already reserved.');
}

function observedEvent(event: QualificationEvent) {
  // Never persist untrusted strings, paths, headers or raw exception messages.
  const cron = typeof event?.cron === 'string' && /^[\d* /,-]{1,128}$/.test(event.cron) ? event.cron : null;
  const scheduledTime = Number.isSafeInteger(event?.scheduledTime) && event.scheduledTime >= 0 ? event.scheduledTime : null;
  return { cron, scheduledTime };
}

/** Wrong controller tuples have bounded evidence before rejection. At most one
 * accepted and one rejected ingress slot exist for the configured qualification;
 * arbitrary rejected tuples never select object names or reserve source work. */
export async function runQualificationScheduled(env: QualificationControls & { CORPUS: QualificationBucket; SNAPSHOT: QualificationWorkflowBinding },
  event: QualificationEvent, sourceHead: (q: Qualification) => Promise<CorpusRevision>, now: () => number = Date.now): Promise<void> {
  let q: Qualification;
  try { q = await qualificationIdentity(env); assertQualificationRuntimeDeadline(q, now()); }
  catch { console.log(JSON.stringify({ marker: QUALIFICATION_MARKER, phase: 'configuration-rejected' })); throw new Error('Qualification configuration was rejected.'); }
  const observed = observedEvent(event);
  const window = qualificationSourceWindow(q, now);
  const admitted = observed.cron === q.identity.event.cron && observed.scheduledTime === q.identity.event.scheduledTime && window === 'open';
  console.log(JSON.stringify({ marker: QUALIFICATION_MARKER, phase: 'ingress', qualification: q.digest, admitted, observed, window }));
  if (!admitted) {
    await qualificationReceipt(env.CORPUS, q.prefix + 'diagnostics/rejected.json', { ...qualificationRecord(q, 'rejected'), observed, window });
    throw new Error('Qualification controller tuple was rejected.');
  }
  try {
    assertQualificationSourceWindow(q, now);
    if (!await qualificationReceipt(env.CORPUS, q.prefix + 'diagnostics/admitted.json', qualificationRecord(q, 'admitted'))) return;
    // No automatic recovery after a prior uncertain/failed source or create.
    if (await env.CORPUS.head(q.prefix + 'diagnostics/failed.json')) return;
    const existing = await env.CORPUS.get(q.prefix + manifestKey(q.identity.revision.commit, q.identity.parser));
    if (existing) {
      const manifest = parseManifest(await existing.text());
      assertSourceRevision(q.identity.revision, manifest);
      if (manifest.parser !== q.identity.parser) throw new Error('Qualification publication parser differs.');
      await qualificationReceipt(env.CORPUS, q.prefix + 'diagnostics/existing.json', qualificationRecord(q, 'existing-publication'));
      return;
    }
    assertQualificationSourceWindow(q, now);
    assertSourceRevision(q.identity.revision, await sourceHead(q));
    await qualificationReceipt(env.CORPUS, q.prefix + 'diagnostics/discovered.json', qualificationRecord(q, 'discovered'));
    try { await env.SNAPSHOT.create({ id: q.instanceId, params: { revision: q.identity.revision, qualification: q.digest } }); }
    catch {
      // An unknown create acknowledgement can only join this exact instance.
      // Never create another ID, restart or retry create from a replayed event.
      const instance = await env.SNAPSHOT.get(q.instanceId);
      const { status } = await instance.status();
      if (!['queued', 'running', 'waiting', 'paused', 'complete'].includes(status)) throw new Error('Qualification Workflow requires operator review.');
    }
    await qualificationReceipt(env.CORPUS, q.prefix + 'diagnostics/delegated.json', qualificationRecord(q, 'delegated-not-publication'));
  } catch (error) {
    const sourceFailure = error instanceof SourceHeadError ? { code: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(Object.keys(error.rateLimits).length ? { rateLimits: error.rateLimits } : {}),
    } : undefined;
    try { await qualificationReceipt(env.CORPUS, q.prefix + 'diagnostics/failed.json', {
      ...qualificationRecord(q, 'failed-or-uncertain'), ...(sourceFailure ? { sourceFailure } : {}),
    }); } catch { /* A log is not durable receipt evidence. */ }
    throw new Error('Qualification scheduled work failed or is uncertain.' + (sourceFailure ? ` ${JSON.stringify({ sourceFailure })}` : ''));
  }
}
