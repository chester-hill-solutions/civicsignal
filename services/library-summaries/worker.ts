import { Container, getContainer } from '@cloudflare/containers';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { refSchema } from '../federal-register/inventory';
import { archiveGateway, occurrence, runArchiveRefresh } from '../weekly-archive/refresh';

export { ContainerProxy } from '@cloudflare/containers';

const base = 'weekly/library-summaries';
const schema = z.object({ scheduledTime: occurrence });
type Params = z.infer<typeof schema>;

interface Env {
  ARCHIVE: R2Bucket;
  RUNTIME: DurableObjectNamespace<LibrarySummariesRuntime>;
  LIBRARY_SUMMARIES: Workflow<Params>;
}

const instance = ({ scheduledTime }: Params) => `library-summaries-${scheduledTime}`;
const positiveCount = z.number().int().positive();
const report = z.object({
  complete: z.literal(true), session: z.literal('45-1'), scheduledTime: occurrence,
  listedEditions: positiveCount, verifiedEditions: positiveCount, bills: positiveCount,
  languages: z.strictObject({ en: positiveCount, fr: positiveCount }), sourceObjectsVerified: positiveCount,
  inventorySha256: z.string().regex(/^[a-f0-9]{64}$/u), billInventorySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  workspace: refSchema.refine(ref => ref.key === `${base}/manifests/${ref.sha256}.json`),
}).refine(value => value.verifiedEditions === value.listedEditions &&
  value.languages.en === value.bills && value.languages.fr === value.bills && value.listedEditions === 2 * value.bills);

export class LibrarySummariesRuntime extends Container<Env> {
  defaultPort = 8080;
  pingEndpoint = 'localhost/health';
  sleepAfter = '10m';
  enableInternet = true;
}
LibrarySummariesRuntime.outboundByHost = { 'archive.library-summaries.internal': archiveGateway([base]) };

export class LibrarySummariesRefresh extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const params = schema.strict().parse(event.payload);
    const id = instance(params);
    if (event.instanceId !== id) throw new Error('Unexpected Library summaries occurrence.');
    return runArchiveRefresh(step, this.env.ARCHIVE, getContainer(this.env.RUNTIME, id), params, {
      id: instance, base, label: 'Library summaries', schema,
      report: report.refine(value => value.scheduledTime === params.scheduledTime),
      verifyReportWorkspace: true,
    });
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env) {
    const params = { scheduledTime: Math.floor(event.scheduledTime / 60_000) * 60_000 };
    const id = instance(params);
    try {
      await env.LIBRARY_SUMMARIES.create({ id, params });
    } catch (error) {
      const { status } = await (await env.LIBRARY_SUMMARIES.get(id)).status();
      if (!['queued', 'running', 'waiting', 'complete'].includes(status)) throw error;
    }
  },
} satisfies ExportedHandler<Env>;
