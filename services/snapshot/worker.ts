/// <reference path="./env.d.ts" />
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { GitHubCorpusSource, type CorpusRevision } from '../../src/ingest/source';
import { manifestKey, parseManifest, SNAPSHOT_PARSER_VERSION } from '../../src/ingest/snapshot-format';
import { PARTITIONS, stageCorpus, buildGroup, sortIndexPartition, publishSnapshot, cleanupStaging,
  type GroupResult, type IndexPartition } from './builder';
import { assertSnapshotRevision, assertSourceRevision, type SnapshotControlEnv } from './revision-control';

export interface SnapshotParams { revision: CorpusRevision }

/** Every step returns small artifact references; XML and rows stay in R2. */
export class CorpusSnapshot extends WorkflowEntrypoint<SnapshotEnv & SnapshotControlEnv, SnapshotParams> {
  async run(event: WorkflowEvent<SnapshotParams>, step: WorkflowStep) {
    const revision = event.payload.revision;
    assertSnapshotRevision(this.env, revision);
    await step.do('check authoritative source commit date', async () => {
      assertSourceRevision(revision, await new GitHubCorpusSource({ branch: revision.commit }).head());
      return true;
    });
    const published = await step.do('check published revision', async () => {
      const object = await this.env.CORPUS.get(manifestKey(revision.commit, SNAPSHOT_PARSER_VERSION));
      if (!object) return null;
      const manifest = parseManifest(await object.text());
      if (manifest.commit !== revision.commit || manifest.date !== revision.date || manifest.parser !== SNAPSHOT_PARSER_VERSION) throw new Error('published snapshot identity mismatch');
      return manifest;
    });
    if (published) return { commit: published.commit, count: published.rows.count, existing: true };
    const plan = await step.do('stage pinned corpus once', { timeout: '60 minutes', retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' } },
      () => stageCorpus(this.env.CORPUS, new GitHubCorpusSource(), revision));
    const groups: GroupResult[] = [];
    let offset = 0;
    for (let group = 0; group < plan.groups.length; group++) {
      const result = await step.do(`parse file group ${group}`, () => buildGroup(this.env.CORPUS, plan, group, offset));
      groups.push(result);
      offset += result.bytes;
    }
    const partitions: IndexPartition[] = [];
    for (const partition of PARTITIONS) {
      partitions.push(await step.do(`sort ${partition} index`, () => sortIndexPartition(this.env.CORPUS, revision.commit, partition, groups)));
    }
    const result = await step.do('publish immutable snapshot manifest last', async () => {
      const manifest = await publishSnapshot(this.env.CORPUS, plan, groups, partitions);
      return { commit: manifest.commit, count: manifest.rows.count, bytes: manifest.rows.bytes, digest: manifest.index.digest };
    });
    await step.do('remove this revision staging objects', async () => { await cleanupStaging(this.env.CORPUS, revision.commit); return true; });
    return result;
  }
}

/** Shared discovery path; staging may require publication and inject one bounded head. */
export async function runSnapshotScheduled(env: SnapshotEnv & SnapshotControlEnv,
  options: { head?: () => Promise<CorpusRevision>; requirePublished?: boolean } = {}): Promise<void> {
    const revision = await (options.head ?? (() => new GitHubCorpusSource().head()))();
    assertSnapshotRevision(env, revision);
    if (await env.CORPUS.head(manifestKey(revision.commit, SNAPSHOT_PARSER_VERSION))) return;
    if (options.requirePublished) throw new Error('Snapshot staging probe requires the existing published revision.');
    // The pinned revision is also the Workflow id: a concurrent trigger reuses
    // its existing instance rather than starting a second writer.
    try { await env.SNAPSHOT.create({ id: `${SNAPSHOT_PARSER_VERSION}-${revision.commit}`, params: { revision } }); }
    catch (error) {
      const instance = await env.SNAPSHOT.get(`${SNAPSHOT_PARSER_VERSION}-${revision.commit}`);
      const status = await instance.status();
      if (['errored', 'terminated'].includes(status.status)) throw new Error(`snapshot ${revision.commit} needs operator recovery: ${status.status}`);
      if (!['queued', 'running', 'waiting', 'paused', 'complete'].includes(status.status)) throw error;
    }
}

export default {
  async scheduled(_event: ScheduledController, env: SnapshotEnv & SnapshotControlEnv): Promise<void> {
    await runSnapshotScheduled(env);
  },
};
