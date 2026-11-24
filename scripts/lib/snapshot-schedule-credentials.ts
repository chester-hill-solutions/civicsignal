import { SnapshotCalendarError } from './snapshot-calendar';

/** The detached guards each inherit only their own scheduling credential. */
export function snapshotScheduleTokens(env: NodeJS.ProcessEnv) {
  const operator = env.CLOUDFLARE_API_TOKEN ?? '';
  const primary = env.CIVICSIGNAL_SNAPSHOT_PRIMARY_GUARD_TOKEN ?? operator;
  const backup = env.CIVICSIGNAL_SNAPSHOT_BACKUP_GUARD_TOKEN ?? operator;
  if (![operator, primary, backup].every(token => /^[!-~]+$/.test(token))) throw new SnapshotCalendarError('CREDENTIAL');
  return { operator, primary, backup };
}
