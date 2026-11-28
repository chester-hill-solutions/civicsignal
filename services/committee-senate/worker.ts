import { Container, getContainer } from '@cloudflare/containers';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { archiveGateway, occurrence, runArchiveRefresh } from '../weekly-archive/refresh';

export { ContainerProxy } from '@cloudflare/containers';

const base = 'weekly/committee-senate';
const schema = z.strictObject({ scheduledTime: occurrence });
type Params = z.infer<typeof schema>;

interface Env {
  ARCHIVE: R2Bucket;
  RUNTIME: DurableObjectNamespace<SenateCommitteeRuntime>;
  DISCOVERY: Workflow<Params>;
}

const instance = ({ scheduledTime }: Params) => `committee-senate-${scheduledTime}`;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const edition = (language: 'en' | 'fr') => z.object({
  url: z.literal(`https://sencanada.ca/umbraco/surface/CommitteesAjax/GetCommitteeListPartialView?forMenu=false&Session=45-1&Lang=${language}`),
  httpStatus: z.literal(200),
  file: z.literal(`${language}.html`),
  sha256: digest,
  bytes: z.number().int().positive().max(1024 ** 2),
  committees: z.number().int().positive(),
});

export class SenateCommitteeRuntime extends Container<Env> {
  defaultPort = 8080;
  pingEndpoint = 'localhost/health';
  sleepAfter = '2m';
  enableInternet = true;
}
SenateCommitteeRuntime.outboundByHost = { 'archive.committee-senate.internal': archiveGateway([base]) };

export class SenateCommitteeDiscovery extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const params = schema.parse(event.payload);
    const id = instance(params);
    if (event.instanceId !== id) throw new Error('Unexpected Senate committee discovery occurrence.');

    const report = z.object({
      complete: z.literal(true),
      phase: z.literal('complete'),
      scope: z.literal('bilingual-senate-committee-directory'),
      session: z.literal('45-1'),
      scheduledTime: z.literal(params.scheduledTime),
      observedAt: z.iso.datetime(),
      catalogueSha256: digest,
      sources: z.object({ en: edition('en'), fr: edition('fr') }),
    }).refine(result => result.sources.en.committees === result.sources.fr.committees);

    return runArchiveRefresh(step, this.env.ARCHIVE, getContainer(this.env.RUNTIME, id), params, {
      id: instance, base, label: 'Senate committee directory', schema, report, maxPolls: 12,
    });
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env) {
    const params = { scheduledTime: Math.floor(event.scheduledTime / 60_000) * 60_000 };
    const id = instance(params);
    try {
      await env.DISCOVERY.create({ id, params });
    } catch (error) {
      const { status } = await (await env.DISCOVERY.get(id)).status();
      if (!['queued', 'running', 'waiting', 'complete'].includes(status)) throw error;
    }
  },
} satisfies ExportedHandler<Env>;
