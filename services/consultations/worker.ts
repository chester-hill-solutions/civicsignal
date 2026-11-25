import { WorkerEntrypoint, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { lookupConsultation } from '../../src/routes/consultations';
import { acquireConsultationSources, readConsultationSources } from './acquire';
import { publishConsultations } from './publish';

interface RefreshParams { scheduledTime: number }
interface Env {
  REFRESH: Workflow<RefreshParams>;
  ARCHIVE: R2Bucket;
  DB: D1Database;
  LOOKUP: Service<ConsultationLookup>;
}

/** Only Workers granted this service binding can call the staging reader. */
export class ConsultationLookup extends WorkerEntrypoint<Env> {
  async lookup(id: string, asOf: string) {
    return lookupConsultation(this.env.DB, id, asOf);
  }
}

export class ConsultationsRefresh extends WorkflowEntrypoint<Env, RefreshParams> {
  async run(event: WorkflowEvent<RefreshParams>, step: WorkflowStep) {
    const { scheduledTime } = event.payload;
    if (!Number.isSafeInteger(scheduledTime) || event.instanceId !== `consultations-${scheduledTime}`) {
      throw new Error('Expected a consultations instance keyed by its calendar occurrence.');
    }
    const observedAt = new Date(scheduledTime).toISOString();
    const sources = await step.do('archive publisher catalogue and dictionary', () =>
      acquireConsultationSources(this.env.ARCHIVE));
    const published = await step.do('publish archived catalogue to D1', { timeout: '10 minutes',
      retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' } }, async () => {
      const input = await readConsultationSources(this.env.ARCHIVE, sources);
      return publishConsultations(this.env.DB, {
        ...input, observedAt, csvSha256: sources.csv.sha256, schemaSha256: sources.schema.sha256,
        csvSource: { ...sources.csv }, schemaSource: { ...sources.schema },
      });
    });
    const lookup = await step.do('verify private bilingual consultation lookup', async () => {
      const { item, observedAt: servedAt } = await this.env.LOOKUP.lookup(published.sampleId, observedAt);
      if (servedAt !== observedAt || !item || item.id !== published.sampleId || item.removedAt !== null ||
        item.editions.en.title !== published.sampleTitles.en || item.editions.fr.title !== published.sampleTitles.fr) {
        throw new Error('The serving lookup did not match the published consultation.');
      }
      return { id: item.id, titles: { en: item.editions.en.title, fr: item.editions.fr.title } };
    });
    const receiptKey = `consultations/runs/${event.instanceId}.json`;
    await step.do('write verified refresh receipt', async () => {
      const body = JSON.stringify({ instanceId: event.instanceId, observedAt, sources, published, lookup });
      const created = await this.env.ARCHIVE.put(receiptKey, body, {
        onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' },
      });
      if (!created && await (await this.env.ARCHIVE.get(receiptKey))?.text() !== body) {
        throw new Error('A different receipt already exists for this occurrence.');
      }
      return receiptKey;
    });
    return { receiptKey, rows: published.rows, revision: published.revision };
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const scheduledTime = event.scheduledTime;
    const id = `consultations-${scheduledTime}`;
    try {
      await env.REFRESH.create({ id, params: { scheduledTime } });
    } catch (error) {
      const instance = await env.REFRESH.get(id);
      const { status } = await instance.status();
      if (!['queued', 'running', 'waiting', 'complete'].includes(status)) throw error;
    }
  },
};
