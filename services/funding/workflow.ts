import { WorkerEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { FundingEdition, type FundingInventory, type FundingSource } from '../../src/corpora/funding';
import { fundingDigest } from '../../src/corpora/funding-publication';
import { lookupFundingEdition } from '../../src/routes/funding';
import { publishFunding } from './publish';

export interface RefreshParams { scheduledTime: number }

export interface FundingEnv {
  REFRESH: Workflow<RefreshParams>;
  COLLECTOR: Fetcher;
  ARCHIVE: R2Bucket;
  DB: D1Database;
  LOOKUP: Service<FundingTermsLookup>;
}

export interface InventoryRef {
  key: string;
  sha256: string;
  bytes: number;
  sources: number;
  sourceBytes: number;
}

const editionContent = FundingEdition.omit({ revision: true });

export abstract class FundingTermsLookup extends WorkerEntrypoint<FundingEnv> {
  protected abstract readonly source: FundingSource;

  async lookup(id: string, language: 'en' | 'fr') {
    const result = await lookupFundingEdition(this.env.DB, this.source, id, language);
    if (!result.item) throw new Error(`Published ${this.source} edition unavailable.`);
    const { revision, ...content } = result.item;
    return { id: content.id, title: content.title, url: content.url, language: content.language,
      revision, contentSha256: fundingDigest(editionContent.parse(content)), catalogue: result.revision, sections: content.sections.length };
  }
}

interface FundingIntake {
  source: FundingSource;
  acquire: (collector: Fetcher, observedAt: string, step: WorkflowStep) => Promise<InventoryRef>;
  readInventory: (bucket: R2Bucket, ref: InventoryRef, observedAt: string) => Promise<FundingInventory>;
}

export async function refreshFunding(env: FundingEnv, event: WorkflowEvent<RefreshParams>, step: WorkflowStep, intake: FundingIntake) {
  const { source } = intake;
  const { scheduledTime } = event.payload;
  if (!Number.isSafeInteger(scheduledTime) || event.instanceId !== `${source}-${scheduledTime}`) {
    throw new Error(`Expected a ${source} instance keyed by its occurrence.`);
  }
  const observedAt = new Date(scheduledTime).toISOString();
  const inventory = await intake.acquire(env.COLLECTOR, observedAt, step);
  const published = await step.do('verify originals and publish funding terms', async () =>
    publishFunding(env.DB, source, await intake.readInventory(env.ARCHIVE, inventory, observedAt)));
  const lookup = await step.do('read English and French terms via private serving binding', async () => {
    return Promise.all((['en', 'fr'] as const).map(async language => {
      const expected = published.samples[language];
      const found = await env.LOOKUP.lookup(expected.id, language);
      if (found.catalogue !== published.revision || found.id !== expected.id || found.language !== language ||
        found.revision !== expected.revision || found.contentSha256 !== expected.revision ||
        found.title !== expected.title || found.url !== expected.url) throw new Error(`Served ${source} terms differ from the acquired edition.`);
      return { ...expected, language, catalogue: found.catalogue, sections: found.sections, contentSha256: found.contentSha256 };
    }));
  });
  const key = `funding/${source}/runs/${event.instanceId}.json`;
  await step.do('write verified funding receipt', async () => {
    const body = JSON.stringify({ instanceId: event.instanceId, observedAt, inventory, published, lookup });
    const written = await env.ARCHIVE.put(key, body, {
      onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' },
    });
    if (!written && await (await env.ARCHIVE.get(key))?.text() !== body) throw new Error(`Conflicting ${source} receipt.`);
    return key;
  });
  return { receiptKey: key, revision: published.revision, editions: published.editions };
}

export async function scheduleFunding(env: FundingEnv, source: FundingSource, scheduledTime: number) {
  const id = `${source}-${scheduledTime}`;
  try {
    await env.REFRESH.create({ id, params: { scheduledTime } });
  } catch (error) {
    const { status } = await (await env.REFRESH.get(id)).status();
    if (!['queued', 'running', 'waiting', 'complete'].includes(status)) throw error;
  }
}
