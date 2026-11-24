#!/usr/bin/env bun
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRESH_SNAPSHOT_STAGE_ID, SnapshotCalendarError, snapshotCalendar } from './lib/snapshot-calendar';
import { snapshotScheduleTokens } from './lib/snapshot-schedule-credentials';

const usage = [
  'Usage: bun scripts/snapshot-calendar.ts [--fresh] verify-empty | [--fresh] clear --scheduled-at <UTC-ISO-minute>',
  '       bun --no-env-file scripts/snapshot-calendar.ts --fresh <verify-cleanup|preflight-credentials> --cleanup-deadline <UTC-ISO-instant>',
  'preflight-credentials requires exclusive control of the dedicated fresh staging calendar and uses 12 requests, including three empty PUTs.',
  'Supply CLOUDFLARE_API_TOKEN for the operator. CIVICSIGNAL_SNAPSHOT_PRIMARY_GUARD_TOKEN and CIVICSIGNAL_SNAPSHOT_BACKUP_GUARD_TOKEN default to it when unset.',
].join('\n');

const roles = ['operator', 'primary', 'backup'] as const;
type CredentialRole = typeof roles[number];

class SnapshotCalendarPreflightError extends SnapshotCalendarError {
  constructor(readonly role: CredentialRole, error: SnapshotCalendarError) {
    super(error.code, error.status);
  }
}

async function preflightCredentials(cleanupDeadline: string, env: NodeJS.ProcessEnv, send: typeof fetch) {
  const credentials = snapshotScheduleTokens(env);
  const credentialContexts = [];
  for (const role of roles) {
    try {
      const calendar = snapshotCalendar(credentials[role], send, FRESH_SNAPSHOT_STAGE_ID);
      credentialContexts.push({ role, ...await calendar.verifyCleanupAccess(cleanupDeadline) });
    } catch (error) {
      if (error instanceof SnapshotCalendarError) throw new SnapshotCalendarPreflightError(role, error);
      throw error;
    }
  }
  return { worker: FRESH_SNAPSHOT_STAGE_ID, cleanupDeadline, credentialContexts };
}

export async function snapshotCalendarMain(argv: string[], env: NodeJS.ProcessEnv = process.env, send: typeof fetch = fetch) {
  const fresh = argv[0] === '--fresh';
  const target = fresh ? FRESH_SNAPSHOT_STAGE_ID : undefined;
  const args = fresh ? argv.slice(1) : argv;
  if (args.length === 1 && args[0] === 'verify-empty') {
    return snapshotCalendar(env.CLOUDFLARE_API_TOKEN ?? '', send, target).verifyEmpty();
  }
  if (args.length === 3 && args[0] === 'clear' && args[1] === '--scheduled-at' && args[2]) {
    return snapshotCalendar(env.CLOUDFLARE_API_TOKEN ?? '', send, target).clear(args[2]);
  }
  if (fresh && args.length === 3 && args[1] === '--cleanup-deadline' && args[2]) {
    if (args[0] === 'verify-cleanup') return snapshotCalendar(env.CLOUDFLARE_API_TOKEN ?? '', send, target).verifyCleanupAccess(args[2]);
    if (args[0] === 'preflight-credentials') return preflightCredentials(args[2], env, send);
  }
  throw new Error(usage);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  snapshotCalendarMain(process.argv.slice(2)).then(receipt => console.log(JSON.stringify(receipt))).catch(error => {
    console.error(error instanceof SnapshotCalendarError
      ? JSON.stringify({ error: error.message, status: error.status,
        role: error instanceof SnapshotCalendarPreflightError ? error.role : undefined })
      : usage);
    process.exitCode = 1;
  });
}
