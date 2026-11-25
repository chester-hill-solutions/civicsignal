import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { collectNserc, readNsercInventory } from './archive';
import { FundingTermsLookup, refreshFunding, scheduleFunding, type FundingEnv, type RefreshParams } from './workflow';

export class FundingLookup extends FundingTermsLookup {
  protected readonly source = 'nserc';
}

export class FundingRefresh extends WorkflowEntrypoint<FundingEnv, RefreshParams> {
  async run(event: WorkflowEvent<RefreshParams>, step: WorkflowStep) {
    return refreshFunding(this.env, event, step, {
      source: 'nserc', readInventory: readNsercInventory,
      acquire: (collector, observedAt, steps) => steps.do('archive NSERC inventory and publisher pages', {
        timeout: '8 minutes', retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
      }, () => collectNserc(collector, observedAt)),
    });
  }
}

export default {
  scheduled: (event: ScheduledController, env: FundingEnv) => scheduleFunding(env, 'nserc', event.scheduledTime),
};
