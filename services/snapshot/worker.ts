/// <reference path="./env.d.ts" />
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { GitHubCorpusSource, type CorpusRevision } from '../../src/ingest/source';
import { manifestKey, SNAPSHOT_PARSER_VERSION } from '../../src/ingest/snapshot-format';
import { assertSnapshotRevision, type SnapshotControlEnv } from './revision-control';
import { runSnapshotWorkflow } from './snapshot-workflow';

export interface SnapshotParams { revision: CorpusRevision }

/** Every step returns small artifact references; XML and rows stay in R2. */
export class CorpusSnapshot extends WorkflowEntrypoint<SnapshotEnv & SnapshotControlEnv, SnapshotParams> {
  async run(event: WorkflowEvent<SnapshotParams>, step: WorkflowStep) {
    const revision = event.payload.revision;
    assertSnapshotRevision(this.env, revision);
    return runSnapshotWorkflow(revision, step, this.env.CORPUS);
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
