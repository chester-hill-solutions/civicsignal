import { describe, expect, it, vi } from 'vitest';
import creation from '../docs/evidence/2026-11-22/november-workflow-creation.json';
import { FRESH_SNAPSHOT_STAGE_ID } from '../scripts/lib/snapshot-calendar';
import { observeSnapshotHostedDeployment, requireSnapshotHostedDeployment,
  runHostedSnapshotCalendarWindow } from '../scripts/lib/snapshot-hosted-admission';

const worker = 'civicsignal-v1-stage-snapshot-20261022';
const pin = { deploymentId: '8ff9cc98-f7de-4735-aeea-5c35c9d1b201', versionId: 'f00194fb-5062-4b0a-930b-b2aa12ded3f5' };
const active = { id: pin.deploymentId, versions: [{ version_id: pin.versionId, percentage: 100 }] };
const workflow = { name: worker, script_name: worker, class_name: 'CorpusSnapshot' };
const freshWorkflow = { ...workflow, name: FRESH_SNAPSHOT_STAGE_ID, script_name: FRESH_SNAPSHOT_STAGE_ID,
  id: creation.workflow.id, created_on: creation.workflow.createdOn, modified_on: creation.workflow.modifiedOn };
const readFixture = (deployments: unknown = { deployments: [active] }, installed: unknown = { ...workflow, schedules: [] }) =>
  vi.fn(async (args: string[]) => args[0] === 'workers' ? deployments : installed);

describe('hosted snapshot admission', () => {
  it('reads the fixed resources and accepts a pinned single deployment and explicitly empty native calendar', async () => {
    const read = readFixture();
    await expect(requireSnapshotHostedDeployment(pin, read)).resolves.toMatchObject({ worker, nativeCalendar: 'empty', deploymentId: pin.deploymentId });
    expect(read.mock.calls).toEqual([[['workers', 'deployments', 'list', '--worker', worker, '--per-page', '1']],
      [['workflows', 'get', worker]]]);
  });

  it.each([{ installed: workflow, state: 'unknown' },
    { installed: { ...workflow, schedules: [{ cron: '0 0 * * *', next_instance: '2030-01-01T00:00:00Z' }] }, state: 'configured' }])
    ('reports and refuses a $state native calendar', async ({ installed, state }) => {
      const read = readFixture([active], installed);
      await expect(observeSnapshotHostedDeployment(read)).resolves.toMatchObject({ nativeCalendar: state });
      await expect(requireSnapshotHostedDeployment(pin, read)).rejects.toThrow(`SNAPSHOT_HOSTED_NATIVE_CALENDAR_${state.toUpperCase()}`);
    });

  it('refuses drift and split traffic', async () => {
    const shifted = { ...active, id: '69a34c03-cc72-4692-9663-ccd9da23ac2b' };
    const split = { ...active, versions: [...active.versions, { version_id: shifted.id, percentage: 0 }] };
    for (const value of [shifted, split]) {
      await expect(requireSnapshotHostedDeployment(pin, readFixture([value]))).rejects.toThrow('SNAPSHOT_HOSTED_DEPLOYMENT_DRIFT');
    }
  });

  it('refuses a deleted or differently bound Workflow', async () => {
    for (const installed of [{ ...workflow, script_deleted: true }, { ...workflow, script_name: 'other-worker' }]) {
      await expect(requireSnapshotHostedDeployment(pin, readFixture([active], installed))).rejects.toThrow('SNAPSHOT_HOSTED_IDENTITY');
    }
  });

  it('observes the fresh deployment without accepting an older Workflow binding', async () => {
    const read = readFixture([active], freshWorkflow);
    await expect(observeSnapshotHostedDeployment(read, FRESH_SNAPSHOT_STAGE_ID))
      .resolves.toMatchObject({ worker: FRESH_SNAPSHOT_STAGE_ID, nativeCalendar: 'unknown', nativeCalendarEvidence: 'unscheduled-creation' });
    await expect(requireSnapshotHostedDeployment(pin, read, FRESH_SNAPSHOT_STAGE_ID))
      .resolves.toMatchObject({ nativeCalendarEvidence: 'unscheduled-creation' });
    await expect(observeSnapshotHostedDeployment(readFixture(), FRESH_SNAPSHOT_STAGE_ID)).rejects.toThrow('SNAPSHOT_HOSTED_IDENTITY');
  });

  it.each([{ id: pin.versionId }, { created_on: '2026-11-23T02:29:06.702Z' }, { modified_on: '2026-11-23T02:30:00.000Z' },
    { modified_on: undefined }])('refuses inferred evidence on Workflow drift %j', async change => {
    await expect(requireSnapshotHostedDeployment(pin, readFixture([active], { ...freshWorkflow, ...change }), FRESH_SNAPSHOT_STAGE_ID))
      .rejects.toThrow('SNAPSHOT_HOSTED_NATIVE_CALENDAR_UNKNOWN');
  });

  it('gives a reported schedule precedence over the creation evidence', async () => {
    const read = readFixture([active], { ...freshWorkflow, schedules: [{ cron: '0 0 * * *' }] });
    await expect(requireSnapshotHostedDeployment(pin, read, FRESH_SNAPSHOT_STAGE_ID)).rejects.toThrow('SNAPSHOT_HOSTED_NATIVE_CALENDAR_CONFIGURED');
  });

  it('binds fresh deployment admission before the calendar phase runs', async () => {
    const credential = { token: 'fixture', validUntil: '2030-01-01T04:00:00.000Z' };
    const window = { scheduledAt: '2030-01-01T03:00:00.000Z', clearAt: '2030-01-01T03:15:00.000Z', cleanupDeadline: '2030-01-01T03:20:00.000Z' };
    const options = { window, operator: credential, guards: { primary: credential, backup: credential }, journal: '/fixture/journal',
      deployment: pin, admit: vi.fn().mockResolvedValue(undefined) };
    const continueToArm = vi.fn();
    const run: NonNullable<Parameters<typeof runHostedSnapshotCalendarWindow>[2]> = async input => {
      await input.admit(input.window);
      return continueToArm();
    };
    await expect(runHostedSnapshotCalendarWindow(options, readFixture([active], workflow), run))
      .rejects.toThrow('SNAPSHOT_HOSTED_NATIVE_CALENDAR_UNKNOWN');
    expect(continueToArm).not.toHaveBeenCalled();
    await runHostedSnapshotCalendarWindow(options, readFixture(), run);
    await runHostedSnapshotCalendarWindow({ ...options, target: FRESH_SNAPSHOT_STAGE_ID }, readFixture([active], freshWorkflow), run);
    expect(options.admit).toHaveBeenCalledWith(window);
    expect(continueToArm).toHaveBeenCalledTimes(2);
  });
});
