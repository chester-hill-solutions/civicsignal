import { afterEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { qualificationIdentity, QUALIFICATION_STAGE_ID } from '../services/snapshot/qualification';
import { STAGING_ACCOUNT, STAGING_SOURCE, stagingNames } from '../scripts/lib/staging-config';
import { SNAPSHOT_PARSER_VERSION } from '../src/ingest/snapshot-format';
import { prepareSnapshotQualificationProposal, inspectSnapshotQualificationProposal } from '../scripts/lib/snapshot-qualification-proposal';
import { snapshotQualificationProposalMain } from '../scripts/prepare-snapshot-qualification';

const faults = vi.hoisted(() => ({ proposalSync: false }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, async open(...args: Parameters<typeof actual.open>) {
    const file = await actual.open(...args);
    if (faults.proposalSync && String(args[0]).endsWith('/proposal.json')) vi.spyOn(file, 'sync').mockRejectedValue(new Error('Injected persistence failure'));
    return file;
  } };
});

const ROOT = resolve('.'), NOW = Date.parse('2030-01-01T00:00:00.000Z'), EVENT = '2030-01-01T01:00:00.000Z';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); faults.proposalSync = false; vi.restoreAllMocks(); });
async function pin(path: string) { const bytes = await readFile(path); return { path, bytes: bytes.length, sha256: sha(bytes) }; }
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'snapshot-proposal-'))); cleanup.push(directory); await chmod(directory, 0o700);
  const bundled = await build({ entryPoints: [join(ROOT, 'services/snapshot/qualification-worker.ts')], absWorkingDir: ROOT,
    bundle: true, write: false, metafile: true, format: 'esm', platform: 'browser', target: 'es2022',
    external: ['cloudflare:*', 'node:*'], legalComments: 'none', logLevel: 'silent', tsconfigRaw: {} });
  const bundleFile = join(directory, 'candidate.mjs'); await writeFile(bundleFile, bundled.outputFiles[0]!.contents, { mode: 0o600 });
  const sourceFiles = await Promise.all(Object.keys(bundled.metafile!.inputs).sort().map(path => pin(resolve(ROOT, path))));
  const accountingFile = join(ROOT, 'docs/evidence/2026-10-31/snapshot-reference-accounting.json');
  const accounting = JSON.parse(await readFile(accountingFile, 'utf8'));
  const manifestFile = join(ROOT, accounting.evidencePins[1].path), stagingReceiptFile = join(ROOT, accounting.evidencePins[0].path);
  const resourceFile = join(directory, 'resources.json');
  const resources = { format: 1, evidenceClass: 'synthetic-fixture', observedAt: '2029-12-31T23:00:00.000Z',
    accountId: STAGING_ACCOUNT, worker: QUALIFICATION_STAGE_ID, workflow: QUALIFICATION_STAGE_ID,
    r2Bucket: stagingNames('20261022').corpus, versionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  await writeFile(resourceFile, JSON.stringify(resources), { mode: 0o600 });
  const vars = { SNAPSHOT_STAGE_ID: QUALIFICATION_STAGE_ID, SNAPSHOT_PINNED_COMMIT: STAGING_SOURCE.commit,
    SNAPSHOT_PINNED_DATE: STAGING_SOURCE.date, SNAPSHOT_QUALIFICATION_ID: 'synthetic-proposal',
    SNAPSHOT_QUALIFICATION_TIME: String(Date.parse(EVENT)), SNAPSHOT_QUALIFICATION_CRON: '0 1 1 1 *' };
  const q = await qualificationIdentity(vars);
  const configFile = join(directory, 'candidate.json');
  const config = { name: QUALIFICATION_STAGE_ID, account_id: STAGING_ACCOUNT, main: bundleFile,
    compatibility_date: '2026-10-22', compatibility_flags: ['nodejs_compat'], observability: { enabled: true },
    limits: { cpu_ms: 300000, subrequests: 100000 }, routes: [], triggers: { crons: [] }, workers_dev: false,
    r2_buckets: [{ binding: 'CORPUS', bucket_name: resources.r2Bucket }],
    workflows: [{ binding: 'SNAPSHOT', name: resources.workflow, class_name: 'CorpusSnapshot' }], vars };
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const row = { maxOperations: 10000, maxResponseBytes: 2_000_000_000, wallMs: 7_200_000 };
  const budget = { format: 1, sourceSends: { discovery: 1, authoritative: 1, archive: 1 },
    operator: Object.fromEntries(['managementPreflight', 'deployment', 'postDeployVerification', 'arming', 'workflowPolling',
      'canonicalPreservation', 'artifactVerification', 'cleanupPrimary', 'cleanupBackup', 'cleanupFinalObservation'].map(name => [name, { ...row }])),
    r2: { successfulPass: { put: 490, get: 254, head: 239, list: 2, batchDelete: 1, total: 986 },
      additional: Object.fromEntries(['retries', 'collisions', 'duplicates', 'failureBranches', 'extraCleanup'].map(name => [name, { ...row }])) },
    verification: { artifacts: 240, artifactBytes: 390423509, rows: 277857 },
    storage: { intermediateObjects: 243, intermediateBytes: 762295433, finalObjects: 240, finalBytes: 390423509,
      combinedObjects: 483, combinedBytes: 1152718942, diagnosticObjects: 10, diagnosticBytes: 20480,
      metadataAccountingBytes: 100000, localDownloadBytes: 390423509 },
    time: { operationMs: 7_200_000, requestMs: 15000, cleanupMs: 60000, observationMs: 7_200_000 } };
  const budgetFile = join(directory, 'budget.json'); await writeFile(budgetFile, JSON.stringify(budget), { mode: 0o600 });
  const input = { format: 1, qualificationId: 'synthetic-proposal', scheduledAt: EVENT,
    expectedNamespace: q.prefix, expectedInstanceId: q.instanceId, source: STAGING_SOURCE, parser: SNAPSHOT_PARSER_VERSION,
    candidate: { entrypoint: 'services/snapshot/qualification-worker.ts', sourceFiles, bundle: await pin(bundleFile), config: await pin(configFile) },
    resourceEvidence: await pin(resourceFile), accounting: await pin(accountingFile), referenceManifest: await pin(manifestFile),
    stagingReceipt: await pin(stagingReceiptFile), budget: await pin(budgetFile) };
  const inputFile = join(directory, 'inputs.json'); await writeFile(inputFile, JSON.stringify(input), { mode: 0o600 });
  return { directory, input, inputFile, budget, budgetFile, config, configFile, resources, resourceFile,
    outputDirectory: join(directory, 'unapproved'), async save() { await writeFile(inputFile, JSON.stringify(input)); } };
}

describe('offline scheduled snapshot qualification proposal', () => {
  it('uses the real qualification identity and pinned accounting while remaining unapproved and unable to execute', async () => {
    const f = await fixture(), network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    const result = await prepareSnapshotQualificationProposal({ root: ROOT, inputFile: f.inputFile, outputDirectory: f.outputDirectory, nowMs: NOW });
    expect(result).toMatchObject({ preparedOnly: true, executionApproved: false, executionReady: false,
      networkRequests: 0, credentialBytesRead: 0, resourceEvidenceClass: 'synthetic-fixture',
      qualification: { prefix: f.input.expectedNamespace, instanceId: f.input.expectedInstanceId },
      reference: { intermediateObjects: 243, intermediateBytes: 762295433, localMetadataFiles: 243, localMetadataBytes: 18711,
        finalObjects: 240, finalBytes: 390423509, successfulPassOperations: 986 } });
    const config = JSON.parse(await readFile(join(f.outputDirectory, 'prepared-config.json'), 'utf8'));
    expect(config.triggers).toEqual({ crons: [] }); expect(config.vars).toEqual(f.config.vars);
    expect((await readdir(f.outputDirectory)).sort()).toEqual(['candidate.mjs', 'prepared-config.json', 'proposal.json']);
    expect(result.remainingDependencies).toContain('owned-operator-and-enforced-total-budgets');
    expect(network).not.toHaveBeenCalled();
  });
  it.each([
    ['past event', { scheduledAt: '2029-12-31T23:00:00.000Z' }],
    ['noncanonical event', { scheduledAt: '2030-01-01T01:00:00Z' }],
    ['wrong minute', { scheduledAt: '2030-01-01T01:00:01.000Z' }],
    ['namespace', { expectedNamespace: 'snapshots/statutes-v2/' }],
    ['instance', { expectedInstanceId: 'qual-' + '0'.repeat(64) }],
    ['qualification ID', { qualificationId: '../unsafe' }],
    ['source revision', { source: { ...STAGING_SOURCE, commit: 'f'.repeat(40) } }],
    ['parser', { parser: 'statutes-v3' }],
  ])('refuses %s drift before output', async (_name, changed) => {
    const f = await fixture();
    await expect(inspectSnapshotQualificationProposal({ root: ROOT, input: { ...f.input, ...changed }, nowMs: NOW })).rejects.toThrow();
    await expect(readdir(f.outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses incomplete or drifting source pins and a bundle that does not correspond to those sources', async () => {
    const f = await fixture();
    await expect(inspectSnapshotQualificationProposal({ root: ROOT, input: { ...f.input,
      candidate: { ...f.input.candidate, sourceFiles: f.input.candidate.sourceFiles.slice(1) } }, nowMs: NOW })).rejects.toThrow('SOURCE_MANIFEST');
    await expect(inspectSnapshotQualificationProposal({ root: ROOT, input: { ...f.input,
      candidate: { ...f.input.candidate, sourceFiles: [...f.input.candidate.sourceFiles, f.input.candidate.sourceFiles[0]!] } }, nowMs: NOW })).rejects.toThrow('SOURCE_MANIFEST');
    const changed = f.input.candidate.sourceFiles.map((value, at) => at ? value : { ...value, sha256: '0'.repeat(64) });
    await expect(inspectSnapshotQualificationProposal({ root: ROOT, input: { ...f.input,
      candidate: { ...f.input.candidate, sourceFiles: changed } }, nowMs: NOW })).rejects.toThrow('INPUT_DRIFT');
    const bytes = await readFile(f.input.candidate.bundle.path); bytes[0] ^= 1;
    await writeFile(f.input.candidate.bundle.path, bytes); f.input.candidate.bundle = await pin(f.input.candidate.bundle.path);
    await expect(inspectSnapshotQualificationProposal({ root: ROOT, input: f.input, nowMs: NOW })).rejects.toThrow('BUNDLE_CORRESPONDENCE');
  });
  it('refuses enabled schedules, runtime changes, secret bindings and production resources even when the caller updates their hashes', async () => {
    const f = await fixture(), inspect = () => inspectSnapshotQualificationProposal({ root: ROOT, input: f.input, nowMs: NOW });
    for (const changed of [{ triggers: { crons: ['0 1 1 1 *'] } }, { compatibility_date: '2020-01-01' },
      { vars: { ...f.config.vars, SECRET: 'private' } }, { d1_databases: [{ binding: 'EXTRA_DB', database_id: 'private-extra-binding' }] }]) {
      await writeFile(f.configFile, JSON.stringify({ ...f.config, ...changed })); f.input.candidate.config = await pin(f.configFile);
      await expect(inspect()).rejects.toThrow('CONFIG_OR_RUNTIME_DRIFT');
    }
    await writeFile(f.configFile, JSON.stringify(f.config)); f.input.candidate.config = await pin(f.configFile);
    await writeFile(f.resourceFile, JSON.stringify({ ...f.resources, r2Bucket: 'civicsignal-corpus' })); f.input.resourceEvidence = await pin(f.resourceFile);
    await expect(inspect()).rejects.toThrow();
  });
  it.each([
    ...['managementPreflight', 'deployment', 'postDeployVerification', 'arming', 'workflowPolling', 'canonicalPreservation',
      'artifactVerification', 'cleanupPrimary', 'cleanupBackup', 'cleanupFinalObservation'].map(name => ['operator', name]),
    ...['retries', 'collisions', 'duplicates', 'failureBranches', 'extraCleanup'].map(name => ['r2', name]),
  ])('requires explicit %s budget class %s', async (group, name) => {
    const f = await fixture();
    delete (group === 'operator' ? f.budget.operator : f.budget.r2.additional)[name!];
    await writeFile(f.budgetFile, JSON.stringify(f.budget)); f.input.budget = await pin(f.budgetFile); await f.save();
    await expect(prepareSnapshotQualificationProposal({ root: ROOT, inputFile: f.inputFile, outputDirectory: f.outputDirectory, nowMs: NOW })).rejects.toThrow();
    await expect(readdir(f.outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([
    ['verification', 'artifacts'], ['verification', 'artifactBytes'], ['verification', 'rows'],
    ['storage', 'intermediateObjects'], ['storage', 'intermediateBytes'], ['storage', 'finalObjects'], ['storage', 'finalBytes'],
    ['storage', 'combinedObjects'], ['storage', 'combinedBytes'], ['storage', 'diagnosticObjects'], ['storage', 'diagnosticBytes'], ['storage', 'localDownloadBytes'],
  ])('rejects an under-counted %s.%s allowance', async (group, field) => {
    const f = await fixture();
    const target: Record<string, number> = group === 'storage' ? f.budget.storage : f.budget.verification;
    target[field!]--;
    await writeFile(f.budgetFile, JSON.stringify(f.budget)); f.input.budget = await pin(f.budgetFile);
    await expect(inspectSnapshotQualificationProposal({ root: ROOT, input: f.input, nowMs: NOW })).rejects.toThrow(/UNDERCOUNT/);
  });
  it('rejects an under-counted successful pass and missing source phase without inventing retry caps', async () => {
    const f = await fixture(); f.budget.r2.successfulPass.total = 985;
    await writeFile(f.budgetFile, JSON.stringify(f.budget)); f.input.budget = await pin(f.budgetFile);
    await expect(inspectSnapshotQualificationProposal({ root: ROOT, input: f.input, nowMs: NOW })).rejects.toThrow('R2_BASELINE_UNDERCOUNT');
    f.budget.r2.successfulPass.total = 986;
    await writeFile(f.budgetFile, JSON.stringify({ ...f.budget, sourceSends: { discovery: 1, archive: 1 } })); f.input.budget = await pin(f.budgetFile);
    await expect(inspectSnapshotQualificationProposal({ root: ROOT, input: f.input, nowMs: NOW })).rejects.toThrow();
  });
  it.each(['objects', 'bytes'] as const)('rejects combined storage below its own declared %s components', async kind => {
    const f = await fixture();
    if (kind === 'objects') f.budget.storage.intermediateObjects++;
    else f.budget.storage.intermediateBytes++;
    await writeFile(f.budgetFile, JSON.stringify(f.budget)); f.input.budget = await pin(f.budgetFile);
    await expect(inspectSnapshotQualificationProposal({ root: ROOT, input: f.input, nowMs: NOW })).rejects.toThrow('STORAGE_COMPONENT_UNDERCOUNT');
  });
  it.each([1, 33809])('rejects metadata allowance %i below the known custom-metadata key/value bytes', async bytes => {
    const f = await fixture(); f.budget.storage.metadataAccountingBytes = bytes;
    await writeFile(f.budgetFile, JSON.stringify(f.budget)); f.input.budget = await pin(f.budgetFile);
    await expect(inspectSnapshotQualificationProposal({ root: ROOT, input: f.input, nowMs: NOW })).rejects.toThrow('STORAGE_UNDERCOUNT');
  });
  it('accepts the known custom-metadata floor while keeping local sidecars and provider overhead distinct', async () => {
    const f = await fixture(); f.budget.storage.metadataAccountingBytes = 33810;
    await writeFile(f.budgetFile, JSON.stringify(f.budget)); f.input.budget = await pin(f.budgetFile);
    const result = await inspectSnapshotQualificationProposal({ root: ROOT, input: f.input, nowMs: NOW });
    expect(result.proposal.reference).toMatchObject({ localMetadataFiles: 243, localMetadataBytes: 18711,
      knownCustomMetadataObjects: 483, knownCustomMetadataKeyValueBytes: 33810 });
    expect(result.proposal).toMatchObject({ providerMetadataAccountingQualified: false, capacityQualified: false,
      declaredBudgetsRuntimeEnforced: false, executionReady: false });
    expect(result.proposal.budgetUnits.metadataAccountingBytes).toContain('provider-overhead-unqualified');
  });
  it('keeps provided allowances distinct from runtime enforcement and fresh provider evidence', async () => {
    const f = await fixture(), result = await inspectSnapshotQualificationProposal({ root: ROOT, input: f.input, nowMs: NOW });
    expect(result.proposal).toMatchObject({ declaredBudgetsRuntimeEnforced: false, approvedExecutionCeiling: false,
      capacityQualified: false, freshRemoteStateVerified: false, namespaceAbsenceVerified: false, instanceAbsenceVerified: false,
      originalServingLedgerChanged: false, originalEmbeddingAllowanceChanged: false });
    expect(result.proposal.remainingDependencies).toContain('r2-retry-duplicate-and-reconstruction-accounting');
  });
  it('refuses an existing output packet without replacing its files', async () => {
    const f = await fixture(), options = { root: ROOT, inputFile: f.inputFile, outputDirectory: f.outputDirectory, nowMs: NOW };
    await prepareSnapshotQualificationProposal(options); const before = await readFile(join(f.outputDirectory, 'proposal.json'));
    await expect(prepareSnapshotQualificationProposal(options)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(f.outputDirectory, 'proposal.json'))).toEqual(before);
  });
  it('leaves no successful proposal marker after a final persistence failure and refuses reuse', async () => {
    const f = await fixture(); faults.proposalSync = true;
    const options = { root: ROOT, inputFile: f.inputFile, outputDirectory: f.outputDirectory, nowMs: NOW };
    await expect(prepareSnapshotQualificationProposal(options)).rejects.toThrow('Injected persistence failure');
    expect(await readdir(f.outputDirectory)).not.toContain('proposal.json');
    faults.proposalSync = false;
    await expect(prepareSnapshotQualificationProposal(options)).rejects.toMatchObject({ code: 'EEXIST' });
  });
  it('exposes no execute, credential, deploy or calendar CLI mode', async () => {
    for (const flag of ['--execute', '--credential', '--deploy', '--arm', '--event', '--reset']) {
      await expect(snapshotQualificationProposalMain([flag, 'ignored', '--out', 'ignored'], NOW)).rejects.toThrow('ARGUMENTS');
    }
  });
});
