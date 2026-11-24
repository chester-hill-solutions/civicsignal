import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import novemberWorkflowCreation from '../../docs/evidence/2026-11-22/november-workflow-creation.json';
import { QUALIFICATION_STAGE_ID } from '../../services/snapshot/qualification';
import { STAGING_ACCOUNT, stagingNames } from './staging-config';
import { FRESH_SNAPSHOT_STAGE_ID, snapshotStageTarget, type SnapshotStageTarget } from './snapshot-calendar';
import { runSnapshotCalendarWindow, type SnapshotCalendarRunOptions } from './snapshot-calendar-window';

const exec = promisify(execFile);
const version = z.object({ version_id: z.uuid(), percentage: z.number().min(0).max(100) });
const deployment = z.object({ id: z.uuid(), versions: z.array(version).min(1) });
const deploymentList = z.union([z.array(deployment), z.object({ deployments: z.array(deployment) })]);
const workflow = z.object({ name: snapshotStageTarget, script_name: snapshotStageTarget,
  class_name: z.literal('CorpusSnapshot'), script_deleted: z.literal(false).optional(),
  id: z.uuid().optional(), created_on: z.iso.datetime().optional(), modified_on: z.iso.datetime().optional(),
  schedules: z.array(z.union([z.string(), z.object({ cron: z.string() })])).optional() });
export const snapshotDeploymentPin = z.object({ deploymentId: z.uuid(), versionId: z.uuid() }).strict();
type DeploymentPin = z.infer<typeof snapshotDeploymentPin>;

export class MissingSnapshotDiagnostic extends Error {
  constructor(readonly key: string) { super('SNAPSHOT_HOSTED_DIAGNOSTIC_MISSING'); }
}

/** cf beta.10 reports the provider code and the exact object path on stderr. */
export function missingSnapshotDiagnosticKey(args: string[], error: unknown): string | undefined {
  const key = args[3] ?? '';
  const bucket = stagingNames('20261022').corpus;
  if (args.length !== 6 || args.slice(0, 3).join(' ') !== 'r2 objects get' ||
    args[4] !== '--bucket-name' || args[5] !== bucket ||
    !/^qualifications\/[a-z][a-z0-9-]{0,39}\/[0-9a-f]{64}\/diagnostics\/(?:failed|existing)\.json$/.test(key)) return;
  const failure = z.object({ code: z.literal(1), stderr: z.instanceof(Buffer) }).safeParse(error);
  if (!failure.success) return;
  const lines = stripVTControlCharacters(failure.data.stderr.toString('utf8')).split(/\r?\n/);
  const path = `/accounts/${STAGING_ACCOUNT}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`;
  if (lines.includes('│ [10007] The specified key does not exist.') && lines.includes(`│ 404 Not Found · HTTP ${path}`)) return key;
}

/** The staging metadata and canonical reference reads fit in 64 KiB. */
export async function readSnapshotCfBytes(args: string[], signal?: AbortSignal): Promise<Buffer> {
  try {
    const { stdout } = await exec('cf', args, { signal, timeout: 10_000, maxBuffer: 64 * 1024, encoding: 'buffer',
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: STAGING_ACCOUNT, CF_TELEMETRY_DISABLED: '1' } });
    return stdout;
  } catch (error) {
    const missing = missingSnapshotDiagnosticKey(args, error);
    if (!signal?.aborted && missing) throw new MissingSnapshotDiagnostic(missing);
    throw new Error('SNAPSHOT_HOSTED_CF_READ');
  }
}

async function readCf(args: string[]): Promise<unknown> {
  const bytes = await readSnapshotCfBytes(args);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('SNAPSHOT_HOSTED_CF_READ'); }
}

export async function observeSnapshotHostedDeployment(read = readCf, target: SnapshotStageTarget = QUALIFICATION_STAGE_ID) {
  const worker = snapshotStageTarget.parse(target);
  const [workerResult, workflowResult] = await Promise.all([
    read(['workers', 'deployments', 'list', '--worker', worker, '--per-page', '1']),
    read(['workflows', 'get', worker]),
  ]);
  const listing = deploymentList.safeParse(workerResult), installed = workflow.safeParse(workflowResult);
  if (!listing.success || !installed.success || installed.data.name !== worker || installed.data.script_name !== worker) {
    throw new Error('SNAPSHOT_HOSTED_IDENTITY');
  }
  const active = (Array.isArray(listing.data) ? listing.data : listing.data.deployments)[0];
  if (!active) throw new Error('SNAPSHOT_HOSTED_DEPLOYMENT_ABSENT');
  const schedules = installed.data.schedules;
  const nativeCalendar = schedules === undefined ? 'unknown' : schedules.length ? 'configured' : 'empty';
  const creation = novemberWorkflowCreation;
  const matchesUnscheduledCreation = worker === FRESH_SNAPSHOT_STAGE_ID && worker === creation.worker && creation.accountId === STAGING_ACCOUNT &&
    creation.absentBeforeDeployment.workerHttpStatus === 404 && creation.absentBeforeDeployment.workflowHttpStatus === 404 &&
    creation.bootstrap.nativeSchedulesConfigured === 0 && creation.workflow.createdOn === creation.workflow.modifiedOn &&
    installed.data.id === creation.workflow.id &&
    installed.data.created_on === creation.workflow.createdOn && installed.data.modified_on === creation.workflow.modifiedOn;
  const nativeCalendarEvidence = nativeCalendar === 'empty' ? 'provider-empty-list' :
    nativeCalendar === 'unknown' && matchesUnscheduledCreation ? 'unscheduled-creation' : null;
  return { worker, deploymentId: active.id, versions: active.versions, workflowId: installed.data.id,
    workflowModifiedOn: installed.data.modified_on, nativeCalendar, nativeCalendarEvidence,
    observedAt: new Date().toISOString() };
}

export async function requireSnapshotHostedDeployment(expected: DeploymentPin, read = readCf, target: SnapshotStageTarget = QUALIFICATION_STAGE_ID) {
  const pin = snapshotDeploymentPin.parse(expected);
  const observed = await observeSnapshotHostedDeployment(read, target);
  if (observed.deploymentId !== pin.deploymentId || observed.versions.length !== 1 ||
    observed.versions[0]?.version_id !== pin.versionId || observed.versions[0]?.percentage !== 100) {
    throw new Error('SNAPSHOT_HOSTED_DEPLOYMENT_DRIFT');
  }
  if (!observed.nativeCalendarEvidence) throw new Error(`SNAPSHOT_HOSTED_NATIVE_CALENDAR_${observed.nativeCalendar.toUpperCase()}`);
  return observed;
}

/** Bind the calendar phase to the IDs from the reviewed bundle's upload receipt.
 * The publication caller supplies namespace, instance, backup and budget admission. */
export function runHostedSnapshotCalendarWindow(options: SnapshotCalendarRunOptions & { deployment: DeploymentPin; workflowId?: string },
  read = readCf, run = runSnapshotCalendarWindow) {
  const pin = snapshotDeploymentPin.parse(options.deployment);
  const workflowId = z.uuid().optional().parse(options.workflowId);
  const target = snapshotStageTarget.parse(options.target ?? QUALIFICATION_STAGE_ID);
  return run({ ...options, target, async admit(window) {
    await options.admit(window);
    const observed = await requireSnapshotHostedDeployment(pin, read, target);
    if (workflowId && observed.workflowId !== workflowId) throw new Error('SNAPSHOT_HOSTED_WORKFLOW_DRIFT');
  } });
}
