import { Container, getContainer } from '@cloudflare/containers';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { archiveGateway, occurrence, runArchiveRefresh } from '../weekly-archive/refresh';

export { ContainerProxy } from '@cloudflare/containers';

const base = 'weekly/gazette';
const schema = z.object({ scheduledTime: occurrence });
type Params = z.infer<typeof schema>;
interface Env {
  ARCHIVE: R2Bucket;
  RUNTIME: DurableObjectNamespace<GazetteRuntime>;
  GAZETTE: Workflow<Params>;
}

const instance = ({ scheduledTime }: Params) => `gazette-${scheduledTime}`;

export class GazetteRuntime extends Container<Env> {
  defaultPort = 8080;
  pingEndpoint = 'localhost/health';
  sleepAfter = '10m';
  enableInternet = true;
}
GazetteRuntime.outboundByHost = { 'archive.gazette.internal': archiveGateway([base]) };

export class GazetteRefresh extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const params = schema.strict().parse(event.payload);
    const id = instance(params);
    if (event.instanceId !== id) throw new Error('Unexpected Gazette occurrence.');
    const complete = z.object({ complete: z.literal(true), servingTestsPassed: z.number().int().positive() });
    return runArchiveRefresh(step, this.env.ARCHIVE, getContainer(this.env.RUNTIME, id), params, {
      id: instance, base, label: 'Gazette', schema,
      report: z.object({ current: complete, annual: complete }),
    });
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env) {
    const params = { scheduledTime: Math.floor(event.scheduledTime / 60_000) * 60_000 };
    const id = instance(params);
    try {
      await env.GAZETTE.create({ id, params });
    } catch (error) {
      const { status } = await (await env.GAZETTE.get(id)).status();
      if (!['queued', 'running', 'waiting', 'complete'].includes(status)) throw error;
    }
  },
};
