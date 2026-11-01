#!/usr/bin/env bun
/** Offline preparation. No execution, credential, deployment or schedule mode. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSnapshotQualificationProposal } from './lib/snapshot-qualification-proposal';

export async function snapshotQualificationProposalMain(argv: string[], nowMs = Date.now()) {
  if (argv.length !== 4 || argv[0] !== '--inputs' || argv[2] !== '--out' || !argv[1] || !argv[3]) {
    throw new Error('SNAPSHOT_PROPOSAL_ARGUMENTS');
  }
  return prepareSnapshotQualificationProposal({ root: resolve(import.meta.dirname, '..'), inputFile: argv[1], outputDirectory: argv[3], nowMs });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  snapshotQualificationProposalMain(process.argv.slice(2)).then(() => console.log(JSON.stringify({ preparedOnly: true,
    executionApproved: false, executionReady: false, networkRequests: 0, credentialBytesRead: 0 }))).catch(() => {
    console.error(JSON.stringify({ error: 'snapshot_qualification_proposal_refused', executionApproved: false, executionReady: false }));
    process.exitCode = 1;
  });
}
