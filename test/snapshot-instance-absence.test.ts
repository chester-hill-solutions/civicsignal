import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import creation from '../docs/evidence/2026-11-22/november-workflow-creation.json';
import { QUALIFICATION_STAGE_ID, qualificationIdentity } from '../services/snapshot/qualification';
import { FRESH_SNAPSHOT_STAGE_ID as worker } from '../scripts/lib/snapshot-calendar';
import { MissingSnapshotWorkflowInstance, missingSnapshotWorkflowInstanceId, requireSnapshotWorkflowInstanceAbsent } from '../scripts/lib/snapshot-hosted-admission';
import { STAGING_ACCOUNT, stagingNames } from '../scripts/lib/staging-config';
import { stagedPublicationPins } from '../scripts/verify-staged-snapshot';

const instanceId = 'qual-b2b763a9599803fe0ed7aa1c8dd2575cbf78590ed666f755a48f2308e6a55b54';
const other = 'qual-' + 'a'.repeat(64);
const args = ['workflows', 'instances', 'get', instanceId, '--workflow-name', worker, '--simple', 'true'];
const exactPath = `/accounts/${STAGING_ACCOUNT}/workflows/${worker}/instances/${instanceId}?simple=true`;
const status = `│ 404 Not Found · HTTP ${exactPath}`;
const provider = '│ [10400] workflows.api.error.instance.not_found';
const refusal = (statusLine: string, providerLine: string) => ({ code: 1, stderr: Buffer.from(`${statusLine}\n${providerLine}\n`) });

describe('exact staging Workflow instance absence', () => {
  it('binds cf beta.10 status and provider code to the full request path', () => {
    expect(missingSnapshotWorkflowInstanceId(args, refusal(status, provider))).toBe(instanceId);
    expect(missingSnapshotWorkflowInstanceId(args, refusal(`\x1b[31m${status}\x1b[0m`, provider))).toBe(instanceId);
  });

  it.each([
    [status.replace('404 Not Found', '403 Forbidden'), provider],
    [status.replace(instanceId, other), provider],
    [status.replace('?simple=true', ''), provider],
    [status, '│ [10400] workflows.api.error.workflow.not_found'],
    [status, '│ [10007] The specified key does not exist.'],
    [status, ''],
  ])('refuses ambiguous metadata %s / %s', (statusLine, providerLine) => {
    expect(missingSnapshotWorkflowInstanceId(args, refusal(statusLine, providerLine))).toBeUndefined();
  });

  it('rejects a different Worker, alternative arguments and untyped subprocess failures', () => {
    const otherWorker = [...args];
    otherWorker[5] = 'production';
    expect(missingSnapshotWorkflowInstanceId(otherWorker, refusal(status, provider))).toBeUndefined();
    expect(missingSnapshotWorkflowInstanceId([...args.slice(0, -1), 'false'], refusal(status, provider))).toBeUndefined();
    expect(missingSnapshotWorkflowInstanceId(args, { ...refusal(status, provider), code: 'ETIMEDOUT' })).toBeUndefined();
  });

  it('confirms only a typed match and preserves the same request signal', async () => {
    const read = vi.fn().mockRejectedValue(new MissingSnapshotWorkflowInstance(instanceId));
    const { signal } = new AbortController();
    await expect(requireSnapshotWorkflowInstanceAbsent(instanceId, signal, read)).resolves.toMatchObject({
      worker, instanceId, instanceAbsent: true, httpStatus: 404, providerCode: 10400,
    });
    expect(read).toHaveBeenCalledWith(args, signal);
  });

  it('refuses existing instances, mismatched exceptions, and aborted reads', async () => {
    const read = vi.fn().mockResolvedValueOnce(Buffer.from('{}')).mockRejectedValueOnce(new MissingSnapshotWorkflowInstance(other));
    await expect(requireSnapshotWorkflowInstanceAbsent(instanceId, undefined, read)).rejects.toThrow('SNAPSHOT_HOSTED_INSTANCE_PRESENT');
    await expect(requireSnapshotWorkflowInstanceAbsent(instanceId, undefined, read)).rejects.toMatchObject({ instanceId: other });
    await expect(requireSnapshotWorkflowInstanceAbsent(instanceId, AbortSignal.abort(), read)).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('runs the preflight CLI using the packet-derived instance and a controlled cf process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'snapshot-instance-absence-'));
    try {
      const scheduledAt = '2026-11-23T03:47:00.000Z', runtimeDeadline = '2026-11-23T05:47:00.000Z';
      const { reference } = stagedPublicationPins;
      const qualification = await qualificationIdentity({ SNAPSHOT_STAGE_ID: QUALIFICATION_STAGE_ID,
        SNAPSHOT_PINNED_COMMIT: reference.commit, SNAPSHOT_PINNED_DATE: reference.date, SNAPSHOT_QUALIFICATION_ID: 'nov16-20261123-0347',
        SNAPSHOT_QUALIFICATION_CRON: '47 3 23 11 *', SNAPSHOT_QUALIFICATION_TIME: String(Date.parse(scheduledAt)),
        SNAPSHOT_QUALIFICATION_DEADLINE: String(Date.parse(runtimeDeadline)) });
      expect(qualification.instanceId).toBe(instanceId);
      const packet = join(directory, 'prepared-stage.json');
      await writeFile(packet, JSON.stringify({ target: worker,
        bundle: { bytes: creation.bootstrap.bundleBytes, sha256: creation.bootstrap.bundleSha256 },
        publication: { bucket: stagingNames('20261022').corpus, referenceManifestSha256: reference.manifest.sha256,
          window: { scheduledAt }, runtimeDeadline, qualification } }));
      await writeFile(join(directory, 'cf'), `#!/bin/sh
[ "$*" = '${args.join(' ')}' ] || exit 9
printf '%s\\n' '${status}' '${provider}' >&2
exit 1
`, { mode: 0o700 });
      const output = execFileSync('bun', ['--no-env-file', 'scripts/check-snapshot-hosted.ts', '--fresh', '--instance-absent', '--packet', packet], {
        encoding: 'utf8', timeout: 10_000, env: { PATH: directory + delimiter + process.env.PATH },
      });
      expect(JSON.parse(output)).toMatchObject({ worker, instanceId, instanceAbsent: true, httpStatus: 404, providerCode: 10400 });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 12_000);
});
