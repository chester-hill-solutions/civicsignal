import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRESH_SNAPSHOT_STAGE_ID, snapshotCalendar, type SnapshotStageTarget } from '../scripts/lib/snapshot-calendar';
import { runSnapshotCalendarWindow } from '../scripts/lib/snapshot-calendar-window';

const scheduledAt = '2030-11-23T03:47:00.000Z';
const clearAt = '2030-11-23T03:52:00.000Z';
const cleanupDeadline = '2030-11-23T03:55:00.000Z';
const validUntil = '2030-11-23T04:00:00.000Z';
const window = { scheduledAt, clearAt, cleanupDeadline };
const cron = '47 3 23 11 *';
const settings = (crons: string[]) => Response.json({ success: true, result: { schedules: crons.map(cron => ({ cron })) } });
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { force: true, recursive: true });
});

async function privateDirectory() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'snapshot-calendar-window-')));
  directories.push(directory);
  return directory;
}

async function fixture(target?: SnapshotStageTarget) {
  const journal = join(await privateDirectory(), 'journal');
  const options = { window, journal, target, operator: { token: 'operator', validUntil },
    guards: { primary: { token: 'primary', validUntil }, backup: { token: 'backup', validUntil } },
    admit: vi.fn().mockResolvedValue(undefined) };
  const state = { now: Date.parse(scheduledAt) - 30 * 60_000, crons: [] as string[],
    loseArmResponse: false, loseBackup: false, loseBackupWriteResponse: false, exitBackupOnArmRead: false };
  const calls: string[] = [];
  const children: Array<{ finish(): Promise<void>; kill(): void }> = [];
  const send = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const token = new Headers(init?.headers).get('Authorization')?.slice('Bearer '.length);
    const arm = init?.method === 'PUT' && init.body !== '[]';
    calls.push(`${token}:${init?.method}${arm ? ' singleton' : ''}`);
    if (arm) {
      state.crons = [cron];
      setTimeout(() => { void Promise.all(children.map(child => child.finish())); }, 0);
      if (state.loseArmResponse) throw new Error('fixture lost arm acknowledgement');
    } else if (init?.method === 'PUT') {
      state.crons = [];
      if (token === 'backup' && state.loseBackupWriteResponse) throw new Error('fixture lost backup cleanup acknowledgement');
    } else if (token === 'operator' && state.exitBackupOnArmRead && calls.at(-1) === 'operator:GET') {
      children[1]?.kill();
    }
    return settings(state.crons);
  });
  const startGuard: NonNullable<Parameters<typeof runSnapshotCalendarWindow>[1]>['startGuard'] = vi.fn(({ role, credential, target }) => {
    const pid = 100 + children.length;
    const record = { role, pid, worker: target, ...window };
    const calendar = snapshotCalendar(credential.token, send, target);
    const ready = calendar.verifyEmpty().then(() => writeFile(join(journal, `${role}-ready.json`), JSON.stringify(record)));
    let settle!: (result: boolean) => void;
    const exited = new Promise<boolean>(resolve => { settle = resolve; });
    let running = true;
    const kill = () => { running = false; settle(false); };
    children.push({ kill, async finish() {
      await ready;
      if (role === 'backup' && state.loseBackup) return kill();
      const receipt = await calendar.clear(window.scheduledAt);
      await writeFile(join(journal, `${role}-cleared.json`), JSON.stringify({ ...record, receipt }));
      running = false;
      settle(true);
    } });
    return { pid, running: () => running, stop: kill, exited };
  });
  const run = () => runSnapshotCalendarWindow(options, { calendar: (token, _send, target) => snapshotCalendar(token, send, target), startGuard, now: () => state.now,
    wait: () => new Promise(resolve => setTimeout(resolve, 5)) });
  return { options, state, calls, send, startGuard, run };
}

describe('staging calendar window', () => {
  it('arms after both guards read empty and verifies again after both guards clear', async () => {
    const f = await fixture();
    const receipt = await f.run();
    expect(f.options.admit).toHaveBeenCalledWith(window);
    expect(f.calls.slice(0, 5)).toEqual(['primary:GET', 'backup:GET', 'operator:GET', 'operator:PUT singleton', 'operator:GET']);
    expect(f.calls.slice(5, -1).filter(call => call.startsWith('primary'))).toEqual(['primary:GET', 'primary:PUT', 'primary:GET']);
    expect(f.calls.slice(5, -1).filter(call => call.startsWith('backup'))).toEqual(['backup:GET', 'backup:PUT', 'backup:GET']);
    expect(f.calls.at(-1)).toBe('operator:GET');
    expect(f.send.mock.calls[3]?.[1]?.body).toBe(JSON.stringify([{ cron }]));
    expect(receipt).toMatchObject({ passed: true, armReceipt: { cron },
      cleanup: { primary: { empty: true }, backup: { empty: true }, final: { empty: true } } });
    expect(JSON.parse(await readFile(join(f.options.journal, 'calendar-result.json'), 'utf8'))).toMatchObject({ passed: true });
    await expect(f.run()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(f.calls).toHaveLength(12);
  });

  it('lets both guards finish after an uncertain arm without sending a second arm attempt', async () => {
    const f = await fixture();
    f.state.loseArmResponse = true;
    await expect(f.run()).resolves.toMatchObject({ passed: false, armingFailure: 'SNAPSHOT_WINDOW_ARM_UNCONFIRMED',
      cleanup: { primary: { empty: true }, backup: { empty: true }, final: { empty: true } } });
    expect(f.calls.filter(call => call.includes('singleton'))).toHaveLength(1);
  });

  it('uses the same fresh Worker for arming, both guards, and final verification', async () => {
    const f = await fixture(FRESH_SNAPSHOT_STAGE_ID);
    const result = await f.run();
    expect(result).toMatchObject({ worker: FRESH_SNAPSHOT_STAGE_ID, passed: true, cleanup: {
      primary: { worker: FRESH_SNAPSHOT_STAGE_ID }, backup: { worker: FRESH_SNAPSHOT_STAGE_ID }, final: { worker: FRESH_SNAPSHOT_STAGE_ID },
    } });
    expect(f.send.mock.calls.every(([url]) => String(url).endsWith(`/${FRESH_SNAPSHOT_STAGE_ID}/schedules`))).toBe(true);
  });

  it('reports a failed guard even when the other guard and final observer confirm an empty calendar', async () => {
    const f = await fixture();
    f.state.loseBackup = true;
    await expect(f.run()).resolves.toMatchObject({ passed: false,
      cleanup: { primary: { empty: true }, backup: null, final: { empty: true } } });
  });

  it('retains the empty readback but fails qualification when a guard lacks a cleanup acknowledgement', async () => {
    const f = await fixture(FRESH_SNAPSHOT_STAGE_ID);
    f.state.loseBackupWriteResponse = true;
    await expect(f.run()).resolves.toMatchObject({ passed: false,
      cleanup: { primary: { putAcknowledged: true }, backup: { empty: true, putAcknowledged: false }, final: { empty: true } } });
    expect(f.calls.filter(call => call === 'backup:PUT')).toHaveLength(1);
  });

  it('refuses arming if a guard exits during the final pre-write read', async () => {
    const f = await fixture();
    f.state.exitBackupOnArmRead = true;
    await expect(f.run()).rejects.toThrow('SNAPSHOT_WINDOW_GUARDS_NOT_READY');
    expect(f.calls).toEqual(['primary:GET', 'backup:GET', 'operator:GET']);
  });

  it('refuses to start when live admission fails, the propagation window is too short, or a guard credential expires', async () => {
    const unadmitted = await fixture();
    unadmitted.options.admit.mockRejectedValueOnce(new Error('native calendar unknown'));
    await expect(unadmitted.run()).rejects.toThrow('native calendar unknown');
    const late = await fixture();
    late.state.now = Date.parse(scheduledAt) - 14 * 60_000;
    await expect(late.run()).rejects.toThrow('SNAPSHOT_WINDOW_ARM_LATE');
    const expired = await fixture();
    expired.options.guards.backup.validUntil = clearAt;
    await expect(expired.run()).rejects.toThrow('SNAPSHOT_WINDOW_CREDENTIAL_EXPIRY');
    for (const f of [unadmitted, late, expired]) {
      expect(f.startGuard).not.toHaveBeenCalled();
      expect(f.calls).toHaveLength(0);
    }
  });
});

const bun = (() => {
  try { return execFileSync('bun', ['-e', 'console.log(process.execPath)'], { encoding: 'utf8' }).trim(); }
  catch { return undefined; }
})();

it.skipIf(!bun)('runs both cleanup guard entry points in separate Bun processes', async () => {
  const journal = await privateDirectory();
  const preload = join(journal, 'offline-fetch.mjs');
  const guardClearAt = '2030-11-23T03:47:00.050Z';
  await writeFile(preload, `
import { existsSync } from 'node:fs';
import { join } from 'node:path';
// Advance the fixture clock when this guard has finished admission.
// Starting Bun under load can take longer than the simulated one-second window.
const ready = join(${JSON.stringify(journal)}, process.argv[2] + '-ready.json');
Date.now = () => existsSync(ready) ? Date.parse('${guardClearAt}') : Date.parse('${scheduledAt}') - 1000;
let count = 0;
globalThis.fetch = async (url, init) => {
  if (url.endsWith('/tokens/verify') && count++ === 0 && init.method === 'GET') {
    return Response.json({success: true, result: {status: 'active', expires_on: '${validUntil}'}});
  }
  if (!url.endsWith('/${FRESH_SNAPSHOT_STAGE_ID}/schedules')) throw new Error('fixture target');
  const method = ['GET', 'GET', 'PUT', 'GET', 'GET', 'PUT', 'GET'][count++];
  if (init.method !== method || (method === 'PUT' && init.body !== '[]')) throw new Error('fixture method');
  return Response.json({success: true, result: {schedules: count === 5 ? [{cron: '${cron}'}] : []}});
};
process.on('exit', () => { if (count !== 7) process.exitCode = 5; });
`);
  const guardScript = resolve('scripts/snapshot-calendar-guard.ts');
  const processes = ['primary', 'backup'].map(role => spawn(bun!, ['--no-env-file', '--preload', preload, guardScript,
    role, scheduledAt, guardClearAt, cleanupDeadline, validUntil, journal, FRESH_SNAPSHOT_STAGE_ID], {
    stdio: 'ignore', env: { CLOUDFLARE_API_TOKEN: `fixture-${role}` }, detached: true,
  }));
  await expect(Promise.all(processes.map(child => new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  })))).resolves.toEqual([0, 0]);
  const receipts = await Promise.all(['primary', 'backup'].map(async role => JSON.parse(await readFile(join(journal, `${role}-cleared.json`), 'utf8'))));
  expect(receipts.map(receipt => receipt.pid)).toEqual(processes.map(child => child.pid));
  expect(receipts.map(receipt => receipt.receipt.empty)).toEqual([true, true]);
}, 8_000);
