import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshotCalendarMain } from '../scripts/snapshot-calendar';

const worker = 'civicsignal-v1-stage-snapshot-20261022';
const endpoint = `https://api.cloudflare.com/client/v4/accounts/ad5ec479b9a421faa2ed06c3d1c2b23a/workers/scripts/${worker}/schedules`;
const scheduledAt = '2030-11-23T03:47:00.000Z';
const cron = '47 3 23 11 *';
const args = ['clear', '--scheduled-at', scheduledAt];
const env = { CLOUDFLARE_API_TOKEN: 'fixture-token' };
const schedules = (...crons: string[]) => Response.json({ success: true, result: { schedules: crons.map(cron => ({ cron })) } });
const mockFetch = () => vi.fn<typeof fetch>();
const verifyCleanup = ['--fresh', 'verify-cleanup', '--cleanup-deadline', '2030-11-23T04:10:00.000Z'];
const accountToken = (expiresOn: string) => Response.json({ success: true, result: { status: 'active', expires_on: expiresOn } });

describe('staging snapshot calendar', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-11-23T03:00:00.000Z'));
  });

  afterEach(() => vi.restoreAllMocks());

  it('proves the fresh cleanup credential lifetime and confirms an acknowledged empty write', async () => {
    const expiresAt = '2030-11-23T04:15:00.000Z';
    const send = mockFetch().mockResolvedValueOnce(accountToken(expiresAt)).mockResolvedValueOnce(schedules())
      .mockResolvedValueOnce(schedules()).mockResolvedValueOnce(schedules());
    await expect(snapshotCalendarMain(verifyCleanup, env, send)).resolves.toMatchObject({ expiresAt, empty: true, putAcknowledged: true });
    expect(send.mock.calls.map(([url, init]) => [new URL(String(url)).pathname.split('/').slice(-2).join('/'), init?.method, init?.body]))
      .toEqual([['tokens/verify', 'GET', undefined], ['civicsignal-v1-stage-nov16-snapshot/schedules', 'GET', undefined],
        ['civicsignal-v1-stage-nov16-snapshot/schedules', 'PUT', '[]'], ['civicsignal-v1-stage-nov16-snapshot/schedules', 'GET', undefined]]);
  });

  it('rejects early expiry before touching the calendar', async () => {
    const send = mockFetch().mockResolvedValueOnce(accountToken('2030-11-23T04:10:10.000Z'));
    await expect(snapshotCalendarMain(verifyCleanup, env, send)).rejects.toMatchObject({ code: 'CREDENTIAL_EXPIRY' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses an unexpected schedule and rejects a credential that only has read access', async () => {
    const expiresAt = '2030-11-23T04:15:00.000Z';
    const nonempty = mockFetch().mockResolvedValueOnce(accountToken(expiresAt)).mockResolvedValueOnce(schedules(cron));
    await expect(snapshotCalendarMain(verifyCleanup, env, nonempty)).rejects.toMatchObject({ code: 'NOT_EMPTY' });
    expect(nonempty).toHaveBeenCalledTimes(2);
    const readOnly = mockFetch().mockResolvedValueOnce(accountToken(expiresAt)).mockResolvedValueOnce(schedules())
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(snapshotCalendarMain(verifyCleanup, env, readOnly)).rejects.toMatchObject({ code: 'HTTP', status: 403 });
    expect(readOnly).toHaveBeenCalledTimes(3);
  });

  it('uses a scoped PUT with an explicit empty list and confirms it with a separate GET', async () => {
    const send = mockFetch().mockResolvedValueOnce(schedules(cron)).mockResolvedValueOnce(schedules()).mockResolvedValueOnce(schedules());
    await expect(snapshotCalendarMain(args, env, send)).resolves.toMatchObject({ worker, scheduledAt, empty: true,
      initiallyEmpty: false, putAcknowledged: true });
    expect(send.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      [endpoint, 'GET', undefined], [endpoint, 'PUT', '[]'], [endpoint, 'GET', undefined],
    ]);
    for (const [, request] of send.mock.calls) {
      expect(request).toMatchObject({ redirect: 'error', credentials: 'omit',
        headers: { Authorization: 'Bearer fixture-token', Accept: 'application/json', 'Cache-Control': 'no-cache, no-store' } });
    }
    expect(send.mock.calls[1]?.[1]?.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('allows separate guards to clear the same owned calendar and a separate observer to verify it', async () => {
    let calendar = [cron];
    const send = mockFetch().mockImplementation(async (_url, request) => {
      if (request?.method === 'PUT') calendar = [];
      return schedules(...calendar);
    });
    await expect(snapshotCalendarMain(args, env, send)).resolves.toMatchObject({ initiallyEmpty: false, putAcknowledged: true });
    await expect(snapshotCalendarMain(args, { CLOUDFLARE_API_TOKEN: 'backup-fixture' }, send))
      .resolves.toMatchObject({ initiallyEmpty: true, putAcknowledged: true });
    send.mockClear();
    await expect(snapshotCalendarMain(['verify-empty'], env, send)).resolves.toMatchObject({ worker, empty: true });
    expect(send.mock.calls).toEqual([[endpoint, expect.objectContaining({ method: 'GET' })]]);
  });

  it.each([{ crons: ['0 12 * * *'] }, { crons: [cron, '0 12 * * *'] }, { crons: [cron, cron] }])
    ('refuses an unexpected calendar without writing ($crons)', async ({ crons }) => {
    const send = mockFetch().mockResolvedValueOnce(schedules(...crons));
    await expect(snapshotCalendarMain(args, env, send)).rejects.toMatchObject({ code: 'UNEXPECTED' });
    expect(send.mock.calls).toEqual([[endpoint, expect.objectContaining({ method: 'GET' })]]);
  });

  it.each(['2030-11-23T03:47:30.000Z', '2030-11-23T03:47:00+00:00', '2030-02-30T03:47:00.000Z', 'invalid'])
    ('rejects a noncanonical UTC minute before any request (%s)', async date => {
      const send = mockFetch();
      await expect(snapshotCalendarMain(['clear', '--scheduled-at', date], env, send)).rejects.toMatchObject({ code: 'EVENT' });
      expect(send).not.toHaveBeenCalled();
    });

  it('refuses missing or malformed credentials and unsupported CLI operations before any request', async () => {
    const send = mockFetch();
    await expect(snapshotCalendarMain(args, {}, send)).rejects.toMatchObject({ code: 'CREDENTIAL' });
    await expect(snapshotCalendarMain(args, { CLOUDFLARE_API_TOKEN: 'invalid\nvalue' }, send)).rejects.toMatchObject({ code: 'CREDENTIAL' });
    await expect(snapshotCalendarMain(['arm'], env, send)).rejects.toThrow('Usage');
    expect(send).not.toHaveBeenCalled();
  });

  it('still verifies an ambiguous write once without replaying it or claiming acknowledgment', async () => {
    const send = mockFetch().mockResolvedValueOnce(schedules(cron)).mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(schedules());
    await expect(snapshotCalendarMain(args, env, send)).resolves.toMatchObject({ empty: true, putAcknowledged: false });
    expect(send.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'PUT', 'GET']);
  });

  it.each([true, false])('fails when readback is nonempty after an acknowledged or ambiguous PUT (%s)', async acknowledged => {
    const send = mockFetch().mockResolvedValueOnce(schedules(cron));
    if (acknowledged) send.mockResolvedValueOnce(schedules());
    else send.mockRejectedValueOnce(new Error('connection lost'));
    send.mockResolvedValueOnce(schedules(cron));
    await expect(snapshotCalendarMain(args, env, send)).rejects.toMatchObject({ code: 'NOT_EMPTY' });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['API refusal', () => Response.json({ success: false, result: { schedules: [] } })],
    ['malformed list', () => Response.json({ success: true, result: { schedules: [{}] } })],
    ['oversized body', () => new Response(' '.repeat(17 * 1024))],
  ] as const)('fails closed on %s', async (_name, response) => {
    const send = mockFetch().mockResolvedValueOnce(response());
    await expect(snapshotCalendarMain(args, env, send)).rejects.toMatchObject({ code: 'RESPONSE' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns a safe status for readback failure even when the PUT returned an empty calendar', async () => {
    const send = mockFetch().mockResolvedValueOnce(schedules(cron)).mockResolvedValueOnce(schedules())
      .mockResolvedValueOnce(new Response('sensitive provider details', { status: 403 }));
    await expect(snapshotCalendarMain(args, env, send)).rejects.toMatchObject({ code: 'HTTP', status: 403, message: 'SNAPSHOT_CALENDAR_HTTP' });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('aborts a stalled read', async () => {
    vi.useFakeTimers();
    try {
      const send = mockFetch().mockImplementation((_url, request) => new Promise((_resolve, reject) => {
        request?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }));
      const failed = expect(snapshotCalendarMain(args, env, send)).rejects.toMatchObject({ code: 'REQUEST' });
      await vi.advanceTimersByTimeAsync(10_000);
      await failed;
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
