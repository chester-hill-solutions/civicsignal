import { Container, getContainer } from '@cloudflare/containers';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { refSchema } from '../federal-register/inventory';
import { archiveGateway, occurrence, runArchiveRefresh } from '../weekly-archive/refresh';

export { ContainerProxy } from '@cloudflare/containers';

const chambers = ['house', 'senate'] as const;
const schema = z.object({ chamber: z.enum(chambers), scheduledTime: occurrence });
type Params = z.infer<typeof schema>;

interface Env {
  ARCHIVE: R2Bucket;
  RUNTIME: DurableObjectNamespace<ChamberAgendaRuntime>;
  AGENDA: Workflow<Params>;
}

const prefix = (chamber: Params['chamber']) => `weekly/chamber-agenda-${chamber}`;
const instance = ({ chamber, scheduledTime }: Params) => `chamber-agenda-${chamber}-${scheduledTime}`;
const count = z.number().int().positive();
const issue = z.strictObject({ number: count, date: z.iso.date(), suffix: z.string().regex(/^[A-Z]$/u).optional() });
const archiveRef = (base: string) => refSchema.refine(ref => ref.key === `${base}/manifests/${ref.sha256}.json`);

export class ChamberAgendaRuntime extends Container<Env> {
  defaultPort = 8080;
  pingEndpoint = 'localhost/health';
  sleepAfter = '2m';
  enableInternet = true;
}
ChamberAgendaRuntime.outboundByHost = {
  'archive.house-agenda.internal': archiveGateway([prefix('house')]),
  'archive.senate-agenda.internal': archiveGateway([prefix('senate')]),
};

export class ChamberAgendaRefresh extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const params = schema.strict().parse(event.payload);
    const { chamber, scheduledTime } = params;
    const id = instance(params);
    if (event.instanceId !== id) throw new Error('Unexpected chamber agenda occurrence.');

    const base = prefix(chamber);
    const report = z.object({
      complete: z.literal(true), phase: z.literal('complete'), chamber: z.literal(chamber),
      session: z.literal('45-1'), collection: z.literal(`${chamber}-agenda`), scheduledTime: z.literal(scheduledTime),
      observedAt: z.iso.datetime(), inventorySha256: z.string().regex(/^[a-f0-9]{64}$/u),
      records: count, languages: z.strictObject({ en: count, fr: count }), sources: count, sourceObjectsVerified: count,
      latest: z.strictObject({ paper: issue, projected: issue.optional() }),
      inputState: archiveRef(base), workspace: archiveRef(base),
    }).refine(value => value.languages.en === value.languages.fr && value.records === value.languages.en + value.languages.fr &&
      value.sourceObjectsVerified <= value.sources && (chamber === 'house') === Boolean(value.latest.projected) &&
      (chamber === 'house' || !value.latest.paper.suffix));
    return runArchiveRefresh(step, this.env.ARCHIVE, getContainer(this.env.RUNTIME, id), params, {
      id: instance, base, label: `${chamber} agenda`, schema, report, maxPolls: 32, verifyReportWorkspace: true,
    });
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env) {
    const scheduledTime = Math.floor(event.scheduledTime / 60_000) * 60_000;
    const results = await Promise.allSettled(chambers.map(async chamber => {
      const params = { chamber, scheduledTime };
      const id = instance(params);
      try {
        await env.AGENDA.create({ id, params });
      } catch (error) {
        const { status } = await (await env.AGENDA.get(id)).status();
        if (!['queued', 'running', 'waiting', 'complete'].includes(status)) throw error;
      }
    }));
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'A chamber agenda occurrence could not start.');
  },
} satisfies ExportedHandler<Env>;
