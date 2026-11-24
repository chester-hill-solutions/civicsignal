#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { SourceHeadSend } from '../src/ingest/source-head';
import { FRESH_SNAPSHOT_STAGE_ID, SNAPSHOT_CALENDAR_REQUEST_MS, snapshotCalendar } from './lib/snapshot-calendar';
import { writeSnapshotWindowReceipt } from './lib/snapshot-calendar-window';
import { readSnapshotCfBytes } from './lib/snapshot-hosted-admission';
import { createSnapshotCfAdmissionReader, createSnapshotCfOutcomeReader } from './lib/snapshot-publication-cf';
import { runStagedSnapshotPublication } from './lib/snapshot-publication-window';
import { readSnapshotProposalPinnedFile } from './lib/snapshot-qualification-proposal';
import { snapshotScheduleTokens } from './lib/snapshot-schedule-credentials';
import { loadStagedPublication, stagedPublicationPins, stagedSnapshotArtifactSource } from './verify-staged-snapshot';

const maxFileBytes = 64 * 1024;
const duration = z.number().int().positive().max(2_147_483_647);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ precision: 3 });
const specSchema = z.object({
  format: z.literal(1),
  worker: z.literal(FRESH_SNAPSHOT_STAGE_ID),
  review: z.object({ id: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/), execute: z.literal(true), validUntil: instant }).strict(),
  packet: z.object({ path: z.string().min(1), bytes: duration.max(maxFileBytes), sha256: sha }).strict(),
  deployment: z.object({ deploymentId: z.uuid(), versionId: z.uuid(), workflowId: z.uuid(), configSha256: sha }).strict(),
  cfMetadataProfile: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  journal: z.string().min(1),
  credentialExpiries: z.object({ operator: instant, primary: instant, backup: instant }).strict(),
  evidence: z.object({ admissionMs: duration, observationMs: duration, maxInstanceReads: duration, pollIntervalMs: duration }).strict(),
}).strict();

const versionSchema = z.object({ id: z.uuid(), urls: z.tuple([]), main_module: z.literal('candidate.mjs'),
  compatibility_date: z.literal('2026-10-22'), compatibility_flags: z.tuple([z.literal('nodejs_compat')]),
  limits: z.object({ cpu_ms: z.literal(300_000), subrequests: z.literal(100_000) }),
  modules: z.tuple([z.object({ name: z.literal('candidate.mjs'), content_type: z.literal('application/javascript+module'),
    content_base64: z.string().min(1) })]),
  bindings: z.array(z.object({ name: z.string(), type: z.string(), text: z.string().optional(),
    bucket_name: z.string().optional(), jurisdiction: z.string().optional(), workflow_name: z.string().optional(),
    script_name: z.string().optional(), class_name: z.string().optional() })).length(9),
});
const cfVersion = z.union([versionSchema, z.object({ success: z.literal(true), result: versionSchema }).transform(value => value.result)]);

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type RunSpec = z.infer<typeof specSchema>;
type Packet = Awaited<ReturnType<typeof loadStagedPublication>>;
type CfReader = typeof readSnapshotCfBytes;

function requireRun(value: unknown, fact: string): asserts value {
  if (!value) throw new Error(`SNAPSHOT_PUBLICATION_RUN_${fact}`);
}

async function readReviewedSpec(path: string) {
  requireRun(isAbsolute(path) && resolve(path) === path && await realpath(path) === path, 'SPEC_PATH');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    requireRun(before.isFile() && before.nlink === 1n && before.uid === BigInt(process.getuid?.() ?? -1) &&
      (before.mode & 0o077n) === 0n && before.size > 0n && before.size <= BigInt(maxFileBytes), 'SPEC_FILE');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    requireRun(used === Number(before.size) &&
      (['dev', 'ino', 'size', 'nlink', 'uid', 'mode', 'mtimeNs', 'ctimeNs'] as const).every(field => before[field] === after[field]), 'SPEC_DRIFT');
    const bytes = buffer.subarray(0, used);
    const parsed = specSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    requireRun(parsed.success, 'SPEC');
    return { spec: parsed.data, reviewSpecSha256: digest(bytes) };
  } finally { await file.close(); }
}

function bindPacket(spec: RunSpec, packet: Packet) {
  const { clearAt, cleanupDeadline, scheduledAt } = packet.publication.window;
  requireRun(packet.configSha256 === spec.deployment.configSha256 && clearAt && cleanupDeadline, 'PACKET');
  const deadline = Date.parse(cleanupDeadline);
  const scheduled = Date.parse(scheduledAt), clear = Date.parse(clearAt);
  requireRun(Date.now() < scheduled && scheduled <= clear && clear < deadline &&
    deadline < Date.parse(packet.publication.runtimeDeadline), 'WINDOW');
  requireRun(Object.values(spec.credentialExpiries).every(value =>
    Date.parse(value) > deadline + SNAPSHOT_CALENDAR_REQUEST_MS), 'EXPIRY');
  const finalEvidenceLimit = deadline + SNAPSHOT_CALENDAR_REQUEST_MS + spec.evidence.observationMs + stagedPublicationPins.artifactBudget.wallMs;
  requireRun(Date.parse(spec.review.validUntil) > finalEvidenceLimit, 'REVIEW_EXPIRY');
}

async function verifyPreparedConfig(spec: RunSpec) {
  const configPath = join(dirname(spec.packet.path), '.cloudflare/output/v0/workers/default/worker.config.json');
  const { size } = await lstat(configPath);
  requireRun(size > 0 && size <= maxFileBytes, 'PREPARED_CONFIG');
  await readSnapshotProposalPinnedFile({ path: configPath, bytes: size, sha256: spec.deployment.configSha256 }, 'private');
}

export async function verifyPublicationVersion(spec: RunSpec, packet: Packet, read: CfReader, signal: AbortSignal) {
  const versionId = spec.deployment.versionId;
  const bytes = await read(['workers', 'versions', 'get', versionId, '--worker-id', FRESH_SNAPSHOT_STAGE_ID, '--include', 'modules'],
    signal, { profile: spec.cfMetadataProfile, versionModules: true });
  const version = cfVersion.safeParse(JSON.parse(bytes.toString('utf8')));
  requireRun(version.success && version.data.id === versionId, 'VERSION');
  const module = Buffer.from(version.data.modules[0].content_base64, 'base64');
  requireRun(module.length === packet.bundle.bytes && digest(module) === packet.bundle.sha256, 'MODULE');

  const { qualification: { identity }, bucket } = packet.publication;
  const { revision, event, id, runtimeDeadline } = identity;
  const expected = {
    SNAPSHOT_STAGE_ID: identity.stageId,
    SNAPSHOT_PINNED_COMMIT: revision.commit,
    SNAPSHOT_PINNED_DATE: revision.date,
    SNAPSHOT_QUALIFICATION_ID: id,
    SNAPSHOT_QUALIFICATION_CRON: event.cron,
    SNAPSHOT_QUALIFICATION_TIME: String(event.scheduledTime),
    SNAPSHOT_QUALIFICATION_DEADLINE: String(runtimeDeadline),
  };
  const bindings = new Map(version.data.bindings.map(binding => [binding.name, binding]));
  const r2 = bindings.get('CORPUS'), workflow = bindings.get('SNAPSHOT');
  requireRun(r2?.type === 'r2_bucket' && r2.bucket_name === bucket && r2.jurisdiction === undefined &&
    workflow?.type === 'workflow' && workflow.workflow_name === FRESH_SNAPSHOT_STAGE_ID &&
    workflow.script_name === FRESH_SNAPSHOT_STAGE_ID && workflow.class_name === 'CorpusSnapshot', 'BINDINGS');
  for (const [name, text] of Object.entries(expected)) {
    const binding = bindings.get(name);
    requireRun(binding?.type === 'plain_text' && binding.text === text, 'BINDINGS');
  }
}

export async function runStagedSnapshotPublicationMain(argv: string[], env: NodeJS.ProcessEnv = process.env, dependencies = {
  run: runStagedSnapshotPublication, read: readSnapshotCfBytes, send: fetch, writeReceipt: writeSnapshotWindowReceipt,
  verifyVersion: verifyPublicationVersion,
}) {
  requireRun(argv.length === 2 && argv[0] === '--reviewed-spec' && argv[1], 'ARGUMENTS');
  const { spec, reviewSpecSha256 } = await readReviewedSpec(argv[1]);
  const packetPin = { bytes: spec.packet.bytes, sha256: spec.packet.sha256 };
  const packetPath = spec.packet.path;
  const packet = await loadStagedPublication(packetPath, packetPin);
  bindPacket(spec, packet);
  await verifyPreparedConfig(spec);
  const tokens = snapshotScheduleTokens(env);
  const r2ReadToken = env.CIVICSIGNAL_SNAPSHOT_R2_READ_TOKEN;
  requireRun(r2ReadToken && /^[!-~]+$/.test(r2ReadToken), 'R2_CREDENTIAL');
  const profile = spec.cfMetadataProfile;
  const reviewDeadline = Date.parse(spec.review.validUntil);
  function reviewSignal(signal: AbortSignal | null | undefined) {
    const remaining = reviewDeadline - Date.now();
    requireRun(remaining > 0, 'REVIEW_EXPIRY');
    if (remaining > 15_000) return signal;
    const approval = AbortSignal.timeout(remaining);
    return signal ? AbortSignal.any([signal, approval]) : approval;
  }
  const read: CfReader = (args, signal, options) => dependencies.read(args, reviewSignal(signal) ?? undefined,
    args[0] === 'r2' ? { r2ReadToken } : { profile, versionModules: options?.versionModules });
  const send: SourceHeadSend = (input, init) => dependencies.send(input, { ...init, signal: reviewSignal(init.signal) });
  const admit = createSnapshotCfAdmissionReader({ packetPath, packetPin, reviewId: spec.review.id, r2ReadToken }, send, read);
  const observation = createSnapshotCfOutcomeReader(spec.evidence, read);
  const expiries = spec.credentialExpiries;
  let operatorTokenExpiresAt: string | undefined;
  const result = await dependencies.run({ packetPath, packetPin, deployment: spec.deployment, journal: spec.journal,
    evidenceTime: { admissionMs: spec.evidence.admissionMs, observationMs: spec.evidence.observationMs },
    operator: { token: tokens.operator, validUntil: expiries.operator },
    guards: { primary: { token: tokens.primary, validUntil: expiries.primary }, backup: { token: tokens.backup, validUntil: expiries.backup } },
  }, {
    async readHosted(args) { return JSON.parse((await read(args)).toString('utf8')) as unknown; },
    async admit(target, signal) {
      const calendar = snapshotCalendar(tokens.operator, (url, init) => send(url, {
        ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      }), FRESH_SNAPSHOT_STAGE_ID);
      ({ expiresAt: operatorTokenExpiresAt } = await calendar.verifyAccountToken(target.window.cleanupDeadline));
      await dependencies.verifyVersion(spec, packet, read, signal);
      return admit(target, signal);
    },
    observePublication: observation,
    openArtifact: target => stagedSnapshotArtifactSource(target.qualification.prefix, r2ReadToken, send),
  });
  requireRun(operatorTokenExpiresAt, 'OPERATOR_PROOF');
  const receipt = { ...result, reviewId: spec.review.id, reviewSpecSha256, packetSha256: spec.packet.sha256, operatorTokenExpiresAt };
  await dependencies.writeReceipt(spec.journal, 'publication-result.json', receipt);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStagedSnapshotPublicationMain(process.argv.slice(2)).then(receipt => console.log(JSON.stringify(receipt))).catch(error => {
    const safe = error instanceof Error && /^(SNAPSHOT|STAGING_R2_ADMISSION)_[A-Z0-9_]+$/.test(error.message);
    console.error(JSON.stringify({ error: safe ? error.message : 'SNAPSHOT_PUBLICATION_RUN_REFUSED' }));
    process.exitCode = 1;
  });
}
