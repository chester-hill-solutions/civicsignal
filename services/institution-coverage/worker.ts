import { Container, getContainer } from '@cloudflare/containers';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { advancePointer, bytesFor, encode, immutableText } from '../federal-register/inventory';
import { textSha256 } from '../../src/corpora/text-store';

export { ContainerProxy } from '@cloudflare/containers';

const prefix = 'weekly/institution-coverage';
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const occurrence = z.number().int().positive().lt(4102444800000);
const archiveLimit = 16 * 1024 ** 2;
const inputSeries = ['official-titles', 'service-inventory'] as const;
const ref = z.strictObject({ key: z.string(), sha256: digest, bytes: z.number().int().positive().max(archiveLimit) });
const mode = z.enum(['replay', 'refresh']);
const retrySourceName = z.literal('federal-regulatory-plans');
const stateRef = ref.refine(value => value.bytes <= 2 * 1024 ** 2 && value.key === `${prefix}/manifests/${value.sha256}.json`);
const idSchema = z.string().regex(/^institution-coverage-[1-9][0-9]{0,15}$/);
const runPointer = z.strictObject({ instanceId: idSchema, scheduledTime: occurrence, receiptKey: z.string(),
  status: z.enum(['complete', 'degraded', 'replay']) }).refine(value =>
  value.instanceId === `institution-coverage-${value.scheduledTime}` && value.receiptKey === `${prefix}/runs/${value.instanceId}.json`);
const publishedState = z.strictObject({ instanceId: idSchema, scheduledTime: occurrence, receiptKey: z.string(),
  status: z.literal('state'), state: stateRef }).refine(value =>
  value.instanceId === `institution-coverage-${value.scheduledTime}` && value.receiptKey === `${prefix}/runs/${value.instanceId}.json`);
const upstreamPointer = z.strictObject({ instanceId: z.string(), scheduledTime: occurrence, receiptKey: z.string(), status: z.literal('complete') });
const servingChecks = new Map([['eccc', 2], ['geds', 1]]);
const attemptSchema = z.strictObject({ source: z.string(), exitCodes: z.number().int().array().min(1), ok: z.boolean(),
  elapsedSeconds: z.number().nonnegative(), diagnostic: z.string().max(3000).optional(),
  servingTestsPassed: z.number().int().min(0).max(2).optional() }).refine(value =>
    value.ok === (value.exitCodes.every(code => code === 0) && value.servingTestsPassed === servingChecks.get(value.source))
    && value.ok === (value.diagnostic === undefined));
const result = z.strictObject({ instanceId: idSchema, mode, report: ref, state: stateRef,
  attempts: attemptSchema.array(), servingReplay: z.strictObject({ eccc: z.literal(2), geds: z.literal(1) }).optional(),
  sources: z.number().int().positive(), registeredSeries: z.number().int().positive(),
  namesWithRecords: z.number().int().positive(), provisionalNames: z.number().int().positive() });
const status = z.discriminatedUnion('status', [
  z.object({ status: z.literal('empty') }),
  z.object({ status: z.literal('running'), instanceId: idSchema, phase: z.string().optional(),
    source: z.string().nullable().optional(), attempted: z.number().int().nonnegative().optional() }),
  z.object({ status: z.literal('failed'), instanceId: idSchema, reason: z.string().max(6400) }),
  z.object({ status: z.literal('complete'), instanceId: idSchema, result }),
]);

type Params = { scheduledTime: number; mode: z.infer<typeof mode>; state?: z.infer<typeof stateRef>;
  checkServing?: true; retrySource?: z.infer<typeof retrySourceName> };

function checkProducerResults(
  request: Pick<Params, 'mode' | 'checkServing' | 'retrySource'> & { state: z.infer<typeof stateRef> },
  { attempts, state, servingReplay }: z.infer<typeof result>,
) {
  if (request.mode === 'refresh' && (!attempts.length || new Set(attempts.map(attempt => attempt.source)).size !== attempts.length)) {
    throw new Error('Missing or duplicate source acquisition results.');
  }
  if (request.mode === 'replay' && (request.retrySource
    ? attempts.length !== 1 || attempts[0].source !== request.retrySource
    : attempts.length !== 0 || state.sha256 !== request.state.sha256)) {
    throw new Error('Unexpected source or state in coverage replay.');
  }
  if (Boolean(servingReplay) !== Boolean(request.checkServing)) throw new Error('Unexpected coverage serving replay result.');
}

interface Env {
  ARCHIVE: R2Bucket;
  CONSULTATIONS_DB: D1Database;
  RUNTIME: DurableObjectNamespace<CoverageRuntime>;
  COVERAGE: Workflow<Params>;
}

function readable(key: string) {
  return /^weekly\/(?:institution-coverage|official-titles|service-inventory|federal-discovery)\/[A-Za-z0-9/_\-.]+$/.test(key) &&
    !key.split('/').some(segment => !segment || segment === '.' || segment === '..');
}

async function archiveGateway(request: Request, env: Env): Promise<Response> {
  const key = new URL(request.url).pathname.slice(1);
  if (!readable(key)) return new Response(null, { status: 404 });
  if (request.method === 'GET') {
    const object = await env.ARCHIVE.get(key);
    return object ? new Response(object.body, { headers: { 'Content-Length': String(object.size) } }) : new Response(null, { status: 404 });
  }
  const match = /^weekly\/institution-coverage\/(?:chunks|manifests|reports)\/([0-9a-f]{64})(?:\.json)?$/.exec(key);
  if (request.method !== 'PUT' || !match) return new Response(null, { status: 405 });
  const expected = Number(request.headers.get('Content-Length'));
  if (!Number.isInteger(expected) || expected <= 0 || expected > archiveLimit) return new Response(null, { status: 413 });
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength !== expected || await textSha256(body) !== match[1]) return new Response(null, { status: 422 });
  const saved = await env.ARCHIVE.put(key, body, { sha256: match[1], onlyIf: { etagDoesNotMatch: '*' } });
  if (!saved) await bytesFor(env.ARCHIVE, { key, sha256: match[1], bytes: expected });
  return new Response(null, { status: saved ? 201 : 200 });
}

export class CoverageRuntime extends Container<Env> {
  defaultPort = 8080;
  pingEndpoint = 'localhost/health';
  sleepAfter = '15m';
  enableInternet = true;
}
CoverageRuntime.outboundByHost = { 'objects.coverage.internal': archiveGateway };

async function selectState(bucket: R2Bucket, supplied?: Params['state']) {
  if (supplied) return stateRef.parse(supplied);
  const last = await bucket.get(`${prefix}/state-latest.json`);
  if (last) return publishedState.parse(await last.json()).state;
  const bootstrap = await bucket.get(`${prefix}/bootstrap.json`);
  if (!bootstrap) throw new Error('An immutable coverage bootstrap has not been registered.');
  return stateRef.parse(await bootstrap.json());
}

async function selectUpstream(bucket: R2Bucket, series: string) {
  const head = await bucket.get(`weekly/${series}/latest-complete.json`);
  if (!head) throw new Error(`Missing verified ${series} publication.`);
  const pointer = upstreamPointer.parse(await head.json());
  if (pointer.instanceId !== `federal-discovery-${pointer.scheduledTime}` ||
      pointer.receiptKey !== `weekly/${series}/runs/${pointer.instanceId}.json`) throw new Error(`Invalid ${series} publication pointer.`);
  return pointer;
}

async function consultationOwners(db: D1Database) {
  const row = z.object({ observedAt: z.iso.datetime(), csvSha256: digest, recordCount: z.number().int().positive(),
    en: z.string(), fr: z.string(), rows: z.number().int().positive() });
  const selected = await db.prepare(`SELECT c.observed_at AS observedAt, c.csv_sha256 AS csvSha256,
      c.record_count AS recordCount, json_extract(i.facts_json, '$.institution.en') AS en,
      json_extract(i.facts_json, '$.institution.fr') AS fr, count(*) AS rows
    FROM consultations_catalogues c CROSS JOIN consultation_items i
    WHERE c.source = 'canada' AND i.removed_at IS NULL GROUP BY en, fr ORDER BY en, fr`).all();
  const owners = row.array().min(1).parse(selected.results);
  const { observedAt, csvSha256, recordCount } = owners[0];
  if (owners.reduce((sum, item) => sum + item.rows, 0) !== recordCount) throw new Error('Consultations owner count differs from D1 publication.');
  return { schemaVersion: 1, observedAt, csvSha256, owners: owners.map(({ en, fr, rows }) => ({ en, fr, rows })) };
}

export class InstitutionCoverage extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { instanceId, payload } = event;
    const scheduledTime = occurrence.parse(payload.scheduledTime);
    const executionMode = mode.parse(payload.mode);
    const checkServing = z.literal(true).optional().parse(payload.checkServing);
    const retrySource = retrySourceName.optional().parse(payload.retrySource);
    if (instanceId !== `institution-coverage-${scheduledTime}`) throw new Error('Unexpected coverage occurrence.');
    if ((checkServing || retrySource) && (executionMode !== 'replay' || !payload.state)) {
      throw new Error('A serving check or source retry requires a pinned replay workspace.');
    }
    const request = await step.do('pin the archived workspace and hosted input publications', async () => {
      const state = await selectState(this.env.ARCHIVE, payload.state);
      const pointers = await Promise.all(inputSeries.map(series => selectUpstream(this.env.ARCHIVE, series)));
      const discovery = await selectUpstream(this.env.ARCHIVE, 'federal-discovery');
      const object = await this.env.ARCHIVE.get(discovery.receiptKey);
      if (!object || object.size > 8192) throw new Error('Missing or oversized discovery run receipt.');
      const bytes = new Uint8Array(await object.arrayBuffer());
      const consultations = await consultationOwners(this.env.CONSULTATIONS_DB);
      const projectionBody = JSON.stringify(consultations);
      const projectionBytes = encode(projectionBody);
      const projectionDigest = await textSha256(projectionBytes);
      const projection = { key: `${prefix}/consultations/${projectionDigest}.json`, sha256: projectionDigest, bytes: projectionBytes.length };
      await immutableText(this.env.ARCHIVE, projection.key, projectionBody, 'application/json');
      const day = (time: number) => new Date(time).toISOString().slice(0, 10);
      const consultationsTime = Date.parse(consultations.observedAt);
      const inputFreshness = {
        weekly: discovery.scheduledTime <= scheduledTime && day(discovery.scheduledTime) === day(scheduledTime) &&
          pointers.every(pointer => pointer.scheduledTime === discovery.scheduledTime),
        consultations: consultationsTime <= scheduledTime && day(consultationsTime) === day(scheduledTime),
      };
      return { instanceId, mode: executionMode, state, ...(checkServing ? { checkServing } : {}),
        ...(retrySource ? { retrySource } : {}),
        inputs: { 'official-titles': pointers[0], 'service-inventory': pointers[1] },
        discovery: { key: discovery.receiptKey, sha256: await textSha256(bytes), bytes: bytes.length },
        consultations, projection, inputFreshness };
    });
    const runtime = getContainer(this.env.RUNTIME, instanceId);
    const start = async () => {
      const health = await runtime.fetch('http://runtime/health');
      const details = z.object({ ready: z.literal(true), extractor: z.string() }).safeParse(await health.json());
      if (!health.ok || !details.success || details.data.extractor !== 'pdftotext version 26.01.0') {
        throw new Error('Coverage container is not serving the exact PDF extractor.');
      }
      const response = await runtime.fetch(new Request('http://runtime/start', { method: 'POST', body: JSON.stringify(request) }));
      if (!response.ok) throw new Error(`Coverage container start returned HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    };
    await step.do('start the private Linux coverage container', start);
    let finished: z.infer<typeof result> | undefined;
    for (let poll = 0; poll < 320; poll++) {
      if (poll) await step.sleep(`wait for coverage container ${poll}`, '45 seconds');
      const progress = await step.do(`observe coverage container ${poll}`, async () => {
        const response = await runtime.fetch(new Request('http://runtime/status'));
        if (!response.ok) throw new Error('Cannot read the coverage container status.');
        const progress = status.parse(await response.json());
        if (progress.status === 'empty') await start();
        return progress;
      });
      if (progress.status === 'failed') {
        await step.do('release the failed coverage container', () => runtime.destroy());
        throw new Error(`Coverage container failed: ${progress.reason}`);
      }
      if (progress.status === 'complete') {
        finished = progress.result;
        break;
      }
    }
    await step.do('release the private Linux coverage container', () => runtime.destroy());
    if (!finished || finished.instanceId !== instanceId || finished.mode !== executionMode) throw new Error('No verified result for the coverage occurrence.');
    const published = finished;
    return step.do('verify and publish the institution coverage report', async () => {
      const { report, state, attempts } = published;
      if (report.key !== `${prefix}/reports/${report.sha256}.json`) throw new Error('Unexpected coverage report object key.');
      const reportData = z.object({ sources: z.record(z.string(), z.unknown()), registeredSeriesSummary: z.record(z.string(), z.unknown()),
        provisionalNames: z.number(), namesWithRecords: z.number() });
      const readback = reportData.parse(JSON.parse(new TextDecoder().decode(await bytesFor(this.env.ARCHIVE, report))));
      if (Object.keys(readback.sources).length !== published.sources || Object.keys(readback.registeredSeriesSummary).length !== published.registeredSeries ||
          readback.namesWithRecords !== published.namesWithRecords || readback.provisionalNames !== published.provisionalNames) {
        throw new Error('Coverage report counters differ from the verified output.');
      }
      const stateBytes = await bytesFor(this.env.ARCHIVE, state);
      const stateManifest = z.object({ schemaVersion: z.literal(1), roots: z.string().array().min(1) });
      stateManifest.parse(JSON.parse(new TextDecoder().decode(stateBytes)));
      await bytesFor(this.env.ARCHIVE, request.projection);
      checkProducerResults(request, published);
      const complete = request.inputFreshness.weekly && request.inputFreshness.consultations && attempts.every(attempt => attempt.ok);
      const runStatus = executionMode === 'replay' ? 'replay' : complete ? 'complete' : 'degraded';
      const receiptKey = `${prefix}/runs/${instanceId}.json`;
      const pointer = runPointer.parse({ instanceId, scheduledTime, receiptKey, status: runStatus });
      await immutableText(this.env.ARCHIVE, receiptKey, JSON.stringify({ schemaVersion: 1, ...pointer, ...published,
        inputState: request.state, inputs: request.inputs, discovery: request.discovery, inputFreshness: request.inputFreshness,
        consultations: { observedAt: request.consultations.observedAt, csvSha256: request.consultations.csvSha256, projection: request.projection },
      }), 'application/json');
      if (runStatus !== 'replay') {
        await advancePointer(this.env.ARCHIVE, `${prefix}/state-latest.json`,
          publishedState.parse({ instanceId, scheduledTime, receiptKey, status: 'state', state }), publishedState);
      }
      if (runStatus === 'complete') await advancePointer(this.env.ARCHIVE, `${prefix}/latest-complete.json`, pointer, runPointer);
      if (runStatus !== 'replay') await advancePointer(this.env.ARCHIVE, `${prefix}/latest-attempt.json`, pointer, runPointer);
      return { receiptKey, status: runStatus, report, sources: published.sources, registeredSeries: published.registeredSeries };
    });
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env) {
    const scheduledTime = event.scheduledTime;
    const id = `institution-coverage-${scheduledTime}`;
    try {
      await env.COVERAGE.create({ id, params: { scheduledTime, mode: 'refresh' } });
    } catch (error) {
      const { status } = await (await env.COVERAGE.get(id)).status();
      if (!['queued', 'running', 'waiting', 'complete'].includes(status)) throw error;
    }
  },
};
