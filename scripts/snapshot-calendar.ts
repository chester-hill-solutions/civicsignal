#!/usr/bin/env bun
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRESH_SNAPSHOT_STAGE_ID, SnapshotCalendarError, snapshotCalendar } from './lib/snapshot-calendar';

const usage = 'Usage: bun scripts/snapshot-calendar.ts [--fresh] verify-empty | [--fresh] clear --scheduled-at <UTC-ISO-minute> | --fresh verify-cleanup --cleanup-deadline <UTC-ISO-instant>';

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
  if (fresh && args.length === 3 && args[0] === 'verify-cleanup' && args[1] === '--cleanup-deadline' && args[2]) {
    return snapshotCalendar(env.CLOUDFLARE_API_TOKEN ?? '', send, target).verifyCleanupAccess(args[2]);
  }
  throw new Error(usage);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  snapshotCalendarMain(process.argv.slice(2)).then(receipt => console.log(JSON.stringify(receipt))).catch(error => {
    console.error(error instanceof SnapshotCalendarError
      ? JSON.stringify({ error: error.message, status: error.status })
      : usage);
    process.exitCode = 1;
  });
}
