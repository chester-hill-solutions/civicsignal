#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import creation from '../docs/evidence/2026-11-22/november-workflow-creation.json';
import { QUALIFICATION_STAGE_ID, qualificationIdentity } from '../services/snapshot/qualification';
import { manifestKey } from '../src/ingest/snapshot-format';
import type { SourceHeadSend } from '../src/ingest/source-head';
import { FileSnapshotBucket } from './lib/file-snapshot';
import { FRESH_SNAPSHOT_STAGE_ID, snapshotEventCron } from './lib/snapshot-calendar';
import { STAGING_ACCOUNT, stagingNames } from './lib/staging-config';
import { verifySnapshotArtifacts, type OpenSnapshotArtifact, type SnapshotArtifactReference } from './lib/verify-snapshot-artifacts';

const bucketName = stagingNames('20261022').corpus;
const objects = `https://api.cloudflare.com/client/v4/accounts/${STAGING_ACCOUNT}/r2/buckets/${bucketName}/objects`;
const commit = '855cdfc65207a6906c414e09a77d7f93267c5356';
const date = '2026-11-16';
const parser = 'statutes-v2';
const reference: SnapshotArtifactReference = { commit, date, parser, artifacts: 238, artifactBytes: 389760843, rows: 277666,
  manifest: { key: manifestKey(commit, parser), bytes: 44256, sha256: '43fdb9961b0980769552df1993e106beba8f3a354ecf9bd3fbd11091ea25ba34' } };
const canonical = { key: manifestKey('0507465393c224c0491fc8c17c88340217acc656', parser), bytes: 44627,
  sha256: '78c979e9a36ecd2215e4c16c9b0ab6df3ad7dfe6f5efe20addf4f471ac3e3e1e' };
const admissionMetadataBytes = 16 * 1024;
const admissionRequestMs = 10_000;
const admissionWallMs = 25_000;
const empty = z.tuple([]);
const emptyListing = z.object({ success: z.literal(true), result: empty, errors: empty.optional(),
  messages: z.array(z.unknown()).optional(), result_info: z.object({
    is_truncated: z.literal(false), cursor: z.union([z.literal(''), z.null()]).optional(),
    delimited: empty.optional(), prefixes: empty.optional(), delimited_prefixes: empty.optional(),
    count: z.literal(0).optional(), total_count: z.literal(0).optional(), per_page: z.number().int().nonnegative().optional(),
  }).strict() }).strict();
const missingObject = z.object({ success: z.literal(false), errors: z.tuple([z.object({ code: z.literal(10007) })]),
  result: z.null().optional() });
const packetSchema = z.object({ target: z.literal(FRESH_SNAPSHOT_STAGE_ID),
  configSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  bundle: z.object({ bytes: z.literal(creation.bootstrap.bundleBytes), sha256: z.literal(creation.bootstrap.bundleSha256) }),
  publication: z.object({ bucket: z.literal(bucketName), referenceManifestSha256: z.literal(reference.manifest.sha256),
    window: z.object({ scheduledAt: z.iso.datetime(), clearAt: z.iso.datetime().optional(),
      cleanupDeadline: z.iso.datetime().optional() }), runtimeDeadline: z.iso.datetime(),
    qualification: z.object({ identity: z.object({ id: z.string() }).passthrough(), digest: z.string(), prefix: z.string(), instanceId: z.string() }) }) });

export type StagedPublicationPacketPin = { bytes: number; sha256: string };

async function stagedPacketBytes(path: string, pin?: StagedPublicationPacketPin) {
  const maxBytes = 64 * 1024;
  if (pin) {
    if (!Number.isSafeInteger(pin.bytes) || pin.bytes < 1 || pin.bytes > maxBytes) throw new Error('SNAPSHOT_PUBLICATION_PACKET');
    const { readSnapshotProposalPinnedFile } = await import('./lib/snapshot-qualification-proposal');
    return readSnapshotProposalPinnedFile({ path, ...pin }, 'private');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(path, { end: maxBytes })) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  if (bytes.length > maxBytes) throw new Error('snapshot publication packet exceeds its size limit');
  return bytes;
}

export async function loadStagedPublication(path: string, pin?: StagedPublicationPacketPin) {
  const bytes = await stagedPacketBytes(path, pin);
  const result = packetSchema.safeParse(JSON.parse(bytes.toString('utf8')));
  if (!result.success) throw new Error('snapshot publication packet does not match the November staging resources');
  const { window, runtimeDeadline, qualification } = result.data.publication;
  const recorded = await qualificationIdentity({ SNAPSHOT_STAGE_ID: QUALIFICATION_STAGE_ID, SNAPSHOT_PINNED_COMMIT: commit,
    SNAPSHOT_PINNED_DATE: date, SNAPSHOT_QUALIFICATION_ID: qualification.identity.id,
    SNAPSHOT_QUALIFICATION_TIME: String(Date.parse(window.scheduledAt)), SNAPSHOT_QUALIFICATION_CRON: snapshotEventCron(window.scheduledAt),
    SNAPSHOT_QUALIFICATION_DEADLINE: String(Date.parse(runtimeDeadline)) });
  if (!isDeepStrictEqual(recorded, qualification)) throw new Error('snapshot publication qualification identity differs from the packet');
  Object.freeze(recorded.identity.revision);
  Object.freeze(recorded.identity.event);
  Object.freeze(recorded.identity);
  return { ...result.data, publication: { ...result.data.publication, qualification: Object.freeze(recorded) } };
}

function localSource(directory: string, canonicalRoot: string | undefined): OpenSnapshotArtifact {
  const bucket = new FileSnapshotBucket(directory);
  const baseline = canonicalRoot === undefined ? undefined : new FileSnapshotBucket(canonicalRoot);
  return async key => {
    const object = await (key === canonical.key && baseline ? baseline : bucket).get(key);
    if (!object?.body) throw new Error(`local snapshot artifact unavailable: ${key}`);
    return object.body;
  };
}

function stagedR2Reader(token: string, send: SourceHeadSend) {
  if (!/^[!-~]+$/.test(token)) throw new Error('a staging R2 read token is required in CLOUDFLARE_API_TOKEN');
  return (suffix: string, signal: AbortSignal) => {
    const request: RequestInit & { credentials: 'omit' } = {
      method: 'GET', signal, redirect: 'error', credentials: 'omit',
      headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache, no-store' },
    };
    return send(objects + suffix, request);
  };
}

function objectSuffix(key: string) {
  // Cloudflare's R2 API requires literal slashes inside the object key.
  return '/' + key.split('/').map(encodeURIComponent).join('/');
}

export function stagedSnapshotArtifactSource(prefix: string, token: string, send: SourceHeadSend): OpenSnapshotArtifact {
  const read = stagedR2Reader(token, send);
  return async (key, signal) => {
    const physical = key === canonical.key ? key : prefix + key;
    const response = await read(objectSuffix(physical), signal);
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`staging R2 snapshot read returned HTTP ${response.status}`);
    }
    return response.body;
  };
}

class StagedR2AdmissionError extends Error {
  constructor(readonly step: string, readonly reason: string) {
    super(`STAGING_R2_ADMISSION_${step}_${reason}`);
  }
}

function admissionJson(bytes: Uint8Array, step: string): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new StagedR2AdmissionError(step, 'ENVELOPE'); }
}

type AdmissionRequest = { step: 'LIST' | 'MANIFEST' | 'CANONICAL'; suffix: string; status: number; limit: number };

async function readAdmissionResponse(read: ReturnType<typeof stagedR2Reader>, wallDeadline: number, signal: AbortSignal | undefined,
  { step, suffix, status, limit }: AdmissionRequest) {
  const started = performance.now();
  const remainingMs = Math.min(admissionRequestMs, wallDeadline - started);
  const deadline = started + remainingMs;
  const controller = new AbortController();
  const timeout = new StagedR2AdmissionError(step, 'DEADLINE');
  function checkDeadline() {
    if (signal?.aborted || performance.now() >= deadline) throw timeout;
  }
  checkDeadline();
  let reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'read' | 'cancel' | 'releaseLock'> | undefined;
  let accepted = false;
  let abort!: () => void;
  const expired = new Promise<never>((_resolve, reject) => {
    abort = () => { reject(timeout); controller.abort(); };
  });
  const timer = setTimeout(abort, Math.ceil(remainingMs));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const pending = read(suffix, controller.signal);
    void pending.then(response => {
      if (controller.signal.aborted) return response.body?.cancel();
    }).catch(() => undefined);
    const response = await Promise.race([pending, expired]);
    if (response.body) reader = response.body.getReader();
    checkDeadline();
    if (response.redirected || response.status !== status) throw new StagedR2AdmissionError(step, `HTTP_${response.status}`);
    if (!reader) throw new StagedR2AdmissionError(step, 'BODY');
    const bytes = new Uint8Array(limit);
    let size = 0;
    for (;;) {
      const chunk = await Promise.race([reader.read(), expired]);
      checkDeadline();
      if (chunk.done) break;
      if (chunk.value.byteLength > limit - size) throw new StagedR2AdmissionError(step, 'SIZE');
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    accepted = true;
    return bytes.subarray(0, size);
  } catch (error) {
    if (error instanceof StagedR2AdmissionError) throw error;
    throw new StagedR2AdmissionError(step, 'READ');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (!accepted) {
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    }
    reader?.releaseLock();
  }
}

export async function verifyStagedR2Admission(packetPath: string, token: string, send: SourceHeadSend = fetch,
  signal?: AbortSignal, pin?: StagedPublicationPacketPin) {
  const { publication: { qualification, bucket } } = await loadStagedPublication(packetPath, pin);
  const read = stagedR2Reader(token, send);
  const deadline = performance.now() + admissionWallMs;
  const get = (request: AdmissionRequest) => readAdmissionResponse(read, deadline, signal, request);
  const query = new URLSearchParams({ prefix: qualification.prefix, per_page: '1' });
  const listing = await get({ step: 'LIST', suffix: '?' + query, status: 200, limit: admissionMetadataBytes });
  if (!emptyListing.safeParse(admissionJson(listing, 'LIST')).success) throw new StagedR2AdmissionError('LIST', 'ENVELOPE');
  const manifest = await get({ step: 'MANIFEST', suffix: objectSuffix(qualification.prefix + reference.manifest.key),
    status: 404, limit: admissionMetadataBytes });
  if (!missingObject.safeParse(admissionJson(manifest, 'MANIFEST')).success) throw new StagedR2AdmissionError('MANIFEST', 'ENVELOPE');
  const baseline = await get({ step: 'CANONICAL', suffix: objectSuffix(canonical.key), status: 200, limit: canonical.bytes });
  if (baseline.byteLength !== canonical.bytes || createHash('sha256').update(baseline).digest('hex') !== canonical.sha256) {
    throw new StagedR2AdmissionError('CANONICAL', 'DRIFT');
  }
  return { scope: 'staging-r2-admission', bucket, qualification: qualification.digest, namespace: qualification.prefix,
    observedAt: new Date().toISOString(), prefixEmpty: true as const, manifestAbsent: true as const,
    canonical: { bytes: canonical.bytes, sha256: canonical.sha256 },
    reads: { requests: 3, responseBytes: listing.byteLength + manifest.byteLength + baseline.byteLength } };
}

export async function verifyStagedSnapshotMain(argv: string[], env: NodeJS.ProcessEnv = process.env, send: typeof fetch = fetch) {
  const [mode, path, flag, baseline] = argv;
  if (path && mode === '--local' && (argv.length === 2 || (argv.length === 4 && flag === '--canonical-root' && baseline))) {
    return { scope: 'retained-local-reference', ...await verifySnapshotArtifacts({ reference, canonical: baseline ? canonical : undefined,
      budget: budget(!!baseline), open: localSource(path, baseline) }) };
  }
  if (argv.length === 3 && path === '--packet' && flag) {
    const token = env.CLOUDFLARE_API_TOKEN ?? '';
    if (mode === '--staging-admission') return verifyStagedR2Admission(flag, token, send);
    if (mode === '--staging') {
      const { publication: { qualification } } = await loadStagedPublication(flag);
      return { scope: 'staging-r2', qualification: qualification.digest,
        ...await verifyStagedPublicationArtifacts(stagedSnapshotArtifactSource(qualification.prefix, token, send)) };
    }
  }
  throw new Error('Usage: bun scripts/verify-staged-snapshot.ts --local <snapshot-root> [--canonical-root <canonical-root>] | --staging --packet <prepared-stage.json> | --staging-admission --packet <prepared-stage.json>');
}

function budget(withCanonical: boolean) {
  return { maxOperations: reference.artifacts + (withCanonical ? 2 : 0),
    maxResponseBytes: reference.artifactBytes + (withCanonical ? 2 * canonical.bytes : 0), wallMs: 7_200_000, requestMs: 15_000 };
}

export const stagedPublicationPins = Object.freeze({ reference: Object.freeze({ ...reference, manifest: Object.freeze(reference.manifest) }),
  canonical: Object.freeze(canonical), artifactBudget: Object.freeze(budget(true)) });

export function verifyStagedPublicationArtifacts(open: OpenSnapshotArtifact) {
  return verifySnapshotArtifacts({ reference, canonical, budget: stagedPublicationPins.artifactBudget, open });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyStagedSnapshotMain(process.argv.slice(2)).then(receipt => console.log(JSON.stringify(receipt))).catch(error => {
    console.error(error instanceof Error ? error.message : 'snapshot verification failed');
    process.exitCode = 1;
  });
}
