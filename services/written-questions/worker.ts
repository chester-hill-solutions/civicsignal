import { Container, getContainer } from '@cloudflare/containers';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { archiveGateway, occurrence, runArchiveRefresh } from '../weekly-archive/refresh';

export { ContainerProxy } from '@cloudflare/containers';

const base = 'weekly/written-questions';
const schema = z.object({ scheduledTime: occurrence });
const report = z.object({
  complete: z.literal(true),
  catalogue: z.object({ complete: z.literal(true), officialReported: z.number().int().positive() }),
  acquisition: z.object({
    objectVerification: z.object({ referenced: z.number().int().positive(), invalid: z.array(z.string()).length(0) }),
  }),
  materialization: z.object({ materialized: z.literal(true), sourceEquivalent: z.literal(true) }),
  servingTestsPassed: z.literal(1),
});
type Params = z.infer<typeof schema>;
interface Env {
  ARCHIVE: R2Bucket;
  RUNTIME: DurableObjectNamespace<WrittenQuestionsRuntime>;
  WRITTEN_QUESTIONS: Workflow<Params>;
}

const instance = ({ scheduledTime }: Params) => `written-questions-${scheduledTime}`;

export class WrittenQuestionsRuntime extends Container<Env> {
  defaultPort = 8080;
  pingEndpoint = 'localhost/health';
  sleepAfter = '10m';
  enableInternet = true;
}
WrittenQuestionsRuntime.outboundByHost = { 'archive.written-questions.internal': archiveGateway([base]) };

export class WrittenQuestionsRefresh extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const params = schema.strict().parse(event.payload);
    const id = instance(params);
    if (event.instanceId !== id) throw new Error('Unexpected written-question occurrence.');
    return runArchiveRefresh(step, this.env.ARCHIVE, getContainer(this.env.RUNTIME, id), params, {
      id: instance, base, label: 'written questions', schema, report, maxPolls: 720,
    });
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env) {
    const params = { scheduledTime: Math.floor(event.scheduledTime / 60_000) * 60_000 };
    const id = instance(params);
    try {
      await env.WRITTEN_QUESTIONS.create({ id, params });
    } catch (error) {
      const { status } = await (await env.WRITTEN_QUESTIONS.get(id)).status();
      if (!['queued', 'running', 'waiting', 'complete'].includes(status)) throw error;
    }
  },
} satisfies ExportedHandler<Env>;
