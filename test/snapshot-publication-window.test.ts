import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import creation from '../docs/evidence/2026-11-22/november-workflow-creation.json';
import { FRESH_SNAPSHOT_STAGE_ID as worker } from '../scripts/lib/snapshot-calendar';
import { missingSnapshotDiagnosticKey, MissingSnapshotDiagnostic } from '../scripts/lib/snapshot-hosted-admission';
import { createSnapshotCfOutcomeReader } from '../scripts/lib/snapshot-publication-cf';
import { runStagedSnapshotPublication } from '../scripts/lib/snapshot-publication-window';
import * as verifier from '../scripts/verify-staged-snapshot';
import { QUALIFICATION_STAGE_ID, qualificationIdentity, qualificationRecord } from '../services/snapshot/qualification';

const scheduledAt = '2030-11-23T03:47:00.000Z', clearAt = '2030-11-23T04:07:00.000Z', cleanupDeadline = '2030-11-23T04:10:00.000Z';
const runtimeDeadline = '2030-11-23T05:47:00.000Z', cron = '47 3 23 11 *';
const configSha256 = 'b'.repeat(64);
const { canonical, reference } = verifier.stagedPublicationPins;
const window = { scheduledAt, clearAt, cleanupDeadline };
const dirs: string[] = [];

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-11-23T03:00:00.000Z'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'snapshot-publication-window-'));
  dirs.push(dir);
  const qualification = await qualificationIdentity({ SNAPSHOT_STAGE_ID: QUALIFICATION_STAGE_ID,
    SNAPSHOT_PINNED_COMMIT: reference.commit, SNAPSHOT_PINNED_DATE: reference.date, SNAPSHOT_QUALIFICATION_ID: 'nov16-20301123-0347',
    SNAPSHOT_QUALIFICATION_CRON: cron, SNAPSHOT_QUALIFICATION_TIME: String(Date.parse(scheduledAt)),
    SNAPSHOT_QUALIFICATION_DEADLINE: String(Date.parse(runtimeDeadline)) });
  const options = { packetPath: join(dir, 'prepared-stage.json'), journal: join(dir, 'journal'),
    deployment: { deploymentId: creation.bootstrap.deploymentId, versionId: creation.bootstrap.versionId, workflowId: creation.workflow.id, configSha256 },
    evidenceTime: { admissionMs: 30_000, observationMs: 60_000 },
    operator: { token: 'fixture-operator', validUntil: runtimeDeadline },
    guards: { primary: { token: 'fixture-primary', validUntil: runtimeDeadline }, backup: { token: 'fixture-backup', validUntil: runtimeDeadline } } };
  await writeFile(options.packetPath, JSON.stringify({ target: worker, configSha256,
    bundle: { bytes: creation.bootstrap.bundleBytes, sha256: creation.bootstrap.bundleSha256 },
    publication: { bucket: 'civicsignal-v1-stage-corpus-20261022', qualification, window, runtimeDeadline,
      referenceManifestSha256: reference.manifest.sha256 } }));
  const preflight = { reviewId: 'fixture-review', currentSource: qualification.identity.revision,
    prefixEmpty: true, manifestAbsent: true, instanceAbsent: true, canonical };
  const outcome = {
    instance: { id: qualification.instanceId, status: 'complete', startedAt: scheduledAt, endedAt: clearAt,
      output: { instanceId: qualification.instanceId, namespace: qualification.prefix, qualification: qualification.digest,
        count: reference.rows, commit: reference.commit } },
    diagnostics: { admitted: qualificationRecord(qualification, 'admitted'), discovered: qualificationRecord(qualification, 'discovered'),
      delegated: qualificationRecord(qualification, 'delegated-not-publication'),
      published: { ...qualificationRecord(qualification, 'published'), count: reference.rows, existing: false },
      failed: null, existing: null },
    attempts: { discovery: qualificationRecord(qualification, 'discovery'), authoritative: qualificationRecord(qualification, 'authoritative'),
      archive: qualificationRecord(qualification, 'archive') },
  };
  const readHosted = vi.fn(async (args: string[]) => args[0] === 'workers' ?
    [{ id: options.deployment.deploymentId, versions: [{ version_id: options.deployment.versionId, percentage: 100 }] }] :
    { name: worker, script_name: worker, class_name: 'CorpusSnapshot', id: creation.workflow.id, schedules: [] });
  const source = vi.fn();
  type Evidence = Parameters<typeof runStagedSnapshotPublication>[1];
  const evidence = { readHosted, admit: vi.fn<Evidence['admit']>().mockImplementation(async () => ({ ...preflight, observedAt: new Date(Date.now()).toISOString() })),
    observePublication: vi.fn(async () => outcome), openArtifact: vi.fn(() => source) };
  const empty = { empty: true, worker, observedAt: clearAt } as const;
  const guard = { ...empty, scheduledAt, initiallyEmpty: false, putAcknowledged: true };
  type CalendarRunner = NonNullable<Parameters<typeof runStagedSnapshotPublication>[2]>;
  const calendar: Awaited<ReturnType<CalendarRunner>> = { passed: true, worker, window,
    armReceipt: { worker, scheduledAt, cron, observedAt: '2030-11-23T03:29:00.000Z' },
    armingFailure: undefined, cleanup: { primary: guard, backup: guard, final: empty } };
  const armAndClean = vi.fn(() => calendar);
  const run: CalendarRunner = async calendarOptions => {
    await calendarOptions.admit(calendarOptions.window);
    return armAndClean();
  };
  const artifacts = { artifacts: reference.artifacts, artifactBytes: reference.artifactBytes, rows: reference.rows,
    manifestSha256: reference.manifest.sha256, canonical };
  const verify = vi.spyOn(verifier, 'verifyStagedPublicationArtifacts').mockResolvedValue(artifacts);
  return { options, evidence, run, armAndClean, calendar, qualification, preflight, outcome, verify, artifacts, source };
}

function cfFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const { qualification: q, outcome } = f;
  const instanceArgv = ['workflows', 'instances', 'get', q.instanceId, '--workflow-name', worker, '--simple', 'true'];
  const completed = { status: 'complete', start: outcome.instance.startedAt, end: outcome.instance.endedAt, trigger: { source: 'binding' },
    params: { revision: q.identity.revision, qualification: q.digest }, output: JSON.stringify(outcome.instance.output) };
  const { diagnostics, attempts } = outcome;
  const objects = { 'diagnostics/admitted.json': diagnostics.admitted, 'diagnostics/discovered.json': diagnostics.discovered,
    'diagnostics/delegated.json': diagnostics.delegated, 'diagnostics/published.json': diagnostics.published,
    'attempts/discovery.json': attempts.discovery, 'attempts/authoritative.json': attempts.authoritative, 'attempts/archive.json': attempts.archive };
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
  const read = vi.fn(async (argv: string[], _signal?: AbortSignal) => {
    if (argv[0] === 'workflows') return bytes({ success: true, result: completed });
    const suffix = argv[3]?.slice(q.prefix.length) ?? '';
    const receipt = objects[suffix as keyof typeof objects];
    if (!receipt) throw new Error('unexpected receipt request');
    return bytes(receipt);
  });
  const confirmMissing = vi.fn(async (_keys: Readonly<Record<'failed' | 'existing', string>>, _signal: AbortSignal) => ({ failed: null, existing: null }));
  const create = (maxInstanceReads = 1) => createSnapshotCfOutcomeReader({ maxInstanceReads, pollIntervalMs: 1, confirmMissing }, read);
  const preparedTarget: Parameters<ReturnType<typeof createSnapshotCfOutcomeReader>>[0] = {
    worker, bucket: 'civicsignal-v1-stage-corpus-20261022', qualification: q, window,
    workflowId: creation.workflow.id, configSha256, deployment: f.options.deployment, pins: verifier.stagedPublicationPins, evidenceTime: f.options.evidenceTime };
  return { read, bytes, completed, objects, confirmMissing, instanceArgv, create, preparedTarget };
}

describe('staging first-publication evidence composition', () => {
  it('binds reviewed preflight, fixed deployment, settled calendar, completed instance and pinned verification', async () => {
    const f = await fixture();
    await expect(runStagedSnapshotPublication(f.options, f.evidence, f.run)).resolves.toMatchObject({
      scope: 'staging-first-publication', worker, workflowId: creation.workflow.id, qualification: f.qualification.digest,
      instance: { id: f.qualification.instanceId, status: 'complete' }, artifacts: f.artifacts, calendar: f.calendar,
    });
    expect(f.evidence.admit).toHaveBeenCalledWith(expect.objectContaining({ worker, window, qualification: f.qualification, configSha256 }),
      expect.any(AbortSignal));
    expect(f.evidence.admit.mock.invocationCallOrder[0]).toBeLessThan(f.evidence.readHosted.mock.invocationCallOrder[0] ?? 0);
    expect(f.evidence.readHosted.mock.invocationCallOrder[0]).toBeLessThan(f.armAndClean.mock.invocationCallOrder[0] ?? 0);
    expect(f.armAndClean.mock.invocationCallOrder[0]).toBeLessThan(f.evidence.observePublication.mock.invocationCallOrder[0] ?? 0);
    expect(f.verify).toHaveBeenCalledWith(f.source);
  });

  it.each(['prefixEmpty', 'manifestAbsent', 'instanceAbsent'] as const)('refuses arming if %s is unproven', async key => {
    const f = await fixture();
    f.preflight[key] = false;
    await expect(runStagedSnapshotPublication(f.options, f.evidence, f.run)).rejects.toThrow('SNAPSHOT_PUBLICATION_ADMISSION');
    expect(f.armAndClean).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
  });

  it('refuses a stale preflight observation', async () => {
    const f = await fixture();
    f.evidence.admit.mockResolvedValueOnce({ ...f.preflight, observedAt: '2020-01-01T00:00:00.000Z' });
    await expect(runStagedSnapshotPublication(f.options, f.evidence, f.run)).rejects.toThrow('SNAPSHOT_PUBLICATION_ADMISSION');
    expect(f.armAndClean).not.toHaveBeenCalled();
  });

  it('cancels blocked preflight and never arms after its reviewed deadline', async () => {
    const f = await fixture();
    f.options.evidenceTime.admissionMs = 20;
    let signal: AbortSignal | undefined;
    f.evidence.admit.mockImplementationOnce(async (_target, given) => {
      signal = given;
      return new Promise(() => {});
    });
    await expect(runStagedSnapshotPublication(f.options, f.evidence, f.run)).rejects.toThrow('SNAPSHOT_PUBLICATION_EVIDENCE_DEADLINE');
    expect(signal?.aborted).toBe(true);
    expect(f.armAndClean).not.toHaveBeenCalled();
  });

  it('refuses an unexpected Workflow identity even when the provider reports an empty calendar', async () => {
    const f = await fixture();
    f.options.deployment.workflowId = creation.bootstrap.versionId;
    await expect(runStagedSnapshotPublication(f.options, f.evidence, f.run)).rejects.toThrow('SNAPSHOT_HOSTED_WORKFLOW_DRIFT');
    expect(f.armAndClean).not.toHaveBeenCalled();
  });

  it('leaves an unsettled calendar out of qualification', async () => {
    const f = await fixture();
    f.calendar.passed = false;
    await expect(runStagedSnapshotPublication(f.options, f.evidence, f.run)).rejects.toThrow('SNAPSHOT_PUBLICATION_CALENDAR');
    expect(f.evidence.observePublication).not.toHaveBeenCalled();
  });

  it('rejects completed Workflow reuse before reading artifacts', async () => {
    const f = await fixture();
    const instance = { ...f.outcome.instance, output: { ...f.outcome.instance.output, existing: true } };
    f.evidence.observePublication.mockResolvedValueOnce({ ...f.outcome, instance });
    await expect(runStagedSnapshotPublication(f.options, f.evidence, f.run)).rejects.toThrow('SNAPSHOT_PUBLICATION_WORKFLOW_OUTPUT');
    expect(f.verify).not.toHaveBeenCalled();
  });

  it('rejects publication without scheduled admission and reserved source work', async () => {
    const f = await fixture();
    f.evidence.observePublication.mockResolvedValueOnce({ ...f.outcome, diagnostics: { ...f.outcome.diagnostics,
      admitted: qualificationRecord(f.qualification, 'rejected') } });
    await expect(runStagedSnapshotPublication(f.options, f.evidence, f.run)).rejects.toThrow('SNAPSHOT_PUBLICATION_DIAGNOSTICS');
    f.evidence.observePublication.mockResolvedValueOnce({ ...f.outcome, attempts: { ...f.outcome.attempts,
      discovery: qualificationRecord(f.qualification, 'authoritative') } });
    await expect(runStagedSnapshotPublication(f.options, f.evidence, f.run)).rejects.toThrow('SNAPSHOT_PUBLICATION_SOURCE_ATTEMPTS');
    expect(f.verify).not.toHaveBeenCalled();
  });

  it('reads the exact Workflow and scoped R2 receipts before calling the artifact verifier', async () => {
    const f = await fixture();
    const cf = cfFixture(f);
    await expect(runStagedSnapshotPublication(f.options, { ...f.evidence, observePublication: cf.create() }, f.run)).resolves.toMatchObject({
      scope: 'staging-first-publication', instance: { id: f.qualification.instanceId, status: 'complete' }, artifacts: f.artifacts,
    });
    expect(cf.read.mock.calls.map(call => call[0])).toEqual([cf.instanceArgv, ...Object.keys(cf.objects).map(suffix =>
      ['r2', 'objects', 'get', f.qualification.prefix + suffix, '--bucket-name', 'civicsignal-v1-stage-corpus-20261022'])]);
    const signal = cf.read.mock.calls[0]?.[1];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(cf.read.mock.calls.every(([, received]) => received === signal)).toBe(true);
    expect(cf.confirmMissing).toHaveBeenCalledWith({ failed: f.qualification.prefix + 'diagnostics/failed.json',
      existing: f.qualification.prefix + 'diagnostics/existing.json' }, signal);
  });

  it('requires the missing-key code and exact cf HTTP path for an absent diagnostic', async () => {
    const f = await fixture();
    const key = f.qualification.prefix + 'diagnostics/failed.json';
    const bucket = 'civicsignal-v1-stage-corpus-20261022';
    const args = ['r2', 'objects', 'get', key, '--bucket-name', bucket];
    const path = `/accounts/${creation.accountId}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`;
    const reply = `│ [10007] The specified key does not exist.\n│ 404 Not Found · HTTP ${path}\n`;
    const error = (text: string) => ({ code: 1, stderr: Buffer.from(text) });
    expect(missingSnapshotDiagnosticKey(args, error(reply))).toBe(key);
    for (const invalid of [reply.replace('10007', '9109'), reply.replace('404', '403'), reply.replace('failed.json', 'existing.json')]) {
      expect(missingSnapshotDiagnosticKey(args, error(invalid))).toBeUndefined();
    }
  });

  it('checks both negative diagnostic keys with cf and fails on an authorization error', async () => {
    const f = await fixture(), cf = cfFixture(f);
    const missingKeys = ['failed', 'existing'].map(name => f.qualification.prefix + `diagnostics/${name}.json`);
    let refuse = false;
    const read = async (args: string[], signal?: AbortSignal) => {
      const key = args[3] ?? '';
      if (missingKeys.includes(key)) {
        if (refuse) throw new Error('SNAPSHOT_HOSTED_CF_READ');
        throw new MissingSnapshotDiagnostic(key);
      }
      return cf.read(args, signal);
    };
    const observe = createSnapshotCfOutcomeReader({ maxInstanceReads: 1, pollIntervalMs: 1 }, read);
    await expect(observe(cf.preparedTarget, new AbortController().signal)).resolves.toMatchObject({
      diagnostics: { failed: null, existing: null },
    });
    refuse = true;
    await expect(observe(cf.preparedTarget, new AbortController().signal)).rejects.toThrow('SNAPSHOT_HOSTED_CF_READ');
  });

  it('polls only the exact instance and stops at the reviewed count', async () => {
    const f = await fixture();
    const cf = cfFixture(f);
    cf.read.mockResolvedValue(cf.bytes({ status: 'running' }));
    await expect(cf.create(2)(cf.preparedTarget, new AbortController().signal)).rejects.toThrow('SNAPSHOT_CF_PUBLICATION_INSTANCE_READS_EXHAUSTED');
    expect(cf.read.mock.calls.map(call => call[0])).toEqual([cf.instanceArgv, cf.instanceArgv]);
    expect(cf.confirmMissing).not.toHaveBeenCalled();
  });

  it('forwards cancellation and starts no additional reads after it', async () => {
    const f = await fixture();
    const cf = cfFixture(f);
    const deadline = new AbortController();
    cf.read.mockImplementationOnce(async () => {
      deadline.abort();
      return cf.bytes({ status: 'running' });
    });
    await expect(cf.create(2)(cf.preparedTarget, deadline.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(cf.read).toHaveBeenCalledTimes(1);
    expect(cf.read).toHaveBeenCalledWith(cf.instanceArgv, deadline.signal);
  });

  it('rejects a direct Workflow API invocation and an out-of-namespace target', async () => {
    const f = await fixture();
    const cf = cfFixture(f);
    cf.read.mockResolvedValueOnce(cf.bytes({ ...cf.completed, trigger: { source: 'api' } }));
    const signal = new AbortController().signal;
    await expect(cf.create()(cf.preparedTarget, signal)).rejects.toThrow('SNAPSHOT_CF_PUBLICATION_INSTANCE');
    await expect(cf.create()({ ...cf.preparedTarget, qualification: { ...f.qualification, prefix: 'snapshots/' } }, signal))
      .rejects.toThrow('SNAPSHOT_CF_PUBLICATION_TARGET');
    expect(cf.read).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a refused receipt read and never treats it as negative evidence', async () => {
    const f = await fixture();
    const cf = cfFixture(f);
    cf.read.mockResolvedValueOnce(cf.bytes(cf.completed)).mockRejectedValueOnce(new Error('SNAPSHOT_HOSTED_CF_READ'));
    await expect(cf.create()(cf.preparedTarget, new AbortController().signal)).rejects.toThrow('SNAPSHOT_HOSTED_CF_READ');
    expect(cf.confirmMissing).not.toHaveBeenCalled();
  });

  it('rejects an oversized R2 receipt before reading further', async () => {
    const f = await fixture();
    const cf = cfFixture(f);
    cf.read.mockResolvedValueOnce(cf.bytes(cf.completed)).mockResolvedValueOnce(Buffer.alloc(2049));
    await expect(cf.create()(cf.preparedTarget, new AbortController().signal)).rejects.toThrow('SNAPSHOT_CF_PUBLICATION_RESPONSE');
    expect(cf.read).toHaveBeenCalledTimes(2);
    expect(cf.confirmMissing).not.toHaveBeenCalled();
  });
});
