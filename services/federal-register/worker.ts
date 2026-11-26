/// <reference path="./register.d.ts" />
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import registerText from '../../docs/evidence/2026-11-23/federal-public-service-sources.csv';
import { textSha256 } from '../../src/corpora/text-store';
import { advancePointer, encode, immutableText, packetRef, prefix, verifyInventory, Pointer } from './inventory';
import { acquireTitles, prepareTitles, publishTitles } from './official-titles';
import { acquireServiceResource, prepareServiceInventory, publishServiceInventory, serviceResources, type ServiceAttempt } from './service-inventory';

interface Params { scheduledTime: number }
interface Env {
  REFRESH: Workflow<Params>;
  COLLECTOR: Fetcher;
  ARCHIVE: R2Bucket;
}

export class FederalDiscoveryRefresh extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { instanceId, payload: { scheduledTime } } = event;
    if (!Number.isSafeInteger(scheduledTime) || scheduledTime <= 0 || scheduledTime >= 4102444800000 ||
        instanceId !== `federal-discovery-${scheduledTime}`) throw new Error('Invalid federal discovery occurrence.');
    const register = await step.do('archive the checked-in federal register', async () => {
      const bytes = encode(registerText);
      const sha256 = await textSha256(bytes);
      const key = `${prefix}/registers/${sha256}.csv`;
      await immutableText(this.env.ARCHIVE, key, registerText, 'text/csv; charset=utf-8');
      return { key, sha256, bytes: bytes.byteLength };
    });
    const ref = await step.do('acquire official federal catalogue endpoints', {
      timeout: '10 minutes', retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' },
    }, async () => {
      const response = await this.env.COLLECTOR.fetch('https://collector.internal/collect', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scheduledTime, registerKey: register.key, registerSha256: register.sha256 }),
      });
      if (!response.ok) throw new Error(`Federal discovery collector returned HTTP ${response.status}.`);
      return packetRef(await response.json());
    });
    const counts = await step.do('verify the full register and its archived originals', () =>
      verifyInventory(this.env.ARCHIVE, ref, registerText, register.sha256, scheduledTime));
    const receiptKey = `${prefix}/runs/${instanceId}.json`;
    const status = counts.failed > 0 ? 'partial' : 'complete';
    const pointer: Pointer = { instanceId, scheduledTime, receiptKey, status };
    const discovery = await step.do('publish the immutable register receipt and advance its index', async () => {
      await immutableText(this.env.ARCHIVE, receiptKey, JSON.stringify({
        schemaVersion: 1, ...pointer, observedAt: new Date(scheduledTime).toISOString(), register, packetRef: ref, counts,
      }), 'application/json');
      if (status === 'complete') await advancePointer(this.env.ARCHIVE, `${prefix}/latest-complete.json`, pointer, Pointer);
      await advancePointer(this.env.ARCHIVE, `${prefix}/latest-attempt.json`, pointer, Pointer);
      return { receiptKey, status, counts };
    });
    const titles = await step.do('pin the hosted catalogue resource for official titles', () => prepareTitles(this.env.ARCHIVE, pointer, ref));
    const resource = 'resource' in titles ? titles.resource : undefined;
    const result = resource && await step.do('acquire official institution titles', { timeout: '3 minutes' }, () =>
      acquireTitles(this.env.COLLECTOR, resource));
    const officialTitles = await step.do('verify and publish official institution titles', () =>
      publishTitles(this.env.ARCHIVE, pointer, titles, result));
    const service = await step.do('pin the hosted catalogue resources for GC Service Inventory', () =>
      prepareServiceInventory(this.env.ARCHIVE, pointer, ref));
    const serviceResults: ServiceAttempt[] = [];
    for (const csv of serviceResources(service)) {
      const result = await step.do(`acquire GC Service Inventory ${csv.resourceId}`, { timeout: '3 minutes' }, () =>
        acquireServiceResource(this.env.COLLECTOR, scheduledTime, csv));
      serviceResults.push({ resource: csv, result });
    }
    const serviceInventory = await step.do('verify and publish GC Service Inventory', () =>
      publishServiceInventory(this.env.ARCHIVE, pointer, service, serviceResults));
    return { ...discovery, officialTitles, serviceInventory };
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env) {
    const id = `federal-discovery-${event.scheduledTime}`;
    try {
      await env.REFRESH.create({ id, params: { scheduledTime: event.scheduledTime } });
    } catch (error) {
      const status = (await (await env.REFRESH.get(id)).status()).status;
      if (status === 'unknown') throw error;
    }
  },
};
