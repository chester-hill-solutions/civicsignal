import { Container, getContainer } from '@cloudflare/containers';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { archiveGateway, occurrence, runArchiveRefresh } from '../weekly-archive/refresh';

export { ContainerProxy } from '@cloudflare/containers';

const base = 'weekly/statutes-export';
const schema = z.object({ scheduledTime: occurrence });
const revision = z.string().regex(/^[a-f0-9]{40}$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const report = z.object({ complete: z.literal(true), source: z.literal('https://github.com/justicecanada/laws-lois-xml.git'),
  previousRevision: revision, revision, generation: sha256, files: z.strictObject({
    'act-titles-fr.json': sha256, 'act-titles.json': sha256, 'statutes-fr.jsonl': sha256,
    'statutes-fr.sql': sha256, 'statutes.jsonl': sha256, 'statutes.sql': sha256,
  }),
});
type Params = z.infer<typeof schema>;
interface Env {
  ARCHIVE: R2Bucket;
  RUNTIME: DurableObjectNamespace<StatutesExportRuntime>;
  EXPORT: Workflow<Params>;
}

const instance = ({ scheduledTime }: Params) => `statutes-export-${scheduledTime}`;

export class StatutesExportRuntime extends Container<Env> {
  defaultPort = 8080;
  pingEndpoint = 'localhost/health';
  sleepAfter = '10m';
  enableInternet = true;
}
StatutesExportRuntime.outboundByHost = { 'archive.statutes-export.internal': archiveGateway([base]) };

export class StatutesExportRefresh extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const params = schema.strict().parse(event.payload);
    const id = instance(params);
    if (event.instanceId !== id) throw new Error('Unexpected statutes export occurrence.');
    return runArchiveRefresh(step, this.env.ARCHIVE, getContainer(this.env.RUNTIME, id), params, {
      id: instance, base, label: 'statutes export', schema, report,
    });
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env) {
    const params = { scheduledTime: Math.floor(event.scheduledTime / 60_000) * 60_000 };
    const id = instance(params);
    try {
      await env.EXPORT.create({ id, params });
    } catch (error) {
      const { status } = await (await env.EXPORT.get(id)).status();
      if (!['queued', 'running', 'waiting', 'complete'].includes(status)) throw error;
    }
  },
};
