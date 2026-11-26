import { Container, getContainer } from '@cloudflare/containers';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { textSha256 } from '../../src/corpora/text-store';
import { advancePointer, bytesFor, immutableText, refSchema } from '../federal-register/inventory';

export { ContainerProxy } from '@cloudflare/containers';

const chambers = ['house', 'senate'] as const;
const paramsSchema = z.strictObject({ chamber: z.enum(chambers), scheduledTime: z.number().int().positive().lt(4102444800000) });
type Params = z.infer<typeof paramsSchema>;
type Ref = z.infer<typeof refSchema>;
interface Env {
  ARCHIVE: R2Bucket;
  RUNTIME: DurableObjectNamespace<HansardRuntime>;
  HANSARD: Workflow<Params>;
}

const chunkLimit = 16 * 1024 ** 2;
const pointerSchema = paramsSchema.extend({
  instanceId: z.string(),
  receiptKey: z.string(),
  status: z.enum(['complete', 'degraded']),
  state: refSchema.optional(),
}).refine(row => row.instanceId === instance(row) && row.receiptKey === `${prefix(row)}/runs/${row.instanceId}.json` &&
  (row.status === 'complete') === Boolean(row.state));
const progressSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('empty') }),
  z.object({ status: z.literal('running'), instanceId: z.string() }),
  z.object({ status: z.literal('failed'), instanceId: z.string(), reason: z.string().max(2600) }),
  z.object({ status: z.literal('complete'), instanceId: z.string(), report: refSchema, state: refSchema }),
]);

function prefix({ chamber }: Params) {
  return `weekly/hansard/${chamber}`;
}

function instance({ chamber, scheduledTime }: Params) {
  return `hansard-${chamber}-${scheduledTime}`;
}

function assertRef(ref: Ref, params: Params, folder: 'manifests' | 'reports') {
  if (ref.key !== `${prefix(params)}/${folder}/${ref.sha256}.json`) throw new Error('Unexpected Hansard archive object key.');
  return ref;
}

async function archiveGateway(request: Request, env: Env) {
  const key = new URL(request.url).pathname.slice(1);
  const match = /^weekly\/hansard\/(house|senate)\/(?:(chunks)\/([a-f0-9]{64})|(manifests|reports)\/([a-f0-9]{64})\.json)$/u.exec(key);
  if (!match) return new Response(null, { status: 404 });
  if (request.method === 'GET') {
    const object = await env.ARCHIVE.get(key);
    return object ? new Response(object.body, { headers: { 'Content-Length': String(object.size) } }) : new Response(null, { status: 404 });
  }
  if (request.method !== 'PUT') return new Response(null, { status: 405 });
  const bytes = Number(request.headers.get('Content-Length'));
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > chunkLimit) return new Response(null, { status: 413 });
  const body = new Uint8Array(await request.arrayBuffer());
  const sha256 = match[3] ?? match[5];
  if (!sha256 || body.length !== bytes || await textSha256(body) !== sha256) return new Response(null, { status: 422 });
  const object = await env.ARCHIVE.put(key, body, { sha256, onlyIf: { etagDoesNotMatch: '*' } });
  if (!object) await bytesFor(env.ARCHIVE, { key, sha256, bytes });
  return new Response(null, { status: object ? 201 : 200 });
}

export class HansardRuntime extends Container<Env> {
  defaultPort = 8080;
  pingEndpoint = 'localhost/health';
  sleepAfter = '10m';
  enableInternet = true;
}
HansardRuntime.outboundByHost = { 'archive.hansard.internal': archiveGateway };

async function latestState(bucket: R2Bucket, params: Params) {
  const previous = await bucket.get(`${prefix(params)}/latest-complete.json`);
  if (previous) {
    const pointer = pointerSchema.parse(await previous.json());
    if (pointer.chamber !== params.chamber || pointer.scheduledTime >= params.scheduledTime || !pointer.state) {
      throw new Error('Hansard occurrence does not follow the current publication.');
    }
    return assertRef(pointer.state, params, 'manifests');
  }
  const seed = await bucket.get(`${prefix(params)}/bootstrap.json`);
  if (!seed) throw new Error('A Hansard bootstrap manifest is required.');
  return assertRef(refSchema.parse(await seed.json()), params, 'manifests');
}

export class HansardRefresh extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const params = paramsSchema.parse(event.payload);
    const instanceId = instance(params);
    if (event.instanceId !== instanceId) throw new Error('Unexpected Hansard occurrence.');
    const inputState = await step.do('pin the last verified Hansard workspace', () => latestState(this.env.ARCHIVE, params));
    const runtime = getContainer(this.env.RUNTIME, instanceId);
    const request = { ...params, instanceId, inputState };
    const start = async () => {
      const response = await runtime.fetch('http://runtime/start', { method: 'POST', body: JSON.stringify(request) });
      if (!response.ok) throw new Error(`Hansard container returned HTTP ${response.status}.`);
    };
    await step.do('start the Hansard acquisition container', start);
    let result: Exclude<z.infer<typeof progressSchema>, { status: 'empty' | 'running' }> | undefined;
    for (let poll = 0; poll < 120; poll++) {
      if (poll) await step.sleep(`wait for the Hansard container ${poll}`, '20 seconds');
      const progress = await step.do(`inspect the Hansard container ${poll}`, async () => {
        const response = await runtime.fetch('http://runtime/status');
        if (!response.ok) throw new Error('Could not read the Hansard container status.');
        const status = progressSchema.parse(await response.json());
        if (status.status === 'empty') await start();
        else if (status.instanceId !== instanceId) throw new Error('The Hansard container reports a different occurrence.');
        return status;
      });
      if (progress.status === 'complete' || progress.status === 'failed') {
        result = progress;
        break;
      }
    }
    await step.do('release the Hansard acquisition container', () => runtime.destroy());
    const outcome = result ?? { status: 'failed' as const, reason: 'The Hansard refresh exceeded the observation window.' };
    return step.do('verify the Hansard result and retain the occurrence receipt', async () => {
      const base = prefix(params);
      const receiptKey = `${base}/runs/${instanceId}.json`;
      const common = { ...params, instanceId, receiptKey };
      if (outcome.status === 'failed') {
        const pointer = pointerSchema.parse({ ...common, status: 'degraded' });
        await immutableText(this.env.ARCHIVE, receiptKey, JSON.stringify({
          schemaVersion: 1, ...pointer, inputState, reason: outcome.reason,
        }), 'application/json');
        await advancePointer(this.env.ARCHIVE, `${base}/latest-attempt.json`, pointer, pointerSchema);
        return pointer;
      }
      const state = assertRef(outcome.state, params, 'manifests');
      const report = assertRef(outcome.report, params, 'reports');
      const readback = await bytesFor(this.env.ARCHIVE, report);
      z.object({ chamber: z.literal(params.chamber), session: z.literal('45-1'), verifiedByServingCheck: z.literal(true) })
        .parse(JSON.parse(new TextDecoder().decode(readback)));
      await bytesFor(this.env.ARCHIVE, state);
      const pointer = pointerSchema.parse({ ...common, state, status: 'complete' });
      await immutableText(this.env.ARCHIVE, receiptKey, JSON.stringify({ schemaVersion: 1, ...pointer, inputState, report }), 'application/json');
      await advancePointer(this.env.ARCHIVE, `${base}/latest-complete.json`, pointer, pointerSchema);
      await advancePointer(this.env.ARCHIVE, `${base}/latest-attempt.json`, pointer, pointerSchema);
      return { ...pointer, report };
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
