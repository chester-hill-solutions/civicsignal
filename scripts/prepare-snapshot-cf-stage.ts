#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import creation from '../docs/evidence/2026-11-22/november-workflow-creation.json';
import { QUALIFICATION_STAGE_ID, qualificationIdentity } from '../services/snapshot/qualification';
import { FRESH_SNAPSHOT_STAGE_ID as target, snapshotEventCron } from './lib/snapshot-calendar';
import { readSnapshotProposalPinnedFile } from './lib/snapshot-qualification-proposal';
import { stagingNames } from './lib/staging-config';

const novemberBundle = { bytes: creation.bootstrap.bundleBytes, sha256: creation.bootstrap.bundleSha256 };
const sha256 = (content: Uint8Array | string) => createHash('sha256').update(content).digest('hex');

async function publication(scheduledAt: string) {
  const cron = snapshotEventCron(scheduledAt);
  const time = Date.parse(scheduledAt);
  if (time - Date.now() <= 16 * 60_000) throw new Error('SNAPSHOT_CF_STAGE_PUBLICATION_WINDOW');
  const deadline = time + 2 * 60 * 60_000;
  const clear = time + 20 * 60_000;
  const bucket = stagingNames('20261022').corpus;
  const vars = {
    SNAPSHOT_STAGE_ID: QUALIFICATION_STAGE_ID,
    SNAPSHOT_PINNED_COMMIT: '855cdfc65207a6906c414e09a77d7f93267c5356',
    SNAPSHOT_PINNED_DATE: '2026-11-16',
    SNAPSHOT_QUALIFICATION_ID: `nov16-${scheduledAt.slice(0, 10).replaceAll('-', '')}-${scheduledAt.slice(11, 16).replace(':', '')}`,
    SNAPSHOT_QUALIFICATION_CRON: cron,
    SNAPSHOT_QUALIFICATION_TIME: String(time),
    SNAPSHOT_QUALIFICATION_DEADLINE: String(deadline),
  };
  const qualification = await qualificationIdentity(vars);
  const window = { scheduledAt, clearAt: new Date(clear).toISOString(), cleanupDeadline: new Date(clear + 3 * 60_000).toISOString() };
  const bindings = Object.fromEntries(Object.entries(vars).map(([name, value]) => [name, { type: 'text', value }]));
  return { env: { ...bindings, CORPUS: { type: 'r2', name: bucket } },
    receipt: { bucket, window, qualification, runtimeDeadline: new Date(deadline).toISOString(),
      referenceManifestSha256: '43fdb9961b0980769552df1993e106beba8f3a354ecf9bd3fbd11091ea25ba34' } };
}

async function main(args: string[]) {
  const [bundlePath, out, flag, scheduledAt] = args;
  const preparePublication = args.length === 4 && flag === '--scheduled-at' && scheduledAt;
  if ((args.length !== 2 && !preparePublication) || !bundlePath || !out || !isAbsolute(out) || out !== resolve(out)) {
    throw new Error('SNAPSHOT_CF_STAGE_ARGUMENTS');
  }
  const bundle = await readSnapshotProposalPinnedFile({ path: bundlePath, ...novemberBundle }, 'private');
  const candidate = preparePublication ? await publication(preparePublication) : undefined;

  const output = join(out, '.cloudflare', 'output', 'v0');
  const worker = join(output, 'workers', 'default');
  const config = {
    name: target, compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
    workersDev: false, previewUrls: false, observability: { enabled: true },
    limits: { cpuMs: 300000, subrequests: 100000 }, triggers: [],
    exports: { CorpusSnapshot: { type: 'workflow', name: target } },
    env: { SNAPSHOT: { type: 'workflow', name: target, worker: target, exportName: 'CorpusSnapshot' }, ...candidate?.env },
    manifest: { type: 'partial', mainModule: 'candidate.mjs', modules: {} },
  };
  const configBytes = JSON.stringify(config, null, 2) + '\n';
  const configSha256 = sha256(configBytes);
  if (!candidate && configSha256 !== creation.bootstrap.configSha256) throw new Error('SNAPSHOT_CF_STAGE_CONFIG_DRIFT');
  await mkdir(out, { mode: 0o700 });
  await mkdir(join(worker, 'bundle'), { recursive: true, mode: 0o700 });
  await writeFile(join(output, 'config.json'), '{"buildContext":{"isPreview":false}}\n', { mode: 0o600, flag: 'wx' });
  await writeFile(join(worker, 'worker.config.json'), configBytes, { mode: 0o600, flag: 'wx' });
  await writeFile(join(worker, 'bundle', 'candidate.mjs'), bundle, { mode: 0o600, flag: 'wx' });

  const receipt = { target, bundle: novemberBundle, configSha256, buildOutputVersion: 'v0',
    workerCronsConfigured: 0, nativeSchedulesConfigured: 0, publicRoutesConfigured: 0, r2BindingsConfigured: candidate ? 1 : 0,
    ...(candidate && { publication: candidate.receipt }) };
  await writeFile(join(out, 'prepared-stage.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return receipt;
}

main(process.argv.slice(2)).then(receipt => console.log(JSON.stringify(receipt))).catch(error => {
  const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SNAPSHOT_CF_STAGE_PREPARATION_FAILED';
  console.error(JSON.stringify({ error: code }));
  process.exitCode = 1;
});
