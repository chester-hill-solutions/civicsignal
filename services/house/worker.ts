import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { HouseServingCheck } from '../daily-checks/house';
import { inventoryReference, prefix, readHouseInventory } from './archive';
import { HouseBase, publishHouse, readHouseBase } from './publish';

interface Params { scheduledTime: number }
interface Env {
  REFRESH: Workflow<Params>;
  COLLECTOR: Fetcher;
  HOUSE_SERVING: Service<HouseServingCheck>;
  ARCHIVE: R2Bucket;
  DB: D1Database;
}

async function baseForInstance(env: Env, id: string) {
  const key = `${prefix}/observations/${id}/publication-base.json`;
  let object = await env.ARCHIVE.get(key);
  if (!object) {
    const base = await readHouseBase(env.DB, '45-1');
    const created = await env.ARCHIVE.put(key, JSON.stringify(base), { onlyIf: { etagDoesNotMatch: '*' } });
    if (created) return base;
    object = await env.ARCHIVE.get(key);
  }
  if (!object || object.size > 16 * 1024 * 1024) throw new Error('Missing or oversized House publication base.');
  return HouseBase.parse(await object.json());
}

export class HouseRefresh extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { instanceId, payload: { scheduledTime } } = event;
    if (!Number.isSafeInteger(scheduledTime) || scheduledTime <= 0 || instanceId !== `house-calls-${scheduledTime}`) throw new Error('Invalid House occurrence.');
    const packetRef = await step.do('checkpoint and acquire committee originals', {
      retries: {limit:3,delay:'15 seconds',backoff:'exponential'}, timeout:'15 minutes',
    }, async () => {
      const { session, prior } = await baseForInstance(this.env, instanceId);
      const response = await this.env.COLLECTOR.fetch('https://collector.internal/collect', {method:'POST',
        headers:{'content-type':'application/json'}, body:JSON.stringify({instanceId,scheduledTime,session,prior})});
      if (!response.ok) throw new Error(`House collector returned HTTP ${response.status}.`);
      return inventoryReference(await response.json());
    });
    const published = await step.do('verify originals and publish dated call changes', async () => {
      const base = await baseForInstance(this.env, instanceId);
      const packet = await readHouseInventory(this.env.ARCHIVE,packetRef,instanceId,scheduledTime);
      return publishHouse(this.env.DB,base,packet,packetRef.sha256);
    });
    const served = await step.do('check English and French calls through the authenticated product', async () => {
      const result = await this.env.HOUSE_SERVING.verify({ observedAt: published.observedAt, cutoff: published.cutoff, packetRef });
      return JSON.parse(JSON.stringify(result)) as Awaited<ReturnType<HouseServingCheck['verify']>>;
    });
    const receiptKey = `${prefix}/runs/${instanceId}.json`;
    await step.do('retain verified House refresh receipt', async () => {
      const body = JSON.stringify({instanceId,scheduledTime,packetRef,published,served});
      const stored = await this.env.ARCHIVE.put(receiptKey,body,{
        onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'},
      });
      if (!stored && await (await this.env.ARCHIVE.get(receiptKey))?.text() !== body) throw new Error('Conflicting House completion receipt.');
      return receiptKey;
    });
    return {receiptKey,observedAt:published.observedAt};
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env) {
    const id = `house-calls-${event.scheduledTime}`;
    try {
      await env.REFRESH.create({id,params:{scheduledTime:event.scheduledTime}});
    } catch (error) {
      const status = await (await env.REFRESH.get(id)).status();
      if (!['queued','running','waiting','complete'].includes(status.status)) throw error;
    }
  },
};
