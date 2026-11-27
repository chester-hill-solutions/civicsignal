import { Container, getContainer } from '@cloudflare/containers';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { archiveGateway, occurrence, runArchiveRefresh } from '../weekly-archive/refresh';

export { ContainerProxy } from '@cloudflare/containers';

const chambers = ['house', 'senate'] as const;
const paramsSchema = z.object({ chamber: z.enum(chambers), scheduledTime: occurrence });
type Params = z.infer<typeof paramsSchema>;
interface Env {
  ARCHIVE: R2Bucket;
  RUNTIME: DurableObjectNamespace<HansardRuntime>;
  HANSARD: Workflow<Params>;
}

function prefix({ chamber }: Params) {
  return `weekly/hansard/${chamber}`;
}

function instance({ chamber, scheduledTime }: Params) {
  return `hansard-${chamber}-${scheduledTime}`;
}

export class HansardRuntime extends Container<Env> {
  defaultPort = 8080;
  pingEndpoint = 'localhost/health';
  sleepAfter = '10m';
  enableInternet = true;
}
HansardRuntime.outboundByHost = { 'archive.hansard.internal': archiveGateway(chambers.map(chamber => `weekly/hansard/${chamber}`)) };

export class HansardRefresh extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const params = paramsSchema.strict().parse(event.payload);
    const instanceId = instance(params);
    if (event.instanceId !== instanceId) throw new Error('Unexpected Hansard occurrence.');
    return runArchiveRefresh(step, this.env.ARCHIVE, getContainer(this.env.RUNTIME, instanceId), params, {
      id: instance, base: prefix(params), label: 'Hansard', schema: paramsSchema,
      report: z.object({ chamber: z.literal(params.chamber), session: z.literal('45-1'), verifiedByServingCheck: z.literal(true) }),
    });
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env) {
    const scheduledTime = Math.floor(event.scheduledTime / 60_000) * 60_000;
    await Promise.all(chambers.map(async chamber => {
      const params = { chamber, scheduledTime };
      const id = instance(params);
      try {
        await env.HANSARD.create({ id, params });
      } catch (error) {
        const { status } = await (await env.HANSARD.get(id)).status();
        if (!['queued', 'running', 'waiting', 'complete'].includes(status)) throw error;
      }
    }));
  },
};
