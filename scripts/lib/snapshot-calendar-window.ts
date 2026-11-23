import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { QUALIFICATION_STAGE_ID } from '../../services/snapshot/qualification';
import { FRESH_SNAPSHOT_STAGE_ID, SNAPSHOT_CALENDAR_REQUEST_MS, snapshotCalendar, snapshotEventCron, snapshotStageTarget,
  type SnapshotStageTarget } from './snapshot-calendar';

const roles = ['primary', 'backup'] as const;
export type SnapshotGuardRole = typeof roles[number];
const propagationMs = 15 * 60_000;
const clearMs = 3 * SNAPSHOT_CALENDAR_REQUEST_MS;
const guardScript = fileURLToPath(new URL('../snapshot-calendar-guard.ts', import.meta.url));

export interface SnapshotCalendarWindow {
  scheduledAt: string;
  clearAt: string;
  cleanupDeadline: string;
}

interface CalendarCredential {
  token: string;
  validUntil: string;
}

type Calendar = ReturnType<typeof snapshotCalendar>;

function utc(value: string) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw new Error('SNAPSHOT_WINDOW_TIME');
  return ms;
}

function timeline(window: SnapshotCalendarWindow, now: number) {
  snapshotEventCron(window.scheduledAt);
  const scheduled = utc(window.scheduledAt), clear = utc(window.clearAt), deadline = utc(window.cleanupDeadline);
  if (now >= scheduled || clear < scheduled || deadline < clear + clearMs || deadline - now >= 2 ** 31 - 1) {
    throw new Error('SNAPSHOT_WINDOW_ORDER');
  }
  return { scheduled, clear, deadline };
}

async function requirePrivateDirectory(path: string) {
  if (!isAbsolute(path) || path !== resolve(path) || await realpath(path) !== path) throw new Error('SNAPSHOT_WINDOW_DIRECTORY');
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error('SNAPSHOT_WINDOW_DIRECTORY');
  }
}

async function writeReceipt(directory: string, name: string, record: object) {
  const file = await open(join(directory, name), 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(record) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
}

function guardRecord(role: SnapshotGuardRole, pid: number, window: SnapshotCalendarWindow, target: SnapshotStageTarget) {
  return { role, pid, worker: target, scheduledAt: window.scheduledAt, clearAt: window.clearAt, cleanupDeadline: window.cleanupDeadline };
}

interface GuardInput {
  role: SnapshotGuardRole;
  credential: CalendarCredential;
  window: SnapshotCalendarWindow;
  journal: string;
  target: SnapshotStageTarget;
}

export async function runSnapshotCleanupGuard({ role, credential, window, journal, target }: GuardInput, calendar = snapshotCalendar(credential.token, undefined, target)) {
  const { clear, deadline, scheduled } = timeline(window, Date.now());
  if (utc(credential.validUntil) <= deadline) throw new Error('SNAPSHOT_WINDOW_CREDENTIAL_EXPIRY');
  await requirePrivateDirectory(journal);
  if (target === FRESH_SNAPSHOT_STAGE_ID) await calendar.verifyCleanupAccess(window.cleanupDeadline);
  else await calendar.verifyEmpty();
  if (Date.now() >= scheduled) throw new Error('SNAPSHOT_WINDOW_GUARD_LATE');
  const record = guardRecord(role, process.pid, window, target);
  await writeReceipt(journal, `${role}-ready.json`, record);
  // A wall clock adjustment must not start cleanup before the reviewed instant.
  while (Date.now() < clear) await sleep(clear - Date.now());
  if (Date.now() > deadline - clearMs) throw new Error('SNAPSHOT_WINDOW_GUARD_LATE');
  const receipt = await calendar.clear(window.scheduledAt);
  await writeReceipt(journal, `${role}-cleared.json`, { ...record, receipt });
}

interface GuardProcess {
  pid: number | undefined;
  running(): boolean;
  stop(): void;
  exited: Promise<boolean>;
}

function startGuard({ role, credential, window, journal, target }: GuardInput): GuardProcess {
  // No inherited IPC or output pipe ties either watchdog to the parent process.
  const child = spawn(process.execPath, ['--no-env-file', guardScript, role, window.scheduledAt, window.clearAt,
    window.cleanupDeadline, credential.validUntil, journal, target], {
    detached: true, stdio: 'ignore', env: { CLOUDFLARE_API_TOKEN: credential.token },
  });
  let exited = false;
  const settled = new Promise<boolean>(resolve => {
    child.once('error', () => { exited = true; resolve(false); });
    child.once('exit', code => { exited = true; resolve(code === 0); });
  });
  child.unref();
  return { pid: child.pid, running: () => !!child.pid && !exited && child.exitCode === null && child.signalCode === null,
    stop: () => { child.kill(); }, exited: settled };
}

async function readGuardRecord(journal: string, role: SnapshotGuardRole, state: 'ready' | 'cleared', pid: number,
  window: SnapshotCalendarWindow, target: SnapshotStageTarget) {
  try {
    const value = JSON.parse(await readFile(join(journal, `${role}-${state}.json`), 'utf8'));
    if (!Object.entries(guardRecord(role, pid, window, target)).every(([key, expected]) => value?.[key] === expected)) return undefined;
    if (state === 'ready') return { ready: true as const, receipt: null };
    const receipt = value?.receipt;
    if (receipt?.empty === true && receipt.worker === target && receipt.scheduledAt === window.scheduledAt &&
      typeof receipt.observedAt === 'string' && typeof receipt.putAcknowledged === 'boolean' && typeof receipt.initiallyEmpty === 'boolean') {
      return { receipt: { worker: target, empty: true as const, scheduledAt: window.scheduledAt, observedAt: receipt.observedAt,
        putAcknowledged: receipt.putAcknowledged, initiallyEmpty: receipt.initiallyEmpty } };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return undefined;
}

async function waitForExit(guards: GuardProcess[], deadline: number, now: () => number) {
  const timer = new AbortController();
  try {
    return await Promise.race([Promise.all(guards.map(guard => guard.exited)),
      sleep(Math.max(0, deadline - now()), null, { signal: timer.signal })]);
  } finally {
    timer.abort();
  }
}

export interface SnapshotCalendarRunOptions {
  window: SnapshotCalendarWindow;
  target?: SnapshotStageTarget;
  operator: CalendarCredential;
  guards: Record<SnapshotGuardRole, CalendarCredential>;
  journal: string;
  /** The caller must verify the installed Worker, live or absent native Workflow schedule,
   * qualification identities, canonical backup, budgets and concrete review before it returns. */
  admit(window: SnapshotCalendarWindow): Promise<void>;
}

/** Calendar phase of the staging operator. The qualification operator supplies live admission. */
export async function runSnapshotCalendarWindow(options: SnapshotCalendarRunOptions, dependencies = {
  calendar: snapshotCalendar, startGuard, now: Date.now, wait: sleep,
}) {
  const { operator, guards, journal } = options;
  const target = snapshotStageTarget.parse(options.target ?? QUALIFICATION_STAGE_ID);
  const guardStartMs = target === FRESH_SNAPSHOT_STAGE_ID ? 4 * SNAPSHOT_CALENDAR_REQUEST_MS + 5_000 : 15_000;
  const { scheduledAt, clearAt, cleanupDeadline } = options.window;
  const window = Object.freeze({ scheduledAt, clearAt, cleanupDeadline });
  const { scheduled, deadline } = timeline(window, dependencies.now());
  const armBy = scheduled - propagationMs;
  if ([operator, ...roles.map(role => guards[role])].some(value => utc(value.validUntil) <= deadline + SNAPSHOT_CALENDAR_REQUEST_MS)) {
    throw new Error('SNAPSHOT_WINDOW_CREDENTIAL_EXPIRY');
  }
  if (!isAbsolute(journal) || journal !== resolve(journal)) throw new Error('SNAPSHOT_WINDOW_DIRECTORY');
  await requirePrivateDirectory(dirname(journal));
  await mkdir(journal, { mode: 0o700 });
  await requirePrivateDirectory(journal);
  await options.admit(window);
  if (dependencies.now() + guardStartMs + clearMs >= armBy) throw new Error('SNAPSHOT_WINDOW_ARM_LATE');
  const calendar = dependencies.calendar(operator.token, undefined, target);
  const children: GuardProcess[] = [];
  let attempted = false;
  let armReceipt: Awaited<ReturnType<Calendar['arm']>> | undefined;
  let armingFailure: string | undefined;

  try {
    for (const role of roles) children.push(dependencies.startGuard({ role, credential: guards[role], window, journal, target }));
    if (children[0]!.pid === children[1]!.pid) throw new Error('SNAPSHOT_WINDOW_GUARDS_NOT_READY');
    const readyBy = dependencies.now() + guardStartMs;
    for (;;) {
      if (dependencies.now() >= readyBy || children.some(child => !child.running())) throw new Error('SNAPSHOT_WINDOW_GUARDS_NOT_READY');
      const ready = await Promise.all(roles.map((role, i) => readGuardRecord(journal, role, 'ready', children[i]!.pid!, window, target)));
      if (ready.every(Boolean)) break;
      await dependencies.wait(100);
    }

    await writeReceipt(journal, 'arm-intent.json', { worker: target, ...window });
    armReceipt = await calendar.arm(window.scheduledAt, () => {
      if (children.some(child => !child.running())) throw new Error('SNAPSHOT_WINDOW_GUARDS_NOT_READY');
      if (dependencies.now() + 2 * SNAPSHOT_CALENDAR_REQUEST_MS >= armBy) throw new Error('SNAPSHOT_WINDOW_ARM_LATE');
      attempted = true;
    });
    if (dependencies.now() >= armBy) armingFailure = 'SNAPSHOT_WINDOW_ARM_LATE';
  } catch (error) {
    if (!attempted) {
      for (const child of children) if (child.running()) child.stop();
      await waitForExit(children, dependencies.now() + guardStartMs, dependencies.now);
      throw error;
    }
    armingFailure = 'SNAPSHOT_WINDOW_ARM_UNCONFIRMED';
  }

  const exits = await waitForExit(children, deadline, dependencies.now);
  const calendarEmpty = exits !== null && await calendar.verifyEmpty().catch(() => null);
  const finished = exits === null ? [] : await Promise.all(roles.map((role, i) => exits[i]
    ? readGuardRecord(journal, role, 'cleared', children[i]!.pid!, window, target) : undefined));
  const result = { worker: target, window, armReceipt, armingFailure, cleanup: { primary: finished[0]?.receipt ?? null,
    backup: finished[1]?.receipt ?? null, final: calendarEmpty || null },
    passed: !!armReceipt && !armingFailure && finished.length === roles.length && finished.every(Boolean) && !!calendarEmpty };
  await writeReceipt(journal, 'calendar-result.json', result);
  return result;
}
