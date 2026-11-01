/** Stop-only diagnostic entry point. Never select this from a default config. */
import worker, { PipelineCoordinator as BasePipelineCoordinator } from './worker';

export default worker;

/** Retain the deployed export/class and namespace identity. Re-close admission
 * on every reconstruction; this maintenance deployment cannot authorize resume. */
export class PipelineCoordinator extends BasePipelineCoordinator {
  constructor(...args: ConstructorParameters<typeof BasePipelineCoordinator>) {
    super(...args);
    const [ctx, env] = args;
    ctx.blockConcurrencyWhile(async () => {
      if (env.PIPELINE_PINNED_COMMIT !== '0507465393c224c0491fc8c17c88340217acc656' ||
          env.PIPELINE_PINNED_DATE !== '2026-10-15' || env.PIPELINE_EMBEDDING_ATTEMPT_CAP !== '1112' ||
          env.CORPUS_RETAIN_D1_TEXT !== 'false') throw new Error('The isolated staging maintenance identity is required.');
      // This directly joins both initialization promises created by the base.
      // The constructor gate remains closed throughout the storage-only pause,
      // even if the base temporarily restores an already-due recovery alarm.
      const before = await super.controlStatus();
      const paused = await super.suspend(before.coordinator.revision);
      if ('coordinatorRejected' in paused || !paused.coordinator.suspended || !paused.coordinator.quiescent ||
          paused.coordinator.alarmAt !== null) throw new Error('Staging maintenance could not establish a suspended idle coordinator.');
    });
  }

  override async resume(_revision: number) {
    return { coordinatorRejected: true as const, code: 'suspended',
      error: 'Resume is disabled in this staging maintenance deployment.', status: 409 as const };
  }
}
