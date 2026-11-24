import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { qualificationRecord, SOURCE_PHASES, type Qualification } from '../../services/snapshot/qualification';
import type { CorpusRevision } from '../../src/ingest/source';
import { loadStagedPublication, stagedPublicationPins, verifyStagedPublicationArtifacts, type StagedPublicationPacketPin } from '../verify-staged-snapshot';
import { FRESH_SNAPSHOT_STAGE_ID } from './snapshot-calendar';
import type { SnapshotCalendarRunOptions, SnapshotCalendarWindow } from './snapshot-calendar-window';
import { runHostedSnapshotCalendarWindow } from './snapshot-hosted-admission';
import type { OpenSnapshotArtifact } from './verify-snapshot-artifacts';

type HostedOptions = Parameters<typeof runHostedSnapshotCalendarWindow>[0];
type HostedReader = NonNullable<Parameters<typeof runHostedSnapshotCalendarWindow>[1]>;
type CalendarRunner = NonNullable<Parameters<typeof runHostedSnapshotCalendarWindow>[2]>;

interface PublicationTarget {
  worker: typeof FRESH_SNAPSHOT_STAGE_ID;
  workflowId: string;
  deployment: HostedOptions['deployment'];
  bucket: string;
  configSha256: string;
  window: SnapshotCalendarWindow;
  qualification: Qualification;
  pins: typeof stagedPublicationPins;
  evidenceTime: Readonly<{ admissionMs: number; observationMs: number }>;
}

interface PublicationAdmission {
  reviewId: string;
  observedAt: string;
  currentSource: CorpusRevision;
  prefixEmpty: boolean;
  manifestAbsent: boolean;
  instanceAbsent: boolean;
  canonical: { sha256: string; bytes: number };
}

interface PublicationOutcome {
  instance: { id: string; status: string; startedAt: string; endedAt: string; output: unknown };
  diagnostics: Record<'admitted' | 'discovered' | 'delegated' | 'published' | 'failed' | 'existing', unknown>;
  attempts: Record<typeof SOURCE_PHASES[number], unknown>;
}

interface PublicationEvidence {
  readHosted: HostedReader;
  // The process owner checks the private approval and budgets all provider
  // calls behind these two evidence adapters before supplying them.
  admit(target: PublicationTarget, signal: AbortSignal): Promise<PublicationAdmission>;
  observePublication(target: PublicationTarget, signal: AbortSignal): Promise<PublicationOutcome>;
  openArtifact(target: PublicationTarget): OpenSnapshotArtifact;
}

function requirePublication(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`SNAPSHOT_PUBLICATION_${code}`);
}

async function observeWithin<T>(milliseconds: number, observe: (signal: AbortSignal) => Promise<T>) {
  const deadline = new AbortController();
  try {
    const expired = sleep(milliseconds, undefined, { signal: deadline.signal }).then(() => {
      throw new Error('SNAPSHOT_PUBLICATION_EVIDENCE_DEADLINE');
    });
    return await Promise.race([expired, Promise.resolve().then(() => observe(deadline.signal))]);
  } finally {
    deadline.abort();
  }
}

function checkOutcome(outcome: PublicationOutcome, q: Qualification) {
  const { instance, diagnostics, attempts } = outcome;
  const { rows } = stagedPublicationPins.reference;
  const start = Date.parse(instance.startedAt), end = Date.parse(instance.endedAt);
  const { event: { scheduledTime: scheduled }, runtimeDeadline } = q.identity;
  requirePublication(instance.id === q.instanceId && instance.status === 'complete' && start >= scheduled &&
    end >= start && runtimeDeadline !== undefined && end < runtimeDeadline, 'WORKFLOW');
  const { qualification, namespace, instanceId, commit, count, existing } = (instance.output ?? {}) as Record<string, unknown>;
  requirePublication(qualification === q.digest && namespace === q.prefix && instanceId === q.instanceId &&
    commit === q.identity.revision.commit && count === rows && existing === undefined, 'WORKFLOW_OUTPUT');
  requirePublication(diagnostics.failed === null && diagnostics.existing === null &&
    isDeepStrictEqual(diagnostics.admitted, qualificationRecord(q, 'admitted')) &&
    isDeepStrictEqual(diagnostics.discovered, qualificationRecord(q, 'discovered')) &&
    isDeepStrictEqual(diagnostics.delegated, qualificationRecord(q, 'delegated-not-publication')) &&
    isDeepStrictEqual(diagnostics.published, { ...qualificationRecord(q, 'published'), count: rows, existing: false }), 'DIAGNOSTICS');
  requirePublication(SOURCE_PHASES.every(phase => isDeepStrictEqual(attempts[phase], qualificationRecord(q, phase))), 'SOURCE_ATTEMPTS');
  return { id: instance.id, status: instance.status, startedAt: instance.startedAt, endedAt: instance.endedAt };
}

/** Compose the November staging calendar and verifier under one reviewed packet.
 * Evidence providers and approval remain explicit at this programmatic boundary. */
export async function runStagedSnapshotPublication(options: Omit<SnapshotCalendarRunOptions, 'window' | 'target' | 'admit'> & {
  packetPath: string;
  packetPin?: StagedPublicationPacketPin;
  deployment: HostedOptions['deployment'] & { configSha256: string; workflowId: string };
  evidenceTime: PublicationTarget['evidenceTime'];
}, evidence: PublicationEvidence, runCalendar?: CalendarRunner) {
  const packet = await loadStagedPublication(options.packetPath, options.packetPin);
  const { qualification, window: { scheduledAt, clearAt, cleanupDeadline }, bucket } = packet.publication;
  const { deploymentId, versionId, workflowId, configSha256 } = options.deployment;
  const { canonical } = stagedPublicationPins;
  const { runtimeDeadline } = qualification.identity;
  requirePublication(clearAt && cleanupDeadline && workflowId && packet.configSha256 && configSha256 === packet.configSha256 &&
    runtimeDeadline !== undefined && Date.parse(cleanupDeadline) < runtimeDeadline, 'PACKET');
  const window = Object.freeze({ scheduledAt, clearAt, cleanupDeadline });
  const evidenceTime = Object.freeze({ ...options.evidenceTime });
  requirePublication([evidenceTime.admissionMs, evidenceTime.observationMs].every(value =>
    Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647), 'EVIDENCE_TIME');
  const target: PublicationTarget = Object.freeze({ worker: FRESH_SNAPSHOT_STAGE_ID, workflowId,
    deployment: Object.freeze({ deploymentId, versionId }), bucket, configSha256, window, qualification,
    pins: stagedPublicationPins, evidenceTime });
  let admission: PublicationAdmission | undefined;
  const calendar = await runHostedSnapshotCalendarWindow({ window, target: FRESH_SNAPSHOT_STAGE_ID, workflowId,
    deployment: { deploymentId, versionId }, operator: options.operator, guards: options.guards, journal: options.journal,
    async admit() {
      const admissionStarted = Date.now();
      admission = await observeWithin(evidenceTime.admissionMs, signal => evidence.admit(target, signal));
      const observed = Date.parse(admission.observedAt);
      requirePublication(typeof admission.reviewId === 'string' && admission.reviewId.length > 0 && admission.reviewId.length <= 128 &&
        isDeepStrictEqual(admission.currentSource, qualification.identity.revision) && observed >= admissionStarted &&
        observed <= Date.now() && observed < qualification.identity.event.scheduledTime &&
        admission.prefixEmpty === true && admission.manifestAbsent === true && admission.instanceAbsent === true &&
        admission.canonical.sha256 === canonical.sha256 && admission.canonical.bytes === canonical.bytes, 'ADMISSION');
    },
  }, evidence.readHosted, runCalendar);
  requirePublication(admission && calendar.passed, 'CALENDAR');
  const instance = checkOutcome(await observeWithin(evidenceTime.observationMs, signal => evidence.observePublication(target, signal)), qualification);
  const artifacts = await verifyStagedPublicationArtifacts(evidence.openArtifact(target));
  return { scope: 'staging-first-publication', worker: target.worker, workflowId: target.workflowId,
    deployment: target.deployment, configSha256, qualification: qualification.digest, namespace: qualification.prefix,
    source: qualification.identity.revision, reviewedAdmissionAt: admission.observedAt, canonicalBeforeArming: { sha256: canonical.sha256, bytes: canonical.bytes },
    calendar, instance, sourceAttempts: SOURCE_PHASES, artifacts };
}
