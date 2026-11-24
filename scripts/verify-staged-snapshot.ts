#!/usr/bin/env bun
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import creation from '../docs/evidence/2026-11-22/november-workflow-creation.json';
import { QUALIFICATION_STAGE_ID, qualificationIdentity } from '../services/snapshot/qualification';
import { manifestKey } from '../src/ingest/snapshot-format';
import { FileSnapshotBucket } from './lib/file-snapshot';
import { FRESH_SNAPSHOT_STAGE_ID, snapshotEventCron } from './lib/snapshot-calendar';
import { STAGING_ACCOUNT, stagingNames } from './lib/staging-config';
import { verifySnapshotArtifacts, type OpenSnapshotArtifact, type SnapshotArtifactReference } from './lib/verify-snapshot-artifacts';

const bucketName = stagingNames('20261022').corpus;
const commit = '855cdfc65207a6906c414e09a77d7f93267c5356';
const date = '2026-11-16';
const parser = 'statutes-v2';
const reference: SnapshotArtifactReference = { commit, date, parser, artifacts: 238, artifactBytes: 389760843, rows: 277666,
  manifest: { key: manifestKey(commit, parser), bytes: 44256, sha256: '43fdb9961b0980769552df1993e106beba8f3a354ecf9bd3fbd11091ea25ba34' } };
const canonical = { key: manifestKey('0507465393c224c0491fc8c17c88340217acc656', parser), bytes: 44627,
  sha256: '78c979e9a36ecd2215e4c16c9b0ab6df3ad7dfe6f5efe20addf4f471ac3e3e1e' };
const packetSchema = z.object({ target: z.literal(FRESH_SNAPSHOT_STAGE_ID),
  configSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  bundle: z.object({ bytes: z.literal(creation.bootstrap.bundleBytes), sha256: z.literal(creation.bootstrap.bundleSha256) }),
  publication: z.object({ bucket: z.literal(bucketName), referenceManifestSha256: z.literal(reference.manifest.sha256),
    window: z.object({ scheduledAt: z.iso.datetime(), clearAt: z.iso.datetime().optional(),
      cleanupDeadline: z.iso.datetime().optional() }), runtimeDeadline: z.iso.datetime(),
    qualification: z.object({ identity: z.object({ id: z.string() }).passthrough(), digest: z.string(), prefix: z.string(), instanceId: z.string() }) }) });

export async function loadStagedPublication(path: string) {
  const maxBytes = 64 * 1024;
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(path, { end: maxBytes })) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  if (bytes.length > maxBytes) throw new Error('snapshot publication packet exceeds its size limit');
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

export function stagedSnapshotArtifactSource(prefix: string, token: string, send: typeof fetch): OpenSnapshotArtifact {
  if (!/^[!-~]+$/.test(token)) throw new Error('a staging R2 read token is required in CLOUDFLARE_API_TOKEN');
  const objects = `https://api.cloudflare.com/client/v4/accounts/${STAGING_ACCOUNT}/r2/buckets/${bucketName}/objects/`;
  return async (key, signal) => {
    const physical = key === canonical.key ? key : prefix + key;
    // Cloudflare's R2 API requires literal slashes inside the object key.
    const path = physical.split('/').map(encodeURIComponent).join('/');
    const request: RequestInit & { credentials: 'omit' } = { method: 'GET', signal, redirect: 'error', credentials: 'omit',
      headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache, no-store' } };
    const response = await send(objects + path, request);
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`staging R2 snapshot read returned HTTP ${response.status}`);
    }
    return response.body;
  };
}

export async function verifyStagedSnapshotMain(argv: string[], env: NodeJS.ProcessEnv = process.env, send: typeof fetch = fetch) {
  const [mode, path, flag, baseline] = argv;
  if (path && mode === '--local' && (argv.length === 2 || (argv.length === 4 && flag === '--canonical-root' && baseline))) {
    return { scope: 'retained-local-reference', ...await verifySnapshotArtifacts({ reference, canonical: baseline ? canonical : undefined,
      budget: budget(!!baseline), open: localSource(path, baseline) }) };
  }
  if (path && mode === '--staging' && argv.length === 3 && path === '--packet' && flag) {
    const { publication: { qualification } } = await loadStagedPublication(flag);
    return { scope: 'staging-r2', qualification: qualification.digest,
      ...await verifyStagedPublicationArtifacts(stagedSnapshotArtifactSource(qualification.prefix, env.CLOUDFLARE_API_TOKEN ?? '', send)) };
  }
  throw new Error('Usage: bun scripts/verify-staged-snapshot.ts --local <snapshot-root> [--canonical-root <canonical-root>] | --staging --packet <prepared-stage.json>');
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
