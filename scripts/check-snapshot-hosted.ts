#!/usr/bin/env bun
import { FRESH_SNAPSHOT_STAGE_ID } from './lib/snapshot-calendar';
import { observeSnapshotHostedDeployment, requireSnapshotHostedDeployment, snapshotDeploymentPin } from './lib/snapshot-hosted-admission';

async function main(args: string[]) {
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
