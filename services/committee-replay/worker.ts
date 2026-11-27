import { Container, getContainer } from '@cloudflare/containers';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { refSchema } from '../federal-register/inventory';
import { archiveGateway, occurrence, runArchiveRefresh } from '../weekly-archive/refresh';

export { ContainerProxy } from '@cloudflare/containers';

const base = 'weekly/committee-replay';
const schema = z.object({ scheduledTime: occurrence });
const report = z.object({
  scope: z.literal('offline-replay'),
  phase: z.literal('complete'),
  complete: z.literal(true),
  originalsVerified: z.number().int().positive(),
  publicationParts: z.object({ pages: z.number().int().positive(), restored: z.array(z.object({
    url: z.string().url(), archivedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    downloadIndexSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  })) }),
  materialization: z.object({ materialized: z.literal(true), sourceEquivalent: z.literal(true) }),
  servingTestsPassed: z.literal(1),
  servingState: refSchema.refine(ref => ref.key === `${base}/manifests/${ref.sha256}.json`),
});
type Params = z.infer<typeof schema>;
interface Env {
  ARCHIVE: R2Bucket;
  RUNTIME: DurableObjectNamespace<CommitteeReplayRuntime>;
}

const instance = ({ scheduledTime }: Params) => `committee-replay-${scheduledTime}`;

export class CommitteeReplayRuntime extends Container<Env> {
  defaultPort = 8080;
  pingEndpoint = 'localhost/health';
  sleepAfter = '10m';
  enableInternet = false;
}
CommitteeReplayRuntime.outboundByHost = { 'archive.committee-replay.internal': archiveGateway([base]) };

export class CommitteeReplay extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const params = schema.strict().parse(event.payload);
    const id = instance(params);
    if (event.instanceId !== id) throw new Error('Unexpected committee replay occurrence.');
    return runArchiveRefresh(step, this.env.ARCHIVE, getContainer(this.env.RUNTIME, id), params, {
      id: instance, base, label: 'committee archive replay', schema, report, maxPolls: 1080,
    });
  }
}

export default {} satisfies ExportedHandler<Env>;
