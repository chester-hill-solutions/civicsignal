import { Container, getContainer } from '@cloudflare/containers';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { archiveGateway, occurrence, runArchiveRefresh } from '../weekly-archive/refresh';

export { ContainerProxy } from '@cloudflare/containers';

const base = 'weekly/parliament';
const schema = z.object({ scheduledTime: occurrence });
type Params = z.infer<typeof schema>;
interface Env {
  ARCHIVE: R2Bucket;
  RUNTIME: DurableObjectNamespace<ParliamentRuntime>;
  PARLIAMENT: Workflow<Params>;
}

const instance = ({ scheduledTime }: Params) => `parliament-${scheduledTime}`;

export class ParliamentRuntime extends Container<Env> {
  defaultPort = 8080;
  pingEndpoint = 'localhost/health';
  sleepAfter = '10m';
  enableInternet = true;
}
ParliamentRuntime.outboundByHost = { 'archive.parliament.internal': archiveGateway([base]) };

export class ParliamentRefresh extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const params = schema.strict().parse(event.payload);
    const id = instance(params);
    if (event.instanceId !== id) throw new Error('Unexpected parliamentary occurrence.');
    return runArchiveRefresh(step, this.env.ARCHIVE, getContainer(this.env.RUNTIME, id), params, {
      id: instance, base, label: 'Parliament', schema,
      report: z.object({ complete: z.literal(true), session: z.literal('45-1'),
        servingTestsPassed: z.literal(2), verifiedCollections: z.literal(7),
        sourceObjectsVerified: z.number().int().positive() }),
    });
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env) {
    const params = { scheduledTime: Math.floor(event.scheduledTime / 60_000) * 60_000 };
    const id = instance(params);
    try {
      await env.PARLIAMENT.create({ id, params });
    } catch (error) {
      const { status } = await (await env.PARLIAMENT.get(id)).status();
      if (!['queued', 'running', 'waiting', 'complete'].includes(status)) throw error;
    }
  },
};
