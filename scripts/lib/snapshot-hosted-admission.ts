import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import novemberWorkflowCreation from '../../docs/evidence/2026-11-22/november-workflow-creation.json';
import { QUALIFICATION_STAGE_ID } from '../../services/snapshot/qualification';
import { STAGING_ACCOUNT } from './staging-config';
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

async function readCf(args: string[]): Promise<unknown> {
  try {
    const { stdout } = await exec('cf', args, { timeout: 10_000, maxBuffer: 64 * 1024,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: STAGING_ACCOUNT, CF_TELEMETRY_DISABLED: '1' } });
    return JSON.parse(stdout);
  } catch {
    throw new Error('SNAPSHOT_HOSTED_CF_READ');
  }
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
export function runHostedSnapshotCalendarWindow(options: SnapshotCalendarRunOptions & { deployment: DeploymentPin },
  read = readCf, run = runSnapshotCalendarWindow) {
  const pin = snapshotDeploymentPin.parse(options.deployment);
  const target = snapshotStageTarget.parse(options.target ?? QUALIFICATION_STAGE_ID);
  return run({ ...options, target, async admit(window) {
    await options.admit(window);
    await requireSnapshotHostedDeployment(pin, read, target);
  } });
}
