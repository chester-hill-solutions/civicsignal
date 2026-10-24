import type { CorpusRevision } from '../../src/ingest/source';

export interface SnapshotControlEnv {
  SNAPSHOT_PINNED_COMMIT?: string;
  SNAPSHOT_PINNED_DATE?: string;
}
const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date + 'T00:00:00Z')) && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;

/** A staging cron/manual trigger cannot publish an unapproved source revision. */
export function assertSnapshotRevision(env: SnapshotControlEnv, revision: CorpusRevision): void {
  if (!revision || !/^[a-f0-9]{40}$/.test(revision.commit) || !validDate(revision.date)) {
    throw new Error('Snapshot requires a complete commit and valid source date.');
  }
  const commit = env.SNAPSHOT_PINNED_COMMIT;
  const date = env.SNAPSHOT_PINNED_DATE;
  if (commit === undefined && date === undefined) return;
  if (!commit || !/^[a-f0-9]{40}$/.test(commit) || !date || !validDate(date)) {
    throw new Error('Snapshot staging commit and date controls must be configured together.');
  }
  if (commit !== revision.commit || date !== revision.date) throw new Error('Snapshot revision differs from its configured staging pin.');
}

export function assertSourceRevision(expected: CorpusRevision, actual: CorpusRevision): void {
  if (actual.commit !== expected.commit || actual.date !== expected.date) throw new Error('Snapshot commit/date differs from authoritative source metadata.');
}
