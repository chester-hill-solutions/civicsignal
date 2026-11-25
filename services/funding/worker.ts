import { WorkerEntrypoint, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { FundingEdition } from '../../src/corpora/funding';
import { fundingDigest } from '../../src/corpora/funding-publication';
import { lookupFundingEdition } from '../../src/routes/funding';
import { collectNserc, readNsercInventory } from './archive';
import { publishFunding } from './publish';

interface RefreshParams { scheduledTime: number }
interface Env {
  REFRESH: Workflow<RefreshParams>;
  COLLECTOR: Fetcher;
  ARCHIVE: R2Bucket;
  DB: D1Database;
  LOOKUP: Service<FundingLookup>;
}

const editionContent = FundingEdition.omit({ revision: true });

export class FundingLookup extends WorkerEntrypoint<Env> {
  async lookup(id: string, language: 'en' | 'fr') {
    const result = await lookupFundingEdition(this.env.DB, 'nserc', id, language);
    if (!result.item) throw new Error('Published NSERC edition unavailable.');
    const { revision, ...content } = result.item;
    return { id: content.id, title: content.title, url: content.url, language: content.language,
      revision, contentSha256: fundingDigest(editionContent.parse(content)), catalogue: result.revision, sections: content.sections.length };
  }
}

export class FundingRefresh extends WorkflowEntrypoint<Env, RefreshParams> {
  async run(event: WorkflowEvent<RefreshParams>, step: WorkflowStep) {
    const { scheduledTime } = event.payload;
    if (!Number.isSafeInteger(scheduledTime) || event.instanceId !== `nserc-${scheduledTime}`) {
      throw new Error('Expected an NSERC instance keyed by its occurrence.');
    }
    const observedAt = new Date(scheduledTime).toISOString();
    const inventory = await step.do('archive NSERC inventory and publisher pages', {
      timeout: '8 minutes', retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
    }, () => collectNserc(this.env.COLLECTOR, observedAt));
    const published = await step.do('verify originals and publish funding terms', async () =>
      publishFunding(this.env.DB, 'nserc', await readNsercInventory(this.env.ARCHIVE, inventory, observedAt)));
    const lookup = await step.do('read English and French terms via private serving binding', async () => {
      return Promise.all((['en', 'fr'] as const).map(async language => {
        const expected = published.samples[language];
        const found = await this.env.LOOKUP.lookup(expected.id, language);
        if (found.catalogue !== published.revision || found.id !== expected.id || found.language !== language ||
          found.revision !== expected.revision || found.contentSha256 !== expected.revision ||
          found.title !== expected.title || found.url !== expected.url) throw new Error('Served NSERC terms differ from the acquired edition.');
        return { ...expected, language, catalogue: found.catalogue, sections: found.sections, contentSha256: found.contentSha256 };
      }));
    });
    const key = `funding/nserc/runs/${event.instanceId}.json`;
    await step.do('write verified funding receipt', async () => {
      const body = JSON.stringify({ instanceId: event.instanceId, observedAt, inventory, published, lookup });
      const written = await this.env.ARCHIVE.put(key, body, {
        onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' },
      });
      if (!written && await (await this.env.ARCHIVE.get(key))?.text() !== body) throw new Error('Conflicting NSERC receipt.');
      return key;
    });
    return { receiptKey: key, revision: published.revision, editions: published.editions };
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env) {
    const scheduledTime = event.scheduledTime, id = `nserc-${scheduledTime}`;
    try {
      await env.REFRESH.create({ id, params: { scheduledTime } });
    } catch (error) {
      const { status } = await (await env.REFRESH.get(id)).status();
      if (!['queued', 'running', 'waiting', 'complete'].includes(status)) throw error;
    }
  },
};
