/** Local candidate only. Deployment/first initialization requires explicit user
 * approval for the additional allowance. Never select from a default config. */
import worker, { PipelineCoordinator as BasePipelineCoordinator } from './worker';
export default worker;

type Constructor = ConstructorParameters<typeof BasePipelineCoordinator>;
function checkTextMode(env: Constructor[1]): void {
  if (env.CORPUS_RETAIN_D1_TEXT !== 'false') throw new Error('The isolated staging recovery text mode is required.');
}

/** Initial grant stays paused; only the existing explicit resume route opens it.
 * A reconstruction with open pending work pauses conservatively: an earlier
 * pause acknowledgement may have been lost before its storage write committed. */
export class PipelineCoordinator extends BasePipelineCoordinator {
  constructor(ctx: Constructor[0], env: Constructor[1]) {
    checkTextMode(env);
    super(ctx, env, { coordinatorId: ctx.id.toString(), mode: 'extend' });
    ctx.blockConcurrencyWhile(async () => {
      const before = await super.controlStatus();
      if (!before.coordinator.suspended && before.coordinator.pending) {
        const paused = await super.suspend(before.coordinator.revision);
        if ('coordinatorRejected' in paused || !paused.coordinator.suspended || !paused.coordinator.quiescent ||
            paused.coordinator.alarmAt !== null) throw new Error('Staging recovery reconstruction could not establish a suspended idle coordinator.');
      }
    });
  }
}

/** Alias this export as PipelineCoordinator in the reviewed stop-only entry.
 * It verifies an existing grant and can never create one as a side effect. */
export class RecoveryStopCoordinator extends BasePipelineCoordinator {
  constructor(ctx: Constructor[0], env: Constructor[1]) {
    checkTextMode(env);
    super(ctx, env, { coordinatorId: ctx.id.toString(), mode: 'verify' });
    ctx.blockConcurrencyWhile(async () => {
      const before = await super.controlStatus();
      const paused = await super.suspend(before.coordinator.revision);
      if ('coordinatorRejected' in paused || !paused.coordinator.suspended || !paused.coordinator.quiescent ||
          paused.coordinator.alarmAt !== null) throw new Error('Staging recovery stop could not establish a suspended idle coordinator.');
    });
  }
  override async resume(_revision: number) {
    return { coordinatorRejected: true as const, code: 'suspended',
      error: 'Resume is disabled in this staging recovery stop deployment.', status: 409 as const };
  }
}
