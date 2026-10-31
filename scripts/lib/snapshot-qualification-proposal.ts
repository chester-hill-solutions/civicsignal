/** Offline proposal only: no credential selector, provider client or execution command. */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import { qualificationIdentity, QUALIFICATION_STAGE_ID, SOURCE_PHASES } from '../../services/snapshot/qualification';
import { QUALIFICATION_RECEIPT_BYTES } from '../../services/snapshot/qualification-store';
import { PARTITIONS, stagingPrefix } from '../../services/snapshot/builder';
import { parseManifest, SNAPSHOT_PARSER_VERSION } from '../../src/ingest/snapshot-format';
import { STAGING_ACCOUNT, STAGING_SOURCE, stagingNames } from './staging-config';

const integer = z.number().int().nonnegative().safe(), positive = integer.min(1), digest = z.string().regex(/^[a-f0-9]{64}$/);
const pinSchema = z.object({ path: z.string().min(1), bytes: positive.max(16 * 1024 * 1024), sha256: digest }).strict();
type FilePin = z.infer<typeof pinSchema>;
const revisionSchema = z.object({ commit: z.literal(STAGING_SOURCE.commit), date: z.literal(STAGING_SOURCE.date) }).strict();
/** maxResponseBytes is an aggregate response-body allowance for the entire
 * named class, never a per-response cap. A later operator still needs its own
 * per-exchange bounds and enforcement. wallMs is that class's proposed window. */
const operationSchema = z.object({ maxOperations: positive, maxResponseBytes: positive, wallMs: positive.max(2_147_483_647) }).strict();
export type ProposedSnapshotOperationAllowance = z.infer<typeof operationSchema>;
const operatorSchema = z.object({ managementPreflight: operationSchema, deployment: operationSchema,
  postDeployVerification: operationSchema, arming: operationSchema, workflowPolling: operationSchema,
  canonicalPreservation: operationSchema, artifactVerification: operationSchema,
  cleanupPrimary: operationSchema, cleanupBackup: operationSchema, cleanupFinalObservation: operationSchema }).strict();
const r2Operations = z.object({ put: integer, get: integer, head: integer, list: integer, batchDelete: integer, total: positive }).strict();
const budgetSchema = z.object({ format: z.literal(1),
  sourceSends: z.object({ discovery: z.literal(1), authoritative: z.literal(1), archive: z.literal(1) }).strict(),
  operator: operatorSchema,
  r2: z.object({ successfulPass: r2Operations, additional: z.object({ retries: operationSchema, collisions: operationSchema,
    duplicates: operationSchema, failureBranches: operationSchema, extraCleanup: operationSchema }).strict() }).strict(),
  verification: z.object({ artifacts: positive, artifactBytes: positive, rows: positive }).strict(),
  storage: z.object({ intermediateObjects: positive, intermediateBytes: positive, finalObjects: positive, finalBytes: positive,
    combinedObjects: positive, combinedBytes: positive, diagnosticObjects: positive, diagnosticBytes: positive,
    metadataAccountingBytes: positive, localDownloadBytes: positive }).strict(),
  time: z.object({ operationMs: positive.max(2_147_483_647), requestMs: positive, cleanupMs: positive, observationMs: positive }).strict(),
}).strict();
const resourceSchema = z.object({ format: z.literal(1), evidenceClass: z.enum(['retained-observation', 'synthetic-fixture']),
  observedAt: z.string().datetime(), accountId: z.literal(STAGING_ACCOUNT), worker: z.literal(QUALIFICATION_STAGE_ID),
  workflow: z.literal(QUALIFICATION_STAGE_ID), r2Bucket: z.literal(stagingNames('20261022').corpus), versionId: z.string().uuid() }).strict();
const inputSchema = z.object({ format: z.literal(1), qualificationId: z.string(), scheduledAt: z.string(),
  expectedNamespace: z.string(), expectedInstanceId: z.string(), source: revisionSchema, parser: z.literal(SNAPSHOT_PARSER_VERSION),
  candidate: z.object({ entrypoint: z.literal('services/snapshot/qualification-worker.ts'),
    sourceFiles: z.array(pinSchema).min(1).max(1024), bundle: pinSchema, config: pinSchema }).strict(),
  resourceEvidence: pinSchema, accounting: pinSchema, referenceManifest: pinSchema, stagingReceipt: pinSchema, budget: pinSchema }).strict();
const metadataSchema = z.object({ bytes: positive, sha256: digest }).strict();
const receiptSchema = z.object({ files: positive, originalBytes: positive, entries: z.record(z.string(), metadataSchema) }).passthrough();
const accountingSchema = z.object({ format: z.literal(1), kind: z.literal('snapshot-reference-single-pass-accounting'),
  evidencePins: z.array(pinSchema).min(2).max(32), approvedExecutionCeiling: z.literal(false),
  capacityQualified: z.literal(false), executionPerformed: z.literal(false),
  logicalPayloads: z.object({ intermediate: z.object({ objects: positive, bytes: positive }),
    final: z.object({ objects: positive, bytes: positive, rowParts: positive }),
    combinedBeforeCleanup: z.object({ objects: positive, bytes: positive }) }),
  localMetadataSidecars: z.object({ files: positive, bytes: positive, separateR2Objects: z.literal(false) }),
  singleSuccessfulPassLogicalR2Operations: z.object({ combined: r2Operations }),
}).passthrough();
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function requireProposal(value: unknown, code: string): asserts value { if (!value) throw new Error(`SNAPSHOT_PROPOSAL_${code}`); }
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function sum(values: number[]): number { const n = values.reduce((a, b) => a + b, 0); requireProposal(Number.isSafeInteger(n), 'COUNT_OVERFLOW'); return n; }
async function boundedBytes(file: FileHandle, maximum: number): Promise<Buffer> {
  const buffer = Buffer.alloc(maximum + 1); let used = 0;
  for (;;) {
    const result = await file.read(buffer, used, buffer.length - used, null);
    used += result.bytesRead;
    requireProposal(used <= maximum, 'INPUT_SIZE');
    if (!result.bytesRead) return buffer.subarray(0, used);
  }
}

/** Public package sources may share a cache inode. Their admitted bytes must
 * still match the pin and remain stable through the same descriptor read.
 * Private operator inputs require exclusive inodes and private permissions. */
export async function readSnapshotProposalPinnedFile(pin: FilePin, privacy: 'public' | 'private'): Promise<Buffer> {
  const privateFile = privacy === 'private';
  requireProposal(isAbsolute(pin.path) && resolve(pin.path) === pin.path && await realpath(pin.path) === pin.path, 'CANONICAL_INPUT_REQUIRED');
  const file = await open(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    requireProposal(before.isFile() && before.nlink >= 1n && Number(before.size) === pin.bytes && before.uid === BigInt(process.getuid?.() ?? -1) &&
      (!privateFile || (before.nlink === 1n && (before.mode & 0o077n) === 0n)), 'INPUT_METADATA');
    const bytes = await boundedBytes(file, pin.bytes), after = await file.stat({ bigint: true });
    requireProposal(bytes.length === pin.bytes && hash(bytes) === pin.sha256 && before.dev === after.dev && before.ino === after.ino &&
      before.size === after.size && before.nlink === after.nlink && before.uid === after.uid && before.mode === after.mode &&
      before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, 'INPUT_DRIFT');
    return bytes;
  } finally { await file.close(); }
}
const pinned = readSnapshotProposalPinnedFile;
async function filePin(path: string): Promise<FilePin> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    requireProposal(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= 16n * 1024n * 1024n, 'PIN_REQUIRED');
    const bytes = await boundedBytes(file, Number(before.size)), after = await file.stat({ bigint: true });
    requireProposal(before.size === BigInt(bytes.length) && before.dev === after.dev && before.ino === after.ino &&
      before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, 'INPUT_DRIFT');
    return { path, bytes: bytes.length, sha256: hash(bytes) };
  } finally { await file.close(); }
}
function json(bytes: Uint8Array): unknown { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }

async function referenceAccounting(root: string, input: z.infer<typeof inputSchema>) {
  requireProposal(input.accounting.path === join(root, 'docs/evidence/2026-10-31/snapshot-reference-accounting.json'), 'ACCOUNTING_REFERENCE');
  const accountingBytes = await pinned(input.accounting, 'public');
  const accounting = accountingSchema.parse(json(accountingBytes));
  for (const expected of [input.referenceManifest, input.stagingReceipt]) requireProposal(accounting.evidencePins.some(pin =>
    resolve(root, pin.path) === expected.path && pin.bytes === expected.bytes && pin.sha256 === expected.sha256), 'REFERENCE_LINEAGE');
  const [manifestBytes, receiptBytes] = await Promise.all([pinned(input.referenceManifest, 'public'), pinned(input.stagingReceipt, 'public')]);
  for (const pin of accounting.evidencePins) {
    requireProposal(!isAbsolute(pin.path) && !pin.path.split('/').some(part => part === '..'), 'ACCOUNTING_PIN_PATH');
    await pinned({ ...pin, path: resolve(root, pin.path) }, 'public');
  }
  const manifest = parseManifest(manifestBytes.toString('utf8'));
  requireProposal(manifest.commit === input.source.commit && manifest.date === input.source.date && manifest.parser === input.parser, 'REFERENCE_REVISION');
  const receipt = receiptSchema.parse(json(receiptBytes)), entries = Object.entries(receipt.entries);
  requireProposal(entries.length === receipt.files && sum(entries.map(([, value]) => value.bytes)) === receipt.originalBytes, 'ARCHIVE_INVENTORY');
  const metadata = entries.filter(([key]) => key.endsWith('.metadata.json'));
  const payload = entries.filter(([key]) => !key.endsWith('.metadata.json'));
  const prefix = stagingPrefix(input.source.commit);
  let groups = 0, fragments = 0, partitions = 0;
  for (const [key] of payload) {
    requireProposal(key.startsWith(prefix) && receipt.entries[key + '.metadata.json'] && !key.split('/').some(part => part === '..'), 'INTERMEDIATE_KEY');
    const name = key.slice(prefix.length);
    if (/^group-\d+\.(jsonl|xml)$/.test(name)) groups++;
    else if (PARTITIONS.some(partition => name.startsWith(`index-${partition}-`) && /^\d+\.jsonl$/.test(name.slice(`index-${partition}-`.length)))) fragments++;
    else if (PARTITIONS.some(partition => name === `sorted-${partition}.jsonl`)) partitions++;
    else requireProposal(false, 'UNKNOWN_INTERMEDIATE');
  }
  requireProposal(metadata.length === payload.length && metadata.every(([key]) => receipt.entries[key.slice(0, -'.metadata.json'.length)]) && partitions === PARTITIONS.length, 'METADATA_PAIRING');
  const intermediateBytes = sum(payload.map(([, value]) => value.bytes));
  const finalObjects = manifest.rows.parts.length + 2, finalBytes = sum([manifest.rows.bytes, manifest.index.bytes, manifestBytes.length]);
  // Every builder payload uses immutablePut's customMetadata {sha256:digest}.
  // Count only its known UTF-8 key/value data. Local JSON sidecars and unknown
  // provider storage/billing overhead are different quantities.
  const knownCustomMetadataObjects = payload.length + finalObjects;
  const knownCustomMetadataKeyValueBytes = knownCustomMetadataObjects *
    (Buffer.byteLength('sha256', 'utf8') + Buffer.byteLength(digest.parse(manifest.index.sha256), 'utf8'));
  const successfulPass = { put: groups + manifest.rows.parts.length + fragments + partitions + 2 + 7,
    get: groups + fragments + partitions + 11, head: manifest.rows.parts.length + 1,
    list: Math.ceil(payload.length / 500) + 1, batchDelete: Math.ceil(payload.length / 500), total: 0 };
  successfulPass.total = sum(Object.values(successfulPass));
  requireProposal(equal(accounting.logicalPayloads.intermediate, { objects: payload.length, bytes: intermediateBytes }) &&
    equal(accounting.logicalPayloads.final, { objects: finalObjects, bytes: finalBytes, rowParts: manifest.rows.parts.length }) &&
    equal(accounting.logicalPayloads.combinedBeforeCleanup, { objects: payload.length + finalObjects, bytes: intermediateBytes + finalBytes }) &&
    accounting.localMetadataSidecars.files === metadata.length && accounting.localMetadataSidecars.bytes === sum(metadata.map(([, value]) => value.bytes)) &&
    equal(accounting.singleSuccessfulPassLogicalR2Operations.combined, successfulPass), 'ACCOUNTING_DRIFT');
  return { groups, fragments, partitions, rows: manifest.rows.count, intermediateObjects: payload.length, intermediateBytes,
    finalObjects, finalBytes, localArchiveFiles: receipt.files, localArchiveBytes: receipt.originalBytes,
    localMetadataFiles: metadata.length, localMetadataBytes: accounting.localMetadataSidecars.bytes,
    knownCustomMetadataObjects, knownCustomMetadataKeyValueBytes,
    successfulPass, successfulPassOperations: successfulPass.total };
}

export async function inspectSnapshotQualificationProposal(options: { root: string; input: unknown; nowMs: number }) {
  const root = resolve(options.root), input = inputSchema.parse(options.input), at = Date.parse(input.scheduledAt);
  requireProposal(Number.isSafeInteger(options.nowMs) && Number.isSafeInteger(at) && at > options.nowMs && at % 60000 === 0 &&
    new Date(at).toISOString() === input.scheduledAt, 'FUTURE_UTC_EVENT');
  const date = new Date(at), controls = { SNAPSHOT_STAGE_ID: QUALIFICATION_STAGE_ID,
    SNAPSHOT_PINNED_COMMIT: input.source.commit, SNAPSHOT_PINNED_DATE: input.source.date,
    SNAPSHOT_QUALIFICATION_ID: input.qualificationId, SNAPSHOT_QUALIFICATION_TIME: String(at),
    SNAPSHOT_QUALIFICATION_CRON: `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth() + 1} *` };
  const qualification = await qualificationIdentity(controls);
  requireProposal(qualification.prefix === input.expectedNamespace && qualification.instanceId === input.expectedInstanceId, 'QUALIFICATION_IDENTITY');
  const [bundleBytes, configBytes, resourceBytes, budgetBytes] = await Promise.all([
    pinned(input.candidate.bundle, 'private'), pinned(input.candidate.config, 'private'), pinned(input.resourceEvidence, 'private'), pinned(input.budget, 'private'),
  ]);
  const resources = resourceSchema.parse(json(resourceBytes));
  requireProposal(Date.parse(resources.observedAt) <= options.nowMs, 'RESOURCE_OBSERVATION_TIME');
  const sourceConfigPath = join(root, 'services/snapshot/wrangler.jsonc'), sourceConfigPin = await filePin(sourceConfigPath);
  const sourceConfig = ts.parseConfigFileTextToJson(sourceConfigPath, (await pinned(sourceConfigPin, 'public')).toString('utf8'));
  requireProposal(!sourceConfig.error, 'RUNTIME_CONFIG');
  const source = sourceConfig.config as { compatibility_date?: unknown; compatibility_flags?: unknown; limits?: unknown; observability?: unknown };
  const expectedConfig = { name: resources.worker, account_id: resources.accountId, main: input.candidate.bundle.path,
    compatibility_date: source.compatibility_date, compatibility_flags: source.compatibility_flags,
    observability: source.observability, limits: source.limits, routes: [], triggers: { crons: [] },
    workers_dev: false, r2_buckets: [{ binding: 'CORPUS', bucket_name: resources.r2Bucket }],
    workflows: [{ binding: 'SNAPSHOT', name: resources.workflow, class_name: 'CorpusSnapshot' }], vars: controls };
  const config = json(configBytes);
  // Key order is not contractual. Unknown keys, secrets and extra bindings are
  // rejected rather than copied into the prepared output.
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, part) => part && typeof part === 'object' && !Array.isArray(part)
    ? Object.fromEntries(Object.keys(part).sort().map(key => [key, part[key]])) : part);
  requireProposal(canonical(config) === canonical(expectedConfig), 'CONFIG_OR_RUNTIME_DRIFT');
  const bundled = await build({ entryPoints: [join(root, input.candidate.entrypoint)], absWorkingDir: root,
    bundle: true, write: false, metafile: true, format: 'esm', platform: 'browser', target: 'es2022',
    external: ['cloudflare:*', 'node:*'], legalComments: 'none', logLevel: 'silent', tsconfigRaw: {} });
  requireProposal(Buffer.from(bundled.outputFiles[0]!.contents).equals(bundleBytes), 'BUNDLE_CORRESPONDENCE');
  const expectedSources = Object.keys(bundled.metafile!.inputs).map(path => resolve(root, path)).sort();
  requireProposal(equal(input.candidate.sourceFiles.map(pin => pin.path).sort(), expectedSources), 'COMPLETE_SOURCE_MANIFEST');
  for (const pin of input.candidate.sourceFiles) await pinned(pin, 'public');
  const reference = await referenceAccounting(root, input), budget = budgetSchema.parse(json(budgetBytes));
  for (const name of ['put', 'get', 'head', 'list', 'batchDelete', 'total'] as const) requireProposal(budget.r2.successfulPass[name] >= reference.successfulPass[name], 'R2_BASELINE_UNDERCOUNT');
  requireProposal(budget.r2.successfulPass.total >= sum(Object.entries(budget.r2.successfulPass).filter(([key]) => key !== 'total').map(([, value]) => value)), 'R2_TOTAL_UNDERCOUNT');
  for (const [name, minimum] of Object.entries({ intermediateObjects: reference.intermediateObjects, intermediateBytes: reference.intermediateBytes,
    finalObjects: reference.finalObjects, finalBytes: reference.finalBytes, combinedObjects: reference.intermediateObjects + reference.finalObjects,
    combinedBytes: reference.intermediateBytes + reference.finalBytes, diagnosticObjects: 10, diagnosticBytes: 10 * QUALIFICATION_RECEIPT_BYTES,
    metadataAccountingBytes: reference.knownCustomMetadataKeyValueBytes,
    localDownloadBytes: reference.finalBytes })) requireProposal(budget.storage[name as keyof typeof budget.storage] >= minimum, 'STORAGE_UNDERCOUNT');
  requireProposal(budget.storage.combinedObjects >= sum([budget.storage.intermediateObjects, budget.storage.finalObjects]) &&
    budget.storage.combinedBytes >= sum([budget.storage.intermediateBytes, budget.storage.finalBytes]), 'STORAGE_COMPONENT_UNDERCOUNT');
  requireProposal(budget.verification.artifacts >= reference.finalObjects && budget.verification.artifactBytes >= reference.finalBytes &&
    budget.verification.rows >= reference.rows && budget.operator.artifactVerification.maxOperations >= budget.verification.artifacts &&
    budget.operator.artifactVerification.maxResponseBytes >= budget.verification.artifactBytes && budget.operator.canonicalPreservation.maxOperations >= 2 &&
    budget.operator.arming.maxOperations >= 3 && budget.operator.cleanupPrimary.maxOperations >= 4 && budget.operator.cleanupBackup.maxOperations >= 4, 'VERIFICATION_OR_CONTROL_UNDERCOUNT');
  for (const value of [...Object.values(budget.operator), ...Object.values(budget.r2.additional)]) requireProposal(value.wallMs <= budget.time.operationMs, 'TIME_BUDGET');
  requireProposal(budget.time.requestMs <= budget.time.operationMs && budget.time.cleanupMs <= budget.time.operationMs &&
    budget.time.observationMs <= budget.time.operationMs && Object.keys(budget.sourceSends).length === SOURCE_PHASES.length, 'TIME_OR_SOURCE_BUDGET');
  const proposal = { format: 1, kind: 'snapshot-qualification-prepared-proposal', preparedOnly: true, executionApproved: false,
    executionReady: false, networkRequests: 0, credentialBytesRead: 0, preparedAt: new Date(options.nowMs).toISOString(),
    resourceEvidenceClass: resources.evidenceClass, resourceAuthenticityVerified: false, freshRemoteStateVerified: false,
    namespaceAbsenceVerified: false, instanceAbsenceVerified: false, qualification, resources, candidate: input.candidate,
    pins: { resourceEvidence: input.resourceEvidence, accounting: input.accounting, referenceManifest: input.referenceManifest,
      stagingReceipt: input.stagingReceipt, budget: input.budget, sourceRuntimeConfig: sourceConfigPin }, reference,
    declaredBudget: budget, budgetUnits: { maxOperations: 'aggregate-logical-operations-per-class',
      maxResponseBytes: 'aggregate-response-body-bytes-per-class', wallMs: 'proposed-wall-window-per-class',
      combinedStorage: 'intermediate-and-final-payloads; diagnostics-and-metadata-listed-separately',
      metadataAccountingBytes: 'allowance-including-known-custom-metadata-key-value-bytes; provider-overhead-unqualified' },
    providerMetadataAccountingQualified: false,
    declaredBudgetsRuntimeEnforced: false, approvedExecutionCeiling: false, capacityQualified: false,
    originalServingLedgerChanged: false, originalEmbeddingAllowanceChanged: false,
    remainingDependencies: ['fresh-provider-identity-and-absence-evidence', 'owned-operator-and-enforced-total-budgets',
      'r2-retry-duplicate-and-reconstruction-accounting', 'credential-lifetime-and-independent-cleanup-guards',
      'full-qualified-artifact-verification-and-canonical-preservation', 'separate-concrete-execution-approval'],
    limitation: 'Declared proposed allowances are not runtime-enforced aggregate limits. The successful-pass reference excludes retries, collisions, duplicates, failure branches, extra cleanup and operator/verification work.' };
  return { proposal, config: expectedConfig, bundleBytes, input };
}

async function privateDirectory(path: string) {
  requireProposal(isAbsolute(path) && resolve(path) === path && await realpath(path) === path, 'PRIVATE_PARENT_REQUIRED');
  const info = await lstat(path);
  requireProposal(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0, 'PRIVATE_PARENT_REQUIRED');
}
async function exclusive(path: string, bytes: Uint8Array | string) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function syncDirectory(path: string) { const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }

export async function prepareSnapshotQualificationProposal(options: { root: string; inputFile: string; outputDirectory: string; nowMs: number }) {
  await privateDirectory(dirname(options.inputFile)); await privateDirectory(dirname(options.outputDirectory));
  requireProposal(isAbsolute(options.outputDirectory) && resolve(options.outputDirectory) === options.outputDirectory, 'CANONICAL_OUTPUT_REQUIRED');
  const inputPin = await filePin(options.inputFile), inputBytes = await pinned(inputPin, 'private');
  const checked = await inspectSnapshotQualificationProposal({ root: options.root, input: json(inputBytes), nowMs: options.nowMs });
  // Complete admission before claiming a new directory. Existing packets cannot
  // be updated, even when all their files would otherwise match.
  await pinned(inputPin, 'private');
  for (const pin of [...checked.input.candidate.sourceFiles, checked.input.accounting,
    checked.input.referenceManifest, checked.input.stagingReceipt]) await pinned(pin, 'public');
  for (const pin of [checked.input.candidate.bundle, checked.input.candidate.config,
    checked.input.resourceEvidence, checked.input.budget]) await pinned(pin, 'private');
  await mkdir(options.outputDirectory, { mode: 0o700 });
  let complete = false;
  try {
    await exclusive(join(options.outputDirectory, 'candidate.mjs'), checked.bundleBytes);
    const config = { ...checked.config, main: join(options.outputDirectory, 'candidate.mjs') };
    const configBytes = JSON.stringify(config, null, 2) + '\n';
    await exclusive(join(options.outputDirectory, 'prepared-config.json'), configBytes);
    const proposal = { ...checked.proposal, inputPin,
      preparedFiles: { bundle: { path: join(options.outputDirectory, 'candidate.mjs'), bytes: checked.bundleBytes.length, sha256: hash(checked.bundleBytes) },
        config: { path: join(options.outputDirectory, 'prepared-config.json'), bytes: Buffer.byteLength(configBytes), sha256: hash(configBytes) } } };
    await exclusive(join(options.outputDirectory, 'proposal.json'), JSON.stringify(proposal, null, 2) + '\n');
    await syncDirectory(options.outputDirectory); await syncDirectory(dirname(options.outputDirectory));
    complete = true;
    return proposal;
  } finally {
    // Retain failed preparation artifacts, but never a successful proposal
    // marker after failed persistence. No automatic retry or output reuse.
    if (!complete) await unlink(join(options.outputDirectory, 'proposal.json')).catch(() => {});
  }
}
