import type { WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { textSha256 } from '../../src/corpora/text-store';
import { advancePointer, bytesFor, immutableText, refSchema } from '../federal-register/inventory';

export const occurrence = z.number().int().positive().lt(4102444800000);
const chunkLimit = 16 * 1024 ** 2;
type Ref = z.infer<typeof refSchema>;
type Runtime = { fetch(input: string, init?: RequestInit): Promise<Response>; destroy(): Promise<void> };
const progress = z.discriminatedUnion('status', [
  z.object({ status: z.literal('empty') }),
  z.object({ status: z.literal('running'), instanceId: z.string() }),
  z.object({ status: z.literal('failed'), instanceId: z.string(), reason: z.string().max(2600), report: refSchema.optional() }),
  z.object({ status: z.literal('complete'), instanceId: z.string(), report: refSchema, state: refSchema }),
]);

export const archiveGateway = (prefixes: string[]) => async (request: Request, env: { ARCHIVE: R2Bucket }) => {
  const key = new URL(request.url).pathname.slice(1);
  const base = prefixes.find(prefix => key.startsWith(prefix + '/'));
  const match = base && /^(?:chunks\/([a-f0-9]{64})|(?:manifests|reports)\/([a-f0-9]{64})\.json)$/u.exec(key.slice(base.length + 1));
  if (!match) return new Response(null, { status: 404 });
  if (request.method === 'GET') {
    const object = await env.ARCHIVE.get(key);
    return object ? new Response(object.body, { headers: { 'Content-Length': String(object.size) } }) : new Response(null, { status: 404 });
  }
  if (request.method !== 'PUT') return new Response(null, { status: 405 });
  const bytes = Number(request.headers.get('Content-Length'));
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > chunkLimit) return new Response(null, { status: 413 });
  const body = new Uint8Array(await request.arrayBuffer());
  const sha256 = match[1] ?? match[2];
  if (!sha256 || body.length !== bytes || await textSha256(body) !== sha256) return new Response(null, { status: 422 });
  const object = await env.ARCHIVE.put(key, body, { sha256, onlyIf: { etagDoesNotMatch: '*' } });
  if (!object) await bytesFor(env.ARCHIVE, { key, sha256, bytes });
  return new Response(null, { status: object ? 201 : 200 });
};

function assertRef(ref: Ref, base: string, folder: 'manifests' | 'reports') {
  if (ref.key !== `${base}/${folder}/${ref.sha256}.json`) throw new Error('Unexpected workspace archive object key.');
  return ref;
}

export async function runArchiveRefresh<P extends { scheduledTime: number }>(
  step: WorkflowStep, bucket: R2Bucket, runtime: Runtime, params: P,
  config: { id: (params: P) => string; base: string; label: string; schema: z.ZodType<P>; report: z.ZodType;
    maxPolls?: number; containerInputs?: Record<string, unknown> },
) {
  const { base, label } = config;
  const instanceId = config.id(params);
  const receiptKey = `${base}/runs/${instanceId}.json`;
  const pointerSchema = z.intersection(config.schema, z.object({
    instanceId: z.string(), receiptKey: z.string(), status: z.enum(['complete', 'degraded']), state: refSchema.optional(),
  })).refine(row => row.instanceId === config.id(row) && row.receiptKey === `${base}/runs/${row.instanceId}.json` &&
    (row.status === 'complete') === Boolean(row.state));
  const pinned = await step.do(`pin the last verified ${label} workspace`, async () => {
    const previous = await bucket.get(`${base}/latest-complete.json`);
    if (previous) {
      const pointer = pointerSchema.parse(await previous.json());
      if (pointer.scheduledTime >= params.scheduledTime || !pointer.state) throw new Error('Occurrence does not follow the current publication.');
      return { state: assertRef(pointer.state, base, 'manifests'), etag: previous.etag };
    }
    const seed = await bucket.get(`${base}/bootstrap.json`);
    if (!seed) throw new Error('A verified bootstrap manifest is required.');
    return { state: assertRef(refSchema.parse(await seed.json()), base, 'manifests'), etag: null };
  });
  const inputState = pinned.state;
  const request = { ...config.containerInputs, ...params, instanceId, inputState };
  const start = async () => {
    const response = await runtime.fetch('http://runtime/start', { method: 'POST', body: JSON.stringify(request) });
    if (!response.ok) throw new Error(`${label} container returned HTTP ${response.status}.`);
  };
  await step.do(`start the ${label} acquisition container`, start);
  let result: Exclude<z.infer<typeof progress>, { status: 'empty' | 'running' }> | undefined;
  for (let poll = 0; poll < (config.maxPolls ?? 120); poll++) {
    if (poll) await step.sleep(`wait for the ${label} container ${poll}`, '20 seconds');
    const observation = await step.do(`inspect the ${label} container ${poll}`, async () => {
      const response = await runtime.fetch('http://runtime/status');
      if (!response.ok) throw new Error(`Could not read the ${label} container status.`);
      const status = progress.parse(await response.json());
      if (status.status === 'empty') await start();
      else if (status.instanceId !== instanceId) throw new Error(`The ${label} container reports a different occurrence.`);
      return status;
    });
    if (observation.status === 'complete' || observation.status === 'failed') {
      result = observation;
      break;
    }
  }
  await step.do(`release the ${label} acquisition container`, () => runtime.destroy());
  const outcome = result ?? { status: 'failed' as const, reason: `The ${label} refresh exceeded the observation window.`, report: undefined };
  const saved = await step.do(`verify the ${label} result and retain the occurrence receipt`, async () => {
    const common = { ...params, instanceId, receiptKey };
    const report = outcome.report && assertRef(outcome.report, base, 'reports');
    if (report) {
      const readback = JSON.parse(new TextDecoder().decode(await bytesFor(bucket, report)));
      if (outcome.status === 'complete') config.report.parse(readback);
    }
    if (outcome.status === 'failed') {
      const pointer = pointerSchema.parse({ ...common, status: 'degraded' });
      await immutableText(bucket, receiptKey, JSON.stringify({ schemaVersion: 1, ...pointer, inputState, reason: outcome.reason, report }), 'application/json');
      await advancePointer(bucket, `${base}/latest-attempt.json`, pointer, pointerSchema);
      return JSON.stringify({ ...pointer, report });
    }
    const state = assertRef(outcome.state, base, 'manifests');
    await bytesFor(bucket, state);
    const pointer = pointerSchema.parse({ ...common, state, status: 'complete' });
    await immutableText(bucket, receiptKey, JSON.stringify({ schemaVersion: 1, ...pointer, inputState, report }), 'application/json');
    const head = `${base}/latest-complete.json`;
    const body = JSON.stringify(pointer);
    const onlyIf = pinned.etag ? { etagMatches: pinned.etag } : { etagDoesNotMatch: '*' };
    if (!await bucket.put(head, body, { onlyIf, httpMetadata: { contentType: 'application/json' } }) &&
        await (await bucket.get(head))?.text() !== body) throw new Error('The verified publication changed during refresh.');
    await advancePointer(bucket, `${base}/latest-attempt.json`, pointer, pointerSchema);
    return JSON.stringify({ ...pointer, report });
  });
  return z.intersection(pointerSchema, z.object({ report: refSchema.optional() })).parse(JSON.parse(saved));
}
