#!/usr/bin/env bun
import { runSnapshotCleanupGuard } from './lib/snapshot-calendar-window';
import { snapshotStageTarget } from './lib/snapshot-calendar';
import { QUALIFICATION_STAGE_ID } from '../services/snapshot/qualification';

const [role, scheduledAt, clearAt, cleanupDeadline, validUntil, journal, worker = QUALIFICATION_STAGE_ID, ...extra] = process.argv.slice(2);
const target = snapshotStageTarget.safeParse(worker);
if ((role !== 'primary' && role !== 'backup') || !scheduledAt || !clearAt || !cleanupDeadline || !validUntil || !journal || !target.success || extra.length) {
  console.error('SNAPSHOT_WINDOW_GUARD_ARGUMENTS');
  process.exitCode = 1;
} else {
  runSnapshotCleanupGuard({ role, credential: { token: process.env.CLOUDFLARE_API_TOKEN ?? '', validUntil },
    window: { scheduledAt, clearAt, cleanupDeadline }, journal, target: target.data }).catch(() => {
    console.error('SNAPSHOT_WINDOW_GUARD_FAILED');
    process.exitCode = 1;
  });
}
