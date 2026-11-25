import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { collectEsdc, readEsdcInventory } from './archive';
import { FundingTermsLookup, refreshFunding, scheduleFunding, type FundingEnv, type RefreshParams } from '../workflow';

export class EsdcLookup extends FundingTermsLookup {
  protected readonly source = 'esdc';
}

export class EsdcRefresh extends WorkflowEntrypoint<FundingEnv, RefreshParams> {
  async run(event: WorkflowEvent<RefreshParams>, step: WorkflowStep) {
    return refreshFunding(this.env, event, step, {
      source: 'esdc', readInventory: readEsdcInventory,
      acquire: (collector, observedAt, steps) => steps.do('archive ESDC inventory and publisher pages', {
        timeout: '20 minutes', retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
      }, () => collectEsdc(collector, observedAt)),
    });
  }
}

export default {
  scheduled: (event: ScheduledController, env: FundingEnv) => scheduleFunding(env, 'esdc', event.scheduledTime),
};
