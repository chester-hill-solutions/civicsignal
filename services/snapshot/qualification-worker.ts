/// <reference path="./env.d.ts" />
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { assertSourceRevision } from './revision-control';
import { qualificationBucket, qualificationReceipt, assertQualificationReceipt } from './qualification-store';
import { qualificationIdentity, qualificationRecord, runQualificationScheduled,
  type QualificationControls, type QualificationParams, type QualificationWorkflowBinding } from './qualification';
import { qualificationSource } from './qualification-source';
import { runSnapshotWorkflow } from './snapshot-workflow';
import { qualificationRuntime, QUALIFICATION_ADMISSION_STEP } from './qualification-reference-policy';

type QualificationEnv = QualificationControls & { CORPUS: R2Bucket; SNAPSHOT: QualificationWorkflowBinding };

/** Stage-only alternative entry point; production's class/default config are
 * unchanged. The existing Workflow resource can bind this same export name. */
export class CorpusSnapshot extends WorkflowEntrypoint<QualificationEnv, QualificationParams> {
  async run(event: WorkflowEvent<QualificationParams>, step: WorkflowStep) {
    const q = await qualificationIdentity(this.env);
    if (event.instanceId !== q.instanceId || event.payload.qualification !== q.digest) throw new Error('Qualification Workflow identity differs.');
    assertSourceRevision(q.identity.revision, event.payload.revision);
    const runtime = qualificationRuntime(this.env.CORPUS, q);
    // No direct/manual invocation can skip scheduled discovery. A completed
    // admission checkpoint is reused on engine reconstruction, not refetched.
    await runtime.step(step, QUALIFICATION_ADMISSION_STEP, async () => {
      await assertQualificationReceipt(runtime.bucket, q.prefix + 'diagnostics/admitted.json', qualificationRecord(q, 'admitted'));
      await assertQualificationReceipt(runtime.bucket, q.prefix + 'diagnostics/discovered.json', qualificationRecord(q, 'discovered'));
      return true;
    });
    const bucket = qualificationBucket(runtime.bucket, q.prefix);
    const source = qualificationSource(runtime.bucket, q);
    const result = await runSnapshotWorkflow(q.identity.revision, step, bucket, {
      head: () => source.head('authoritative'), source, sourceRetries: 0,
      qualificationStep: (name, callback) => runtime.step(step, name, callback), cleanup: runtime.cleanup,
    });
    await runtime.step(step, 'record qualification publication outcome', async () => {
      await qualificationReceipt(runtime.bucket, q.prefix + 'diagnostics/published.json', {
        ...qualificationRecord(q, 'published'), count: result.count, existing: 'existing' in result && result.existing === true,
      });
      return true;
    });
    return { ...result, qualification: q.digest, namespace: q.prefix, instanceId: q.instanceId };
  }
}

export default {
  async scheduled(event: ScheduledController, env: QualificationEnv): Promise<void> {
    event.noRetry();
    const q = await qualificationIdentity(env), runtime = qualificationRuntime(env.CORPUS, q);
    await runtime.run('scheduled entry', () => runQualificationScheduled({ ...env, CORPUS: runtime.bucket }, event,
      () => qualificationSource(runtime.bucket, q).head('discovery')));
  },
};
