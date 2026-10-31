/// <reference path="./env.d.ts" />
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { assertSourceRevision } from './revision-control';
import { qualificationBucket, qualificationReceipt, assertQualificationReceipt } from './qualification-store';
import { qualificationIdentity, qualificationRecord, runQualificationScheduled,
  type QualificationControls, type QualificationParams, type QualificationWorkflowBinding } from './qualification';
import { qualificationSource } from './qualification-source';
import { runSnapshotWorkflow } from './snapshot-workflow';

type QualificationEnv = QualificationControls & { CORPUS: R2Bucket; SNAPSHOT: QualificationWorkflowBinding };

/** Stage-only alternative entry point; production's class/default config are
 * unchanged. The existing Workflow resource can bind this same export name. */
export class CorpusSnapshot extends WorkflowEntrypoint<QualificationEnv, QualificationParams> {
  async run(event: WorkflowEvent<QualificationParams>, step: WorkflowStep) {
    const q = await qualificationIdentity(this.env);
    if (event.instanceId !== q.instanceId || event.payload.qualification !== q.digest) throw new Error('Qualification Workflow identity differs.');
    assertSourceRevision(q.identity.revision, event.payload.revision);
    // No direct/manual Workflow invocation can skip the scheduled admission and
    // completed discovery checkpoint. Checks repeat on every runtime restart.
    await assertQualificationReceipt(this.env.CORPUS, q.prefix + 'diagnostics/admitted.json', qualificationRecord(q, 'admitted'));
    await assertQualificationReceipt(this.env.CORPUS, q.prefix + 'diagnostics/discovered.json', qualificationRecord(q, 'discovered'));
    const bucket = qualificationBucket(this.env.CORPUS, q.prefix);
    const source = qualificationSource(this.env.CORPUS, q);
    const result = await runSnapshotWorkflow(q.identity.revision, step, bucket, {
      head: () => source.head('authoritative'), source, sourceRetries: 0,
    });
    await step.do('record qualification publication outcome', async () => {
      await qualificationReceipt(this.env.CORPUS, q.prefix + 'diagnostics/published.json', {
        ...qualificationRecord(q, 'published'), count: result.count, existing: 'existing' in result && result.existing === true,
      });
      return true;
    });
    return { ...result, qualification: q.digest, namespace: q.prefix, instanceId: q.instanceId };
  }
}

export default {
  async scheduled(event: ScheduledController, env: QualificationEnv): Promise<void> {
    await runQualificationScheduled(env, event, q => qualificationSource(env.CORPUS, q).head('discovery'));
  },
};
