#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { FRESH_SNAPSHOT_STAGE_ID } from './lib/snapshot-calendar';
import { observeSnapshotHostedDeployment, readSnapshotCfBytes, requireSnapshotHostedDeployment, snapshotDeploymentPin } from './lib/snapshot-hosted-admission';
import { stagingNames } from './lib/staging-config';
import { stagedPublicationPins } from './verify-staged-snapshot';

async function freshBaseline(pin: ReturnType<typeof snapshotDeploymentPin.parse>) {
  const worker = FRESH_SNAPSHOT_STAGE_ID;
  const deployment = await requireSnapshotHostedDeployment(pin, undefined, worker);
  const { canonical } = stagedPublicationPins;
  const bucket = stagingNames('20261022').corpus;
  const [page, bytes] = await Promise.all([
    readSnapshotCfBytes(['workflows', 'instances', 'list', '--workflow-name', worker, '--per-page', '1']),
    readSnapshotCfBytes(['r2', 'objects', 'get', canonical.key, '--bucket-name', bucket]),
  ]);
  const instances: unknown = JSON.parse(page.toString('utf8'));
  if (!Array.isArray(instances) || instances.length > 1) throw new Error('SNAPSHOT_HOSTED_INSTANCE_LIST');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== canonical.bytes || digest !== canonical.sha256) throw new Error('SNAPSHOT_HOSTED_CANONICAL_DRIFT');
  return { scope: 'staging-read-only-baseline', deployment, anyWorkflowInstances: instances.length > 0,
    canonical: { bucket, key: canonical.key, bytes: bytes.length, sha256: digest }, finishedAt: new Date().toISOString() };
}

async function main(args: string[]) {
  if (args[0] === '--fresh' && args[1] === '--baseline' && args.length === 6 &&
    args[2] === '--deployment-id' && args[4] === '--version-id') {
    return freshBaseline(snapshotDeploymentPin.parse({ deploymentId: args[3], versionId: args[5] }));
  }
  const fresh = args[0] === '--fresh';
  const target = fresh ? FRESH_SNAPSHOT_STAGE_ID : undefined;
  const flags = fresh ? args.slice(1) : args;
  if (flags.length === 0) return observeSnapshotHostedDeployment(undefined, target);
  const pin = snapshotDeploymentPin.safeParse({ deploymentId: flags[1], versionId: flags[3] });
  if (flags.length === 4 && flags[0] === '--deployment-id' && flags[2] === '--version-id' && pin.success) {
    return requireSnapshotHostedDeployment(pin.data, undefined, target);
  }
  throw new Error('SNAPSHOT_HOSTED_ARGUMENTS');
}

main(process.argv.slice(2)).then(observed => console.log(JSON.stringify(observed))).catch(error => {
  const code = error instanceof Error && /^SNAPSHOT_HOSTED_[A-Z_]+$/.test(error.message) ? error.message : 'SNAPSHOT_HOSTED_FAILED';
  console.error(JSON.stringify({ error: code }));
  process.exitCode = 1;
});
