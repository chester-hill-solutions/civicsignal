import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { exportVectorsCli } from '../scripts/export-vectors';
import { vectorsManifestKey } from '../src/ingest/snapshot-format';
import type { VectorBackupSend } from '../scripts/lib/vector-export-client';
import { commit, coordinatorId, origin, revision, secret, vectorBackupFixture } from './helpers/vector-backup';
const cleanup: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const f = await vectorBackupFixture(), directory = await mkdtemp(join(tmpdir(), 'vector-backup-cli-')); cleanup.push(directory);
  for (const [key, value] of f.files) { const path = join(directory, key); await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); }
  const journal = join(directory, 'attempt.jsonl'), output = join(directory, vectorsManifestKey(commit, f.plan.parser));
  const args = ['--revision', commit, '--dir', directory, '--url', origin, '--coordinator-id', coordinatorId,
    '--suspension-revision', String(revision), '--journal', journal];
  let calls = 0;
  const send: VectorBackupSend = async (url, init) => {
    calls++; const lines = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({ kind: 'intent', request: calls });
    const body = init.body ? JSON.parse(init.body) : undefined;
    return f.json(url.endsWith('/control') ? f.control : body.action === 'manifest' ? f.manifest : f.receipts[body.part]);
  };
  return { ...f, directory, journal, output, args, send, calls: () => calls };
}
describe('journaled vector export CLI', () => {
  it('keeps dry-run local with no credential read, transport, journal or vector manifest', async () => {
    const f = await fixture();
    const result = await exportVectorsCli([...f.args, '--dry-run'], { getSecret: () => { throw Error('PRIVATE secret read forbidden'); }, send: async () => { throw Error('network forbidden'); } });
    expect(result).toMatchObject({ dryRun: true, writes: false, maxRequests: 4, count: 3, parts: 1, modelProvenance: 'not-attested' });
    expect(await lstat(f.journal).catch(() => null)).toBeNull(); expect(await lstat(f.output).catch(() => null)).toBeNull();
  });
  it('refuses a missing journal parent before credential access or transport', async () => {
    const f = await fixture(), parent = join(f.directory, 'absent', 'nested');
    let secretReads = 0;
    await expect(exportVectorsCli([...f.args.slice(0, -1), join(parent, 'attempt.jsonl')], {
      getSecret: () => { secretReads++; return secret; }, send: f.send,
    })).rejects.toMatchObject({ code: 'JOURNAL_PARENT_REQUIRED' });
    expect(secretReads).toBe(0); expect(f.calls()).toBe(0);
    expect(await lstat(join(f.directory, 'absent')).catch(() => null)).toBeNull();
    expect(await lstat(f.output).catch(() => null)).toBeNull();
  });
  it.each(['symlink', 'file', 'group-access', 'world-access', 'other-owner'])('refuses a %s journal parent before credential access or transport', async kind => {
    const f = await fixture(), parent = join(f.directory, 'unsafe-parent');
    if (kind === 'symlink') await symlink(f.directory, parent, 'dir');
    else if (kind === 'file') await writeFile(parent, 'preserve-parent');
    else {
      await mkdir(parent, { mode: 0o700 });
      if (kind === 'group-access') await chmod(parent, 0o750);
      if (kind === 'world-access') await chmod(parent, 0o701);
      if (kind === 'other-owner') vi.spyOn(process as { getuid(): number }, 'getuid').mockReturnValue(-1);
    }
    let secretReads = 0;
    await expect(exportVectorsCli([...f.args.slice(0, -1), join(parent, 'attempt.jsonl')], {
      getSecret: () => { secretReads++; return secret; }, send: f.send,
    })).rejects.toMatchObject({ code: 'JOURNAL_PARENT_NOT_PRIVATE' });
    expect(secretReads).toBe(0); expect(f.calls()).toBe(0);
    expect(await lstat(join(parent, 'attempt.jsonl')).catch(() => null)).toBeNull();
    expect(await lstat(f.output).catch(() => null)).toBeNull();
  });
  it('journals each intent before transport and writes only the normalized manifest after final control', async () => {
    const f = await fixture();
    const result = await exportVectorsCli(f.args, { getSecret: () => secret, send: f.send });
    expect(result).toMatchObject({ dryRun: false, writes: true, requests: 4 }); expect(f.calls()).toBe(4);
    expect(JSON.parse(await readFile(f.output, 'utf8'))).toEqual(f.manifest);
    const journal = await readFile(f.journal, 'utf8');
    expect(journal).not.toContain(secret); expect(journal).not.toContain('x-pipeline-secret');
    expect(JSON.parse(journal.trim().split('\n').at(-1)!)).toMatchObject({ kind: 'complete', requests: 4, modelProvenance: 'not-attested' });
    expect((await lstat(f.journal)).mode & 0o777).toBe(0o600);
    expect((await lstat(f.output)).mode & 0o777).toBe(0o600);
  });
  it('retains the lost-ack intent and refuses replay of that exclusive journal before secret access or transport', async () => {
    const f = await fixture(); let calls = 0;
    await expect(exportVectorsCli(f.args, { getSecret: () => secret, send: async () => {
      if (++calls === 1) return f.json(f.control); throw Error('PRIVATE accepted request, acknowledgement lost');
    } })).rejects.toMatchObject({ code: 'EXPORT_TRANSPORT_FAILED' });
    const saved = await readFile(f.journal, 'utf8');
    expect(saved).not.toContain('PRIVATE'); expect(saved).toContain('"step":"part"');
    expect(JSON.parse(saved.trim().split('\n').at(-1)!)).toEqual({ kind: 'failed', code: 'EXPORT_TRANSPORT_FAILED' });
    expect(await lstat(f.output).catch(() => null)).toBeNull();
    await expect(exportVectorsCli(f.args, { getSecret: () => { throw Error('must not read'); }, send: async () => { calls++; throw Error('must not send'); } }))
      .rejects.toMatchObject({ code: 'JOURNAL_ALREADY_EXISTS' });
    expect(calls).toBe(2); expect(await readFile(f.journal, 'utf8')).toBe(saved);
  });
  it('refuses an existing local manifest without reading the secret or opening a journal', async () => {
    const f = await fixture(); await writeFile(f.output, 'preserve-original');
    await expect(exportVectorsCli(f.args, { getSecret: () => { throw Error('must not read'); }, send: f.send })).rejects.toMatchObject({ code: 'LOCAL_MANIFEST_EXISTS' });
    expect(await readFile(f.output, 'utf8')).toBe('preserve-original'); expect(f.calls()).toBe(0); expect(await lstat(f.journal).catch(() => null)).toBeNull();
  });
  it('does not overwrite a manifest created during the export, preserving the failed journal', async () => {
    const f = await fixture(); let calls = 0;
    await expect(exportVectorsCli(f.args, { getSecret: () => secret, send: async (url, init) => {
      if (++calls === 4) await writeFile(f.output, 'preserve-concurrent-original');
      return f.send(url, init);
    } })).rejects.toMatchObject({ code: 'LOCAL_MANIFEST_EXISTS' });
    expect(await readFile(f.output, 'utf8')).toBe('preserve-concurrent-original');
    expect(await readFile(f.journal, 'utf8')).toContain('"code":"LOCAL_MANIFEST_EXISTS"'); expect(calls).toBe(4);
  });
  it('does not save a local manifest when the final suspension drifts', async () => {
    const f = await fixture(); let calls = 0;
    await expect(exportVectorsCli(f.args, { getSecret: () => secret, send: async (url, init) => ++calls === 4 ?
      f.json({ ...f.control, coordinatorId: 'd'.repeat(64) }) : f.send(url, init) })).rejects.toMatchObject({ code: 'SUSPENSION_NOT_COMPLETE_OR_CHANGED' });
    expect(await lstat(f.output).catch(() => null)).toBeNull(); expect(await readFile(f.journal, 'utf8')).toContain('"step":"control-final"'); expect(calls).toBe(4);
  });
  it.each([
    ['--url', origin], ['--suspension-revision', '0'], ['--coordinator-id', 'other'], ['--secret', 'PRIVATE'], ['--dry-run', '--dry-run'],
  ])('refuses duplicated/invalid/unknown arguments %s before secret or transport', async (flag, value) => {
    const f = await fixture();
    await expect(exportVectorsCli([...f.args, flag, value], { getSecret: () => { throw Error('PRIVATE forbidden'); }, send: f.send })).rejects.toMatchObject({ code: expect.any(String) });
    expect(f.calls()).toBe(0); expect(await lstat(f.journal).catch(() => null)).toBeNull();
  });
  it('requires explicit live URL, coordinator, revision and journal instead of using environment target defaults', async () => {
    const f = await fixture();
    await expect(exportVectorsCli(['--revision', commit, '--dir', f.directory], { getSecret: () => { throw Error('PRIVATE forbidden'); }, send: f.send }))
      .rejects.toMatchObject({ code: 'EXPLICIT_LIVE_ARGUMENTS_REQUIRED' }); expect(f.calls()).toBe(0);
  });
  it('runs the actual Bun dry-run CLI from a fixture-only directory without an environment secret in output', async () => {
    const f = await fixture();
    const out = execFileSync('bun', [resolve('scripts/export-vectors.ts'), '--revision', commit, '--dir', f.directory, '--dry-run'],
      { cwd: f.directory, env: { ...process.env, PIPELINE_SECRET: secret }, encoding: 'utf8' });
    expect(JSON.parse(out)).toMatchObject({ dryRun: true, writes: false, maxRequests: 4 }); expect(out).not.toContain(secret);
    expect(await lstat(f.journal).catch(() => null)).toBeNull(); expect(await lstat(f.output).catch(() => null)).toBeNull();
  });
});
