import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import creation from '../docs/evidence/2026-11-22/november-workflow-creation.json';
import { QUALIFICATION_STAGE_ID, qualificationIdentity, qualificationRecord } from '../services/snapshot/qualification';
import { FRESH_SNAPSHOT_STAGE_ID as worker } from '../scripts/lib/snapshot-calendar';
import { writeSnapshotWindowReceipt } from '../scripts/lib/snapshot-calendar-window';
import { MissingSnapshotDiagnostic, MissingSnapshotWorkflowInstance, readSnapshotCfBytes } from '../scripts/lib/snapshot-hosted-admission';
import { runStagedSnapshotPublication } from '../scripts/lib/snapshot-publication-window';
import { runStagedSnapshotPublicationMain, verifyPublicationVersion } from '../scripts/run-staged-snapshot-publication';
import * as verifier from '../scripts/verify-staged-snapshot';

type Dependencies = NonNullable<Parameters<typeof runStagedSnapshotPublicationMain>[2]>;
const scheduledAt = '2030-11-23T03:47:00.000Z', clearAt = '2030-11-23T04:07:00.000Z', cleanupDeadline = '2030-11-23T04:10:00.000Z';
const runtimeDeadline = '2030-11-23T05:47:00.000Z', operatorExpiry = '2030-11-23T04:15:00.000Z';
const window = { scheduledAt, clearAt, cleanupDeadline }, cron = '47 3 23 11 *';
const { reference, canonical } = verifier.stagedPublicationPins;
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const dirs: string[] = [];
const env = { CLOUDFLARE_API_TOKEN: 'fixture-schedule', CIVICSIGNAL_SNAPSHOT_PRIMARY_GUARD_TOKEN: 'fixture-primary',
  CIVICSIGNAL_SNAPSHOT_R2_READ_TOKEN: 'fixture-r2' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-11-23T03:00:00.000Z'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'staged-snapshot-run-')));
  dirs.push(directory);
  const qualification = await qualificationIdentity({ SNAPSHOT_STAGE_ID: QUALIFICATION_STAGE_ID,
    SNAPSHOT_PINNED_COMMIT: reference.commit, SNAPSHOT_PINNED_DATE: reference.date, SNAPSHOT_QUALIFICATION_ID: 'nov16-20301123-0347',
    SNAPSHOT_QUALIFICATION_CRON: cron, SNAPSHOT_QUALIFICATION_TIME: String(Date.parse(scheduledAt)),
    SNAPSHOT_QUALIFICATION_DEADLINE: String(Date.parse(runtimeDeadline)) });
  const config = '{}\n';
  const configDir = join(directory, '.cloudflare/output/v0/workers/default');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const configPath = join(configDir, 'worker.config.json');
  await writeFile(configPath, config, { mode: 0o600 });
  const packetPath = join(directory, 'prepared-stage.json');
  const configSha256 = sha256(config);
  const pocket = JSON.stringify({ target: worker, configSha256, bundle: { bytes: creation.bootstrap.bundleBytes, sha256: creation.bootstrap.bundleSha256 },
    publication: { bucket: 'civicsignal-v1-stage-corpus-20261022', window, qualification, runtimeDeadline,
      referenceManifestSha256: reference.manifest.sha256 } });
  await writeFile(packetPath, pocket, { mode: 0o600 });
  const spec: Parameters<typeof verifyPublicationVersion>[0] = {
    format: 1, worker, review: { id: 'fixture-review', execute: true, validUntil: '2030-11-23T08:00:00.000Z' },
    packet: { path: packetPath, bytes: Buffer.byteLength(pocket), sha256: sha256(pocket) },
    deployment: { deploymentId: creation.bootstrap.deploymentId, versionId: creation.bootstrap.versionId, workflowId: creation.workflow.id, configSha256 },
    cfMetadataProfile: 'fixture-metadata', journal: join(directory, 'journal'),
    credentialExpiries: { operator: operatorExpiry, primary: operatorExpiry, backup: operatorExpiry },
    evidence: { admissionMs: 60_000, observationMs: 60_000, maxInstanceReads: 2, pollIntervalMs: 100 } };
  const specPath = join(directory, 'run-spec.json');
  const writeSpec = () => writeFile(specPath, JSON.stringify(spec), { mode: 0o600 });
  await writeSpec();
  return { spec, specPath, configPath, writeSpec, argv: ['--reviewed-spec', specPath], qualification };
}

function providers(f: Awaited<ReturnType<typeof fixture>>) {
  const q = f.qualification, { spec } = f;
  const controls = { working: false, operatorExpiry };
  const diagnostics = { 'admitted.json': qualificationRecord(q, 'admitted'), 'discovered.json': qualificationRecord(q, 'discovered'),
    'delegated.json': qualificationRecord(q, 'delegated-not-publication'),
    'published.json': { ...qualificationRecord(q, 'published'), count: reference.rows, existing: false },
    'discovery.json': qualificationRecord(q, 'discovery'), 'authoritative.json': qualificationRecord(q, 'authoritative'),
    'archive.json': qualificationRecord(q, 'archive') };
  const read = vi.fn<Dependencies['read']>().mockImplementation(async args => {
    const json = (value: unknown) => Buffer.from(JSON.stringify(value));
    if (args[0] === 'workers') return json([{ id: spec.deployment.deploymentId, versions: [{ version_id: spec.deployment.versionId, percentage: 100 }] }]);
    if (args[0] === 'workflows' && args[1] === 'get') return json({ name: worker, script_name: worker, class_name: 'CorpusSnapshot',
      id: spec.deployment.workflowId, schedules: [] });
    if (args[0] === 'workflows') {
      if (!controls.working) throw new MissingSnapshotWorkflowInstance(q.instanceId);
      return json({ status: 'complete', start: scheduledAt, end: clearAt, trigger: { source: 'binding' },
        params: { revision: q.identity.revision, qualification: q.digest },
        output: { instanceId: q.instanceId, namespace: q.prefix, qualification: q.digest, commit: reference.commit, count: reference.rows } });
    }
    const key = args[3] ?? '';
    const [, name] = key.split('/').slice(-2);
    if (name === 'failed.json' || name === 'existing.json') throw new MissingSnapshotDiagnostic(key);
    return json(diagnostics[name as keyof typeof diagnostics]);
  });
  const send = vi.fn<Dependencies['send']>().mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/tokens/verify')) return Response.json({ success: true, result: { status: 'active', expires_on: controls.operatorExpiry } });
    if (url.hostname === 'api.github.com') return Response.json([{ sha: reference.commit, commit: { committer: { date: reference.date + 'T00:00:00Z' } } }]);
    if (url.searchParams.has('prefix')) return Response.json({ success: true, result: [], errors: [], result_info: { is_truncated: false } });
    if (url.pathname.endsWith(reference.manifest.key)) return Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
    return new Response(await readFile('docs/evidence/2026-10-31/reference-snapshot-manifest.json', 'utf8'));
  });
  const verifyVersion = vi.fn<Dependencies['verifyVersion']>().mockResolvedValue(undefined);
  const arm = vi.fn(() => { controls.working = true; });
  const run = vi.fn<Dependencies['run']>().mockImplementation((options, evidence) => runStagedSnapshotPublication(options, evidence, async phase => {
    await phase.admit(phase.window);
    arm();
    await mkdir(phase.journal, { mode: 0o700 });
    const empty = { worker, empty: true, observedAt: cleanupDeadline } as const;
    const guard = { ...empty, scheduledAt, initiallyEmpty: false, putAcknowledged: true };
    return { worker, window, passed: true, armingFailure: undefined, armReceipt: { worker, scheduledAt, cron, observedAt: '' },
      cleanup: { primary: guard, backup: guard, final: empty } };
  }));
  vi.spyOn(verifier, 'verifyStagedPublicationArtifacts').mockResolvedValue({ artifacts: reference.artifacts, artifactBytes: reference.artifactBytes,
    rows: reference.rows, manifestSha256: reference.manifest.sha256, canonical });
  return { controls, arm, dependencies: { run, read, send, verifyVersion, writeReceipt: writeSnapshotWindowReceipt } };
}

describe('reviewed staging publication CLI', () => {
  it('runs the reviewed packet and seals a receipt with separate schedule, metadata and R2 contexts', async () => {
    const f = await fixture();
    await utimes(f.specPath, new Date('2000-01-01T00:00:00.000Z'), new Date());
    const { dependencies, arm } = providers(f);
    const result = await runStagedSnapshotPublicationMain(f.argv, env, dependencies);
    expect(arm).toHaveBeenCalledTimes(1);
    expect(dependencies.run.mock.calls[0]?.[0]).toMatchObject({ operator: { token: 'fixture-schedule', validUntil: operatorExpiry },
      guards: { primary: { token: 'fixture-primary' }, backup: { token: 'fixture-schedule' } } });
    expect(dependencies.send.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
    expect(new Headers(dependencies.send.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer fixture-schedule');
    expect(dependencies.read.mock.calls.filter(([args]) => args[0] === 'r2').every(([, , options]) =>
      options?.r2ReadToken === 'fixture-r2' && options.profile === undefined)).toBe(true);
    expect(dependencies.read.mock.calls.filter(([args]) => args[0] !== 'r2').every(([, , options]) =>
      options?.profile === f.spec.cfMetadataProfile && options.r2ReadToken === undefined)).toBe(true);
    const durable = await readFile(join(f.spec.journal, 'publication-result.json'), 'utf8');
    expect(JSON.parse(durable)).toEqual(result);
    expect(result).toMatchObject({ operatorTokenExpiresAt: operatorExpiry, reviewId: f.spec.review.id, packetSha256: f.spec.packet.sha256 });
    expect(durable).not.toMatch(/fixture-schedule|fixture-primary|fixture-r2/);
  });

  it('rejects packet drift and an expired review before provider access or arming', async () => {
    const f = await fixture();
    const { dependencies, arm } = providers(f);
    f.spec.review.validUntil = '2030-11-23T06:00:00.000Z';
    await f.writeSpec();
    await expect(runStagedSnapshotPublicationMain(f.argv, env, dependencies)).rejects.toThrow('SNAPSHOT_PUBLICATION_RUN_REVIEW_EXPIRY');
    f.spec.packet.sha256 = 'a'.repeat(64);
    await f.writeSpec();
    await expect(runStagedSnapshotPublicationMain(f.argv, env, dependencies)).rejects.toThrow('SNAPSHOT_PROPOSAL_INPUT_DRIFT');
    expect(arm).not.toHaveBeenCalled();
    expect(dependencies.run).not.toHaveBeenCalled();
    expect(dependencies.read).not.toHaveBeenCalled();
    expect(dependencies.send).not.toHaveBeenCalled();
  });

  it('refuses a changed prepared config before the calendar is entered', async () => {
    const f = await fixture();
    const { dependencies, arm } = providers(f);
    await writeFile(f.configPath, '[]\n');
    await expect(runStagedSnapshotPublicationMain(f.argv, env, dependencies)).rejects.toThrow('SNAPSHOT_PROPOSAL_INPUT_DRIFT');
    expect(arm).not.toHaveBeenCalled();
    expect(dependencies.run).not.toHaveBeenCalled();
    expect(dependencies.read).not.toHaveBeenCalled();
    expect(dependencies.send).not.toHaveBeenCalled();
  });

  it('refuses the actual operator expiry and a stale version before the calendar can write', async () => {
    const f = await fixture();
    const { dependencies, arm, controls } = providers(f);
    controls.operatorExpiry = clearAt;
    await expect(runStagedSnapshotPublicationMain(f.argv, env, dependencies)).rejects.toMatchObject({ code: 'CREDENTIAL_EXPIRY' });
    expect(dependencies.verifyVersion).not.toHaveBeenCalled();
    controls.operatorExpiry = operatorExpiry;
    dependencies.verifyVersion.mockRejectedValueOnce(new Error('SNAPSHOT_PUBLICATION_RUN_BINDINGS'));
    await expect(runStagedSnapshotPublicationMain(f.argv, env, dependencies)).rejects.toThrow('SNAPSHOT_PUBLICATION_RUN_BINDINGS');
    expect(arm).not.toHaveBeenCalled();
    expect(dependencies.send.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
  });

  it('binds the immutable version module and exact runtime bindings to the prepared packet', async () => {
    const f = await fixture();
    const packet = await verifier.loadStagedPublication(f.spec.packet.path);
    const module = Buffer.from('fixture module');
    const pinned = { ...packet, bundle: { bytes: module.length, sha256: sha256(module) } };
    const texts = [QUALIFICATION_STAGE_ID, reference.commit, reference.date, f.qualification.identity.id, cron,
      String(Date.parse(scheduledAt)), String(Date.parse(runtimeDeadline))];
    const bindings = ['STAGE_ID', 'PINNED_COMMIT', 'PINNED_DATE', 'QUALIFICATION_ID', 'QUALIFICATION_CRON', 'QUALIFICATION_TIME',
      'QUALIFICATION_DEADLINE'].map((name, i) => ({ name: 'SNAPSHOT_' + name, text: texts[i], type: 'plain_text' }));
    const data = { id: f.spec.deployment.versionId, urls: [], main_module: 'candidate.mjs',
      compatibility_date: '2026-10-22', compatibility_flags: ['nodejs_compat'], limits: { cpu_ms: 300_000, subrequests: 100_000 },
      modules: [{ name: 'candidate.mjs', content_type: 'application/javascript+module', content_base64: module.toString('base64') }],
      bindings: [...bindings, { name: 'CORPUS', type: 'r2_bucket', bucket_name: packet.publication.bucket },
        { name: 'SNAPSHOT', type: 'workflow', workflow_name: worker, script_name: worker, class_name: 'CorpusSnapshot' }] };
    const read = vi.fn<Dependencies['read']>().mockImplementation(async () => Buffer.from(JSON.stringify({ success: true, result: data })));
    const { signal } = new AbortController();
    await expect(verifyPublicationVersion(f.spec, pinned, read, signal)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledWith(['workers', 'versions', 'get', f.spec.deployment.versionId, '--worker-id', worker, '--include', 'modules'],
      signal, { profile: f.spec.cfMetadataProfile, versionModules: true });
    if (bindings[5]) bindings[5].text = '0';
    await expect(verifyPublicationVersion(f.spec, pinned, read, signal)).rejects.toThrow('SNAPSHOT_PUBLICATION_RUN_BINDINGS');
    await expect(verifyPublicationVersion(f.spec, packet, read, signal)).rejects.toThrow('SNAPSHOT_PUBLICATION_RUN_MODULE');
  });

  it('isolates subprocess tokens and refuses a diagnostic request outside the qualification namespace', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'staged-snapshot-cf-')));
    dirs.push(directory);
    await writeFile(join(directory, 'cf'), `#!/bin/sh
printf '%s|%s|%s' "\${CLOUDFLARE_API_TOKEN:-unset}" "\${CIVICSIGNAL_SNAPSHOT_R2_READ_TOKEN:-unset}" "$*"
`, { mode: 0o700 });
    vi.stubEnv('PATH', directory + delimiter + process.env.PATH);
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'fixture-schedule');
    vi.stubEnv('CIVICSIGNAL_SNAPSHOT_R2_READ_TOKEN', 'fixture-r2');
    expect((await readSnapshotCfBytes(['workflows', 'get', worker], undefined, { profile: 'fixture-meta' })).toString())
      .toBe(`unset|unset|workflows get ${worker} --profile fixture-meta`);
    const args = ['r2', 'objects', 'get', 'qualifications/window/' + 'a'.repeat(64) + '/diagnostics/failed.json',
      '--bucket-name', 'civicsignal-v1-stage-corpus-20261022'];
    expect((await readSnapshotCfBytes(args, undefined, { r2ReadToken: 'fixture-r2' })).toString()).toBe('fixture-r2|unset|' + args.join(' '));
    await expect(readSnapshotCfBytes([...args.slice(0, 3), 'canonical.json', ...args.slice(4)], undefined, { r2ReadToken: 'fixture-r2' }))
      .rejects.toThrow('SNAPSHOT_HOSTED_CF_R2_SCOPE');
  });
});
