import { z } from 'zod';
import { QUALIFICATION_STAGE_ID } from '../../services/snapshot/qualification';
import { STAGING_ACCOUNT } from './staging-config';

export const FRESH_SNAPSHOT_STAGE_ID = 'civicsignal-v1-stage-nov16-snapshot';
export const snapshotStageTarget = z.enum([QUALIFICATION_STAGE_ID, FRESH_SNAPSHOT_STAGE_ID]);
export type SnapshotStageTarget = z.infer<typeof snapshotStageTarget>;
export const SNAPSHOT_CALENDAR_REQUEST_MS = 10_000;
const maxResponseBytes = 16 * 1024;
const scheduleResult = z.object({ success: z.literal(true),
  result: z.object({ schedules: z.array(z.object({ cron: z.string().min(1) })) }) });
const accountTokenResult = z.object({ success: z.literal(true), result: z.object({ status: z.literal('active'),
  expires_on: z.iso.datetime({ offset: true }), not_before: z.iso.datetime({ offset: true }).optional() }) });

type CalendarErrorCode = 'CREDENTIAL' | 'CREDENTIAL_EXPIRY' | 'EVENT' | 'REQUEST' | 'HTTP' | 'RESPONSE' | 'UNEXPECTED' | 'NOT_EMPTY' | 'NOT_ARMED' | 'CLEANUP_ACCESS';

export class SnapshotCalendarError extends Error {
  constructor(readonly code: CalendarErrorCode, readonly status?: number) {
    super(`SNAPSHOT_CALENDAR_${code}`);
  }
}

export function snapshotEventCron(scheduledAt: string): string {
  const date = new Date(scheduledAt);
  if (!Number.isFinite(date.getTime()) || date.getTime() % 60_000 !== 0 || date.toISOString() !== scheduledAt) {
    throw new SnapshotCalendarError('EVENT');
  }
  return `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth() + 1} *`;
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new SnapshotCalendarError('RESPONSE');
  const bytes = new Uint8Array(maxResponseBytes);
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > bytes.byteLength) throw new SnapshotCalendarError('RESPONSE');
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, size)));
  } catch {
    throw new SnapshotCalendarError('RESPONSE');
  }
}

export function snapshotCalendar(token: string, send: (url: string, init: RequestInit) => Promise<Response> = fetch,
  target: SnapshotStageTarget = QUALIFICATION_STAGE_ID) {
  if (!/^[!-~]+$/.test(token)) throw new SnapshotCalendarError('CREDENTIAL');
  const worker = snapshotStageTarget.parse(target);
  const account = `https://api.cloudflare.com/client/v4/accounts/${STAGING_ACCOUNT}`;
  const endpoint = `${account}/workers/scripts/${worker}/schedules`;

  async function requestJson(url: string, schedules?: { cron: string }[]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SNAPSHOT_CALENDAR_REQUEST_MS);
    try {
      const init: RequestInit & { credentials: 'omit' } = {
        method: schedules ? 'PUT' : 'GET', signal: controller.signal, redirect: 'error', credentials: 'omit',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Cache-Control': 'no-cache, no-store',
          ...(schedules ? { 'Content-Type': 'application/json' } : {}) },
        ...(schedules ? { body: JSON.stringify(schedules) } : {}),
      };
      const response = await send(url, init);
      if (!response.ok) throw new SnapshotCalendarError('HTTP', response.status);
      return await readJson(response);
    } catch (error) {
      if (error instanceof SnapshotCalendarError) throw error;
      throw new SnapshotCalendarError('REQUEST');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function request(schedules?: { cron: string }[]) {
    const parsed = scheduleResult.safeParse(await requestJson(endpoint, schedules));
    if (!parsed.success) throw new SnapshotCalendarError('RESPONSE');
    return parsed.data.result.schedules.map(({ cron }) => cron);
  }

  async function verifyEmpty() {
    if ((await request()).length !== 0) throw new SnapshotCalendarError('NOT_EMPTY');
    return { worker, empty: true as const, observedAt: new Date().toISOString() };
  }

  async function verifyAccountToken(cleanupDeadline: string) {
    const deadline = Date.parse(cleanupDeadline);
    if (worker !== FRESH_SNAPSHOT_STAGE_ID || !Number.isFinite(deadline) || deadline <= Date.now() ||
      new Date(deadline).toISOString() !== cleanupDeadline) throw new SnapshotCalendarError('CREDENTIAL_EXPIRY');
    const tokenStatus = accountTokenResult.safeParse(await requestJson(`${account}/tokens/verify`));
    if (!tokenStatus.success) throw new SnapshotCalendarError('CREDENTIAL');
    const { expires_on: expiresAt, not_before: notBefore } = tokenStatus.data.result;
    if (Date.parse(expiresAt) <= deadline + SNAPSHOT_CALENDAR_REQUEST_MS || (notBefore && Date.parse(notBefore) > Date.now())) {
      throw new SnapshotCalendarError('CREDENTIAL_EXPIRY');
    }
    return { expiresAt };
  }

  return {
    verifyEmpty,
    verifyAccountToken,
    async verifyCleanupAccess(cleanupDeadline: string) {
      const { expiresAt } = await verifyAccountToken(cleanupDeadline);
      await verifyEmpty();
      const acknowledged = await request([]);
      const readback = await verifyEmpty();
      if (acknowledged.length !== 0) throw new SnapshotCalendarError('CLEANUP_ACCESS');
      return { ...readback, expiresAt, putAcknowledged: true as const };
    },
    async arm(scheduledAt: string, beforeWrite: () => void) {
      const cron = snapshotEventCron(scheduledAt);
      await verifyEmpty();
      beforeWrite();
      const acknowledged = await request([{ cron }]);
      const observed = await request();
      if (acknowledged.length !== 1 || acknowledged[0] !== cron || observed.length !== 1 || observed[0] !== cron) {
        throw new SnapshotCalendarError('NOT_ARMED');
      }
      return { worker, scheduledAt, cron, observedAt: new Date().toISOString() };
    },
    async clear(scheduledAt: string) {
      const expected = snapshotEventCron(scheduledAt);
      const before = await request();
      if (before.length !== 0 && (before.length !== 1 || before[0] !== expected)) {
        throw new SnapshotCalendarError('UNEXPECTED');
      }

      // A lost write response does not establish whether Cloudflare applied the PUT.
      // Always read independently and never resend the write within this attempt.
      const put = await request([]).catch(() => null);
      const readback = await verifyEmpty();
      const putAcknowledged = put?.length === 0;
      return { ...readback, scheduledAt, initiallyEmpty: before.length === 0, putAcknowledged };
    },
  };
}
