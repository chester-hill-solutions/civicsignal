import type { WorkflowStep } from 'cloudflare:workers';
import { GitHubCorpusSource, type CorpusRevision, type CorpusSource } from '../../src/ingest/source';
import { manifestKey, parseManifest, SNAPSHOT_PARSER_VERSION } from '../../src/ingest/snapshot-format';
import { PARTITIONS, stageCorpus, buildGroup, sortIndexPartition, publishSnapshot, cleanupStaging,
  type BuildBucket, type GroupResult, type IndexPartition, type CleanupPolicy } from './builder';
import { assertSourceRevision } from './revision-control';
import { snapshotArchive } from './archive-source';

/** One implementation of parsing, offsets, sorting, manifest-last publication
 * and cleanup. Qualification supplies a scoped store and metered source only. */
export async function runSnapshotWorkflow(revision: CorpusRevision, step: WorkflowStep, bucket: BuildBucket,
  options: { head?: () => Promise<CorpusRevision>; source?: Pick<CorpusSource, 'instruments'>; sourceRetries?: number;
    qualificationStep?: <T extends Rpc.Serializable<T>>(name: string, callback: () => Promise<T>) => Promise<T>; cleanup?: CleanupPolicy } = {}) {
  // Canonical callers retain the exact original configs. Qualification's adapter
  // supplies explicit config, callback call/time limits and no reference map is
  // imported into the canonical entry or this shared implementation.
  const ordinary = <T extends Rpc.Serializable<T>>(name: string, callback: () => Promise<T>) => options.qualificationStep
    ? options.qualificationStep(name, callback) : step.do(name, callback);
  const head = options.head ?? (() => new GitHubCorpusSource({ branch: revision.commit }).head());
  const check = async () => { assertSourceRevision(revision, await head()); return true; };
  if (options.qualificationStep) await ordinary('check authoritative source commit date', check);
  else if (options.sourceRetries === undefined) await step.do('check authoritative source commit date', check);
  else await step.do('check authoritative source commit date', { retries: { limit: options.sourceRetries, delay: '1 second' } }, check);
  const published = await ordinary('check published revision', async () => {
    const object = await bucket.get(manifestKey(revision.commit, SNAPSHOT_PARSER_VERSION));
    if (!object) return null;
    const manifest = parseManifest(await object.text());
    if (manifest.commit !== revision.commit || manifest.date !== revision.date || manifest.parser !== SNAPSHOT_PARSER_VERSION) throw new Error('published snapshot identity mismatch');
    return manifest;
  });
  if (published) return { commit: published.commit, count: published.rows.count, existing: true };
  const stage = () => stageCorpus(bucket, options.source ?? snapshotArchive(), revision);
  const plan = options.qualificationStep ? await ordinary('stage pinned corpus once', stage) :
    await step.do('stage pinned corpus once', { timeout: '60 minutes', retries: { limit: options.sourceRetries ?? 3, delay: '30 seconds', backoff: 'exponential' } }, stage);
  const groups: GroupResult[] = [];
  let offset = 0;
  for (let group = 0; group < plan.groups.length; group++) {
    const result = await ordinary(`parse file group ${group}`, () => buildGroup(bucket, plan, group, offset));
    groups.push(result);
    offset += result.bytes;
  }
  const partitions: IndexPartition[] = [];
  for (const partition of PARTITIONS) {
    partitions.push(await ordinary(`sort ${partition} index`, () => sortIndexPartition(bucket, revision.commit, partition, groups)));
  }
  const result = await ordinary('publish immutable snapshot manifest last', async () => {
    const manifest = await publishSnapshot(bucket, plan, groups, partitions);
    return { commit: manifest.commit, count: manifest.rows.count, bytes: manifest.rows.bytes, digest: manifest.index.digest };
  });
  await ordinary('remove this revision staging objects', async () => { await cleanupStaging(bucket, revision.commit, options.cleanup); return true; });
  return result;
}
