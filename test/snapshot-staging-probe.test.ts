import { afterEach, describe, expect, it, vi } from 'vitest';
import { runStagingProbe, probeEventPrefix, SNAPSHOT_STAGE_ID, SNAPSHOT_STAGE_COMMIT,
  SNAPSHOT_STAGE_DATE, SNAPSHOT_PROBE_MAX_BYTES, type ProbeBucket } from '../services/snapshot/staging-probe-receipts';

const controls = { SNAPSHOT_STAGE_ID, SNAPSHOT_PINNED_COMMIT: SNAPSHOT_STAGE_COMMIT, SNAPSHOT_PINNED_DATE: SNAPSHOT_STAGE_DATE };
const event = { cron: '25 4 23 10 *', scheduledTime: Date.parse('2026-10-23T04:25:00Z') };
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const objects = new Map<string, Uint8Array>();
  const created: string[] = [];
  let failPhase: string | undefined;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const bucket = {
    async put(key: string, bytes: Uint8Array, options: { onlyIf: { etagDoesNotMatch: string } }) {
      expect(options.onlyIf).toEqual({ etagDoesNotMatch: '*' });
      if (key.endsWith(`/${failPhase}.json`)) { failPhase = undefined; throw new Error('private-provider-secret'); }
      if (objects.has(key)) return null;
      objects.set(key, bytes.slice()); created.push(key);
      return { size: bytes.length };
    },
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer } : null;
    },
  } as unknown as ProbeBucket;
  const env = { ...controls, CORPUS: bucket };
  const delegate = vi.fn(async () => {});
  return { env, objects, created, log, delegate, fail: (phase: string) => { failPhase = phase; } };
}

describe('immutable stage-only snapshot observations', () => {
  it.each([
    { SNAPSHOT_STAGE_ID: undefined }, { SNAPSHOT_STAGE_ID: 'civicsignal-snapshot' },
    { SNAPSHOT_PINNED_COMMIT: undefined }, { SNAPSHOT_PINNED_COMMIT: 'a'.repeat(40) },
    { SNAPSHOT_PINNED_DATE: undefined }, { SNAPSHOT_PINNED_DATE: '2026-10-16' },
  ])('refuses invalid controls before any diagnostic write or delegate: %j', async (override) => {
    const f = fixture();
    await expect(runStagingProbe({ ...f.env, ...override }, event, f.delegate)).rejects.toThrow('configuration is invalid');
    expect(f.objects.size).toBe(0); expect(f.delegate).not.toHaveBeenCalled(); expect(f.log).not.toHaveBeenCalled();
  });

  it('replays a nominal event without replacing immutable bytes and distinguishes cron identities', async () => {
    const f = fixture();
    await runStagingProbe(f.env, event, f.delegate);
    const original = new Map([...f.objects].map(([key, bytes]) => [key, new TextDecoder().decode(bytes)]));
    await runStagingProbe(f.env, event, f.delegate);
    expect(f.created).toHaveLength(2);
    expect(new Map([...f.objects].map(([key, bytes]) => [key, new TextDecoder().decode(bytes)]))).toEqual(original);
    for (const bytes of f.objects.values()) {
      expect(bytes.length).toBeLessThanOrEqual(SNAPSHOT_PROBE_MAX_BYTES);
      expect(JSON.parse(new TextDecoder().decode(bytes))).not.toHaveProperty('observedAt');
    }
    expect(await probeEventPrefix({ ...event, cron: '25 4 * * *' })).not.toBe(await probeEventPrefix(event));
  });

  it('retains entered/failed evidence without exposing a source/provider exception', async () => {
    const f = fixture();
    await expect(runStagingProbe(f.env, event, async () => { throw new Error('Bearer do-not-disclose'); }))
      .rejects.toThrow('Snapshot staging scheduled handler failed.');
    expect(f.created.map((key) => key.split('/').at(-1))).toEqual(['entered.json', 'failed.json']);
    expect([...f.objects.values()].map((bytes) => new TextDecoder().decode(bytes)).join('')).not.toMatch(/Bearer|do-not-disclose/);
    expect(JSON.stringify(f.log.mock.calls)).not.toMatch(/Bearer|do-not-disclose/);
  });

  it('does not delegate when durable entry verification fails', async () => {
    const f = fixture(); f.fail('entered');
    await expect(runStagingProbe(f.env, event, f.delegate)).rejects.toThrow('entry receipt failed');
    expect(f.delegate).not.toHaveBeenCalled();
    expect(f.created.map((key) => key.split('/').at(-1))).toEqual(['failed.json']);
  });

  it('preserves a partial failure and recovers a completion-receipt failure on replay within three objects', async () => {
    const f = fixture(); f.fail('completed');
    await expect(runStagingProbe(f.env, event, f.delegate)).rejects.toThrow('completion receipt failed');
    const prefix = await probeEventPrefix(event);
    const entered = f.objects.get(prefix + 'entered.json')!.slice();
    const failed = f.objects.get(prefix + 'failed.json')!.slice();
    await runStagingProbe(f.env, event, f.delegate);
    expect(f.created).toHaveLength(3);
    expect(f.objects.get(prefix + 'entered.json')).toEqual(entered);
    expect(f.objects.get(prefix + 'failed.json')).toEqual(failed);
    expect(f.objects.has(prefix + 'completed.json')).toBe(true);
  });

  it('refuses an immutable identity conflict without overwriting it or calling the delegate', async () => {
    const f = fixture(); const key = await probeEventPrefix(event) + 'entered.json';
    const protectedBytes = new TextEncoder().encode('preexisting protected bytes');
    f.objects.set(key, protectedBytes);
    await expect(runStagingProbe(f.env, event, f.delegate)).rejects.toThrow('entry receipt failed');
    expect(f.objects.get(key)).toEqual(protectedBytes); expect(f.delegate).not.toHaveBeenCalled();
  });

  it.each([{ ...event, scheduledTime: NaN }, { ...event, scheduledTime: -1 },
    { ...event, scheduledTime: 1.5 }, { ...event, cron: 'x'.repeat(129) }, { ...event, cron: '\n' }])
  ('rejects malformed nominal event identity before writes', async (invalid) => {
    const f = fixture();
    await expect(runStagingProbe(f.env, invalid, f.delegate)).rejects.toThrow('event is invalid');
    expect(f.objects.size).toBe(0); expect(f.delegate).not.toHaveBeenCalled();
  });
});
