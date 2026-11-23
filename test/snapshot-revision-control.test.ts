import { describe, expect, it } from 'vitest';
import { assertSnapshotRevision, assertSourceRevision } from '../services/snapshot/revision-control';

const revision = { commit: 'a'.repeat(40), date: '2026-10-15' };
const env = { SNAPSHOT_PINNED_COMMIT: revision.commit, SNAPSHOT_PINNED_DATE: revision.date };
describe('snapshot staging revision control', () => {
  it('allows the exact approved revision and preserves unrestricted production discovery', () => {
    expect(() => assertSnapshotRevision(env, revision)).not.toThrow();
    expect(() => assertSnapshotRevision({}, revision)).not.toThrow();
  });
  it.each([{ ...revision, commit: 'b'.repeat(40) }, { ...revision, date: '2026-10-16' }])('refuses changed scheduled or manual revision %o', (other) => {
    expect(() => assertSnapshotRevision(env, other)).toThrow(/pin/);
  });
  it.each([{ SNAPSHOT_PINNED_COMMIT: revision.commit }, { SNAPSHOT_PINNED_DATE: revision.date },
    { ...env, SNAPSHOT_PINNED_DATE: '2026-02-30' }])('refuses partial or invalid controls %o', (control) => {
    expect(() => assertSnapshotRevision(control, revision)).toThrow(/together/);
  });
  it('refuses a caller-supplied date that does not match the immutable source commit', () => {
    expect(() => assertSourceRevision(revision, { ...revision, date: '2026-10-16' })).toThrow(/authoritative/);
    expect(() => assertSourceRevision(revision, revision)).not.toThrow();
  });
});
