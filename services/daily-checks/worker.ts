import { WorkerEntrypoint, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { observeProduct, metered, type ProductEnv } from './product';
import { checkAccess } from './access';
import { verifyCombined, type CombinedEnv, type CombinedServingInput } from './combined';
import { checkCommittees, checkConsultations, checkRecommendations, Inputs } from './acceptance';

export { HouseServingCheck } from './house';
export type { CombinedServingInput } from './combined';
export { default, ApiKeyUsageDO } from '../../src/index';

interface Env extends ProductEnv {
  ARCHIVE: R2Bucket;
  CONSULTATION_ARCHIVE: R2Bucket;
}

const noRetry = { retries: { limit: 0, delay: '1 second' as const }, timeout: '5 minutes' as const };

export class CombinedServingCheck extends WorkerEntrypoint<CombinedEnv> {
  verify(input: CombinedServingInput) { return verifyCombined(this.env, input); }
}

export class DailyServingChecks extends WorkflowEntrypoint<Env, Inputs> {
  async run(event: WorkflowEvent<Inputs>, step: WorkflowStep) {
    const params = Inputs.parse(event.payload);
    const consultations = await step.do('verify consultations through product HTTP', noRetry, () =>
      metered(this.env, read => checkConsultations(read, this.env.CONSULTATION_ARCHIVE, params.consultations)));
    const committees = await step.do('verify dated House calls and study links through product HTTP', noRetry, () =>
      metered(this.env, read => checkCommittees(read, this.env.ARCHIVE, params.committee)));
    const access = await step.do('verify discovery and unmetered denied access', noRetry, async () => {
      const { requests, before, after } = await observeProduct(this.env, 'free', client => checkAccess(client, committees.result.cutoff));
      return {requests,before,after};
    });
    const policyCase = (language: 'en' | 'fr') => step.do('trace the Finance Committee brief to funding terms ' + language, noRetry, () =>
      metered(this.env, read => checkRecommendations(read, this.env.ARCHIVE, params, language)));
    const recommendations = [await policyCase('en'), await policyCase('fr')];
    const key = `daily/serving/${event.instanceId}.json`;
    await step.do('record hosted product checks', async () => {
      const body = JSON.stringify({ instanceId: event.instanceId, params, consultations, committees, access, recommendations });
      const written = await this.env.ARCHIVE.put(key, body, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
      if (!written && await (await this.env.ARCHIVE.get(key))?.text() !== body) throw new Error('Conflicting product verification receipt.');
      return key;
    });
    return { receiptKey: key, casesPassed: 4, successfulRetrievals: [consultations, committees, ...recommendations].reduce((sum, test) => sum + test.requests.length, 0) };
  }
}
