import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import creation from '../docs/evidence/2026-11-22/november-workflow-creation.json';
import { verifyStagedSnapshotMain } from '../scripts/verify-staged-snapshot';
import { QUALIFICATION_STAGE_ID, qualificationIdentity } from '../services/snapshot/qualification';

const dirs: string[] = [];
const account = 'https://api.cloudflare.com/client/v4/accounts/ad5ec479b9a421faa2ed06c3d1c2b23a/r2/buckets/civicsignal-v1-stage-corpus-20261022/objects/';
const commit = '855cdfc65207a6906c414e09a77d7f93267c5356';
const scheduledAt = '2030-11-23T03:47:00.000Z';
const runtimeDeadline = '2030-11-23T05:47:00.000Z';
const credential = { CLOUDFLARE_API_TOKEN: 'fixture-read-token' };
const canonicalFile = 'docs/evidence/2026-10-31/reference-snapshot-manifest.json';
afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { force: true, recursive: true });
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'snapshot-verifier-cli-'));
  dirs.push(dir);
  const qualification = await qualificationIdentity({ SNAPSHOT_STAGE_ID: QUALIFICATION_STAGE_ID,
    SNAPSHOT_PINNED_COMMIT: commit, SNAPSHOT_PINNED_DATE: '2026-11-16', SNAPSHOT_QUALIFICATION_ID: 'nov16-20301123-0347',
    SNAPSHOT_QUALIFICATION_CRON: '47 3 23 11 *', SNAPSHOT_QUALIFICATION_TIME: String(Date.parse(scheduledAt)),
    SNAPSHOT_QUALIFICATION_DEADLINE: String(Date.parse(runtimeDeadline)) });
  const packet = { target: creation.worker, bundle: { bytes: creation.bootstrap.bundleBytes, sha256: creation.bootstrap.bundleSha256 },
    publication: { bucket: 'civicsignal-v1-stage-corpus-20261022', window: { scheduledAt }, runtimeDeadline, qualification,
      referenceManifestSha256: '43fdb9961b0980769552df1993e106beba8f3a354ecf9bd3fbd11091ea25ba34' } };
  const path = join(dir, 'prepared-stage.json');
  return { packet, args: ['--staging', '--packet', path], async save() { await writeFile(path, JSON.stringify(packet)); } };
}

describe('November hosted snapshot verifier CLI', () => {
  it('reads the canonical manifest and the exact qualification key using literal slashes and GET only', async () => {
    const f = await fixture();
    await f.save();
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(await readFile(canonicalFile, 'utf8')))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(verifyStagedSnapshotMain(f.args, credential, send)).rejects.toThrow();
    const expected = [`${account}snapshots/statutes-v2/0507465393c224c0491fc8c17c88340217acc656.manifest.json`,
      `${account}${f.packet.publication.qualification.prefix}snapshots/statutes-v2/${commit}.manifest.json`];
    expect(send.mock.calls.map(([url]) => url)).toEqual(expected);
    for (const [, init] of send.mock.calls) expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit',
      headers: { Authorization: 'Bearer fixture-read-token' } });
  });

  it('rejects a substituted qualification namespace before sending a request', async () => {
    const f = await fixture();
    f.packet.publication.qualification.prefix = 'snapshots/statutes-v2/';
    await f.save();
    const send = vi.fn<typeof fetch>();
    await expect(verifyStagedSnapshotMain(f.args, credential, send)).rejects.toThrow('qualification identity differs');
    expect(send).not.toHaveBeenCalled();
  });

  it('requires an explicit read credential for staging', async () => {
    const f = await fixture();
    await f.save();
    const send = vi.fn<typeof fetch>();
    await expect(verifyStagedSnapshotMain(f.args, {}, send)).rejects.toThrow('staging R2 read token');
    expect(send).not.toHaveBeenCalled();
  });
});
