import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { verificationClient, count, metered, type ProductEnv } from './product';
import { z } from 'zod';
import { checkCommittees, checkConsultations, checkRecommendations, Inputs } from './acceptance';

export { HouseServingCheck } from './house';
export { default, ApiKeyUsageDO } from '../../src/index';

interface Env extends ProductEnv {
  ARCHIVE: R2Bucket;
  CONSULTATION_ARCHIVE: R2Bucket;
}

const noRetry = { retries: { limit: 0, delay: '1 second' as const }, timeout: '5 minutes' as const };

async function checkAccess(env: Env, cutoff: string) {
  const client = verificationClient(env);
  const before = await count(env);
  const denied = await client.request('/api/funding-programs/coverage?source=esdc', false);
  await denied.arrayBuffer();
  if (denied.status !== 401) throw new Error('Funding retrieval must require a workspace key.');
  const response = await client.request('/.well-known/civicsignal.json', false);
  if (!response.ok) throw new Error('Discovery unavailable.');
  const discovery = z.object({ sources: z.array(z.object({ id: z.string(), status: z.string(),
    editions: z.array(z.object({ language: z.string(), coverageThrough: z.string().optional() })) })),
    researchQuestions: z.array(z.object({ id: z.string(), language: z.string(), status: z.string() })) }).parse(await response.json());
  for (const id of ['consultations', 'committees', 'nserc', 'esdc']) {
    const source = discovery.sources.find(row => row.id === id);
    if (source?.status !== 'available' || !['en', 'fr'].every(lang => source.editions.some(e => e.language === lang &&
      (id !== 'committees' || Date.parse(e.coverageThrough ?? '') === Date.parse(cutoff))))) throw new Error('Missing verified discovery editions for ' + id);
  }
  for (const lang of ['en', 'fr']) {
    if (!discovery.researchQuestions.some(row => row.id === 'apprenticeship' && row.language === lang && row.status === 'available')) {
      throw new Error('Incomplete apprenticeship research instructions in ' + lang);
    }
  }
  const after = await count(env);
  if (after !== before) throw new Error('Discovery or denied retrieval charged the staging workspace.');
  return { requests: client.requests, before, after };
}

export class DailyServingChecks extends WorkflowEntrypoint<Env, Inputs> {
  async run(event: WorkflowEvent<Inputs>, step: WorkflowStep) {
    const params = Inputs.parse(event.payload);
    const consultations = await step.do('verify consultations through product HTTP', noRetry, () =>
      metered(this.env, read => checkConsultations(read, this.env.CONSULTATION_ARCHIVE, params.consultations)));
    const committees = await step.do('verify dated House calls and study links through product HTTP', noRetry, () =>
      metered(this.env, read => checkCommittees(read, this.env.ARCHIVE, params.committee)));
    const access = await step.do('verify discovery and unmetered denied access', noRetry, () => checkAccess(this.env, committees.result.cutoff));
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
