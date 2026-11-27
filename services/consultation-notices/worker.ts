import { Container, getContainer } from '@cloudflare/containers';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { textSha256 } from '../../src/corpora/text-store';
import { archiveGateway, occurrence, runArchiveRefresh } from '../weekly-archive/refresh';

export { ContainerProxy } from '@cloudflare/containers';

const base = 'weekly/consultation-notices';
const schema = z.object({ scheduledTime: occurrence });
type Params = z.infer<typeof schema>;
interface Env {
  ARCHIVE: R2Bucket;
  CONSULTATIONS_ARCHIVE: Pick<R2Bucket, 'get' | 'head'>;
  CONSULTATIONS_DB: Pick<D1Database, 'prepare'>;
  RUNTIME: DurableObjectNamespace<ConsultationNoticesRuntime>;
  NOTICES: Workflow<Params>;
}

const instance = ({ scheduledTime }: Params) => `consultation-notices-${scheduledTime}`;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().positive();
const optionalCount = z.number().int().nonnegative().optional();
const gap = z.object({ consultationId: z.string().min(1), language: z.enum(['en', 'fr']), sourceUrl: z.string().min(1),
  outcome: z.enum(['fetch-error', 'http-error']), httpStatus: z.number().int().min(100).max(599).nullable() });
const gapKey = ({ consultationId, language, sourceUrl, outcome, httpStatus }: z.infer<typeof gap>) =>
  JSON.stringify([consultationId, language, sourceUrl, outcome, httpStatus]);
const catalogueSchema = z.object({ observedAt: z.iso.datetime(), revision: digest, rows: count,
  csvSha256: digest, schemaSha256: digest });
const receiptLimit = 16 * 1024;
const sourceSchema = (input: string, extension: string, limit: number) => z.object({
  input: z.literal(input), archivedAs: z.string(), bytes: count.max(limit), sha256: digest,
}).refine(source => source.archivedAs === `consultations/sources/${source.sha256}.${extension}`);
const titles = z.object({ en: z.string(), fr: z.string() });
const receiptSchema = z.object({ instanceId: z.string(), observedAt: z.iso.datetime(),
  sources: z.object({
    csv: sourceSchema('https://open.canada.ca/static/consultations_open.csv', 'csv', 16 * 1024 ** 2),
    schema: sourceSchema('https://open.canada.ca/data/recombinant-published-schema/consultations.json', 'json', 512 * 1024),
  }),
  published: z.object({ revision: digest, observedAt: z.iso.datetime(), rows: count,
    sampleId: z.string(), sampleTitles: titles }),
  lookup: z.object({ id: z.string(), titles }),
});

async function pinCatalogue(env: Env, scheduledTime: number) {
  const catalogue = catalogueSchema.parse(await env.CONSULTATIONS_DB.prepare(`SELECT observed_at AS observedAt,
    revision, record_count AS rows, csv_sha256 AS csvSha256, schema_sha256 AS schemaSha256
    FROM consultations_catalogues WHERE source='canada'`).first());
  const observed = Date.parse(catalogue.observedAt);
  const age = scheduledTime - observed;
  if (age < 0 || age > 26 * 60 * 60_000) throw new Error('Consultation catalogue is outside the expected daily publication window.');
  const id = `consultations-${observed}`;
  const key = `consultations/runs/${id}.json`;
  const object = await env.CONSULTATIONS_ARCHIVE.get(key);
  if (!object || object.size < 1 || object.size > receiptLimit) throw new Error('Missing or oversized verified consultation receipt.');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== object.size) throw new Error('Incomplete consultation receipt.');
  const receipt = receiptSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)));
  const { csv, schema: dictionary } = receipt.sources;
  if (receipt.instanceId !== id || receipt.observedAt !== catalogue.observedAt || receipt.published.observedAt !== catalogue.observedAt ||
    receipt.published.revision !== catalogue.revision || receipt.published.rows !== catalogue.rows ||
    csv.sha256 !== catalogue.csvSha256 || dictionary.sha256 !== catalogue.schemaSha256 ||
    receipt.lookup.id !== receipt.published.sampleId || receipt.lookup.titles.en !== receipt.published.sampleTitles.en ||
    receipt.lookup.titles.fr !== receipt.published.sampleTitles.fr) throw new Error('Consultation receipt differs from the published D1 catalogue.');
  for (const source of [csv, dictionary]) {
    const stored = await env.CONSULTATIONS_ARCHIVE.head(source.archivedAs);
    if (!stored || stored.size !== source.bytes) throw new Error('Missing or incomplete archived consultation source.');
  }
  return { ...catalogue, receipt: { key, bytes: bytes.length, sha256: await textSha256(bytes) }, sources: receipt.sources };
}

/** The container can read only dated receipts and immutable catalogue originals from this binding. */
async function consultationsGateway(request: Request, env: Env) {
  if (request.method !== 'GET') return new Response(null, { status: 405 });
  const key = new URL(request.url).pathname.slice(1);
  if (!/^consultations\/(?:runs\/consultations-[1-9][0-9]{0,15}\.json|sources\/[a-f0-9]{64}\.(?:csv|json))$/u.test(key)) {
    return new Response(null, { status: 404 });
  }
  const object = await env.CONSULTATIONS_ARCHIVE.get(key);
  return object ? new Response(object.body, { headers: { 'Content-Length': String(object.size) } }) : new Response(null, { status: 404 });
}

export class ConsultationNoticesRuntime extends Container<Env> {
  defaultPort = 8080;
  pingEndpoint = 'localhost/health';
  sleepAfter = '10m';
  enableInternet = true;
}
ConsultationNoticesRuntime.outboundByHost = {
  'archive.consultation-notices.internal': archiveGateway([base]),
  'inputs.consultation-notices.internal': consultationsGateway,
};

export class ConsultationNoticesRefresh extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const params = schema.strict().parse(event.payload);
    const id = instance(params);
    if (event.instanceId !== id) throw new Error('Unexpected consultation notices occurrence.');
    const catalogue = await step.do('pin the verified consultations publication', {
      retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
    }, () => pinCatalogue(this.env, params.scheduledTime));
    return runArchiveRefresh(step, this.env.ARCHIVE, getContainer(this.env.RUNTIME, id), params, {
      id: instance, base, label: 'consultation notices', schema, maxPolls: 360, containerInputs: { catalogue },
      report: z.object({ complete: z.literal(true), servingTestsPassed: z.literal(1),
        publisherCoverage: z.enum(['complete', 'degraded']),
        baseline: z.object({ receiptSha256: digest, catalogueRevision: digest, catalogueObservedAt: z.iso.datetime(),
          knownGaps: gap.array(), verifiedEditions: z.number().int().nonnegative() }),
        failures: gap.extend({ detail: z.string().nullable() }).array(),
        novelFailures: z.never().array(), regressedEditions: z.never().array(),
        catalogue: z.object({ revision: z.literal(catalogue.revision), observedAt: z.literal(catalogue.observedAt),
          receipt: z.object({ key: z.literal(catalogue.receipt.key), sha256: z.literal(catalogue.receipt.sha256) }) }),
        notices: z.object({ catalogueRevision: z.literal(catalogue.revision),
          catalogueObservedAt: z.literal(catalogue.observedAt), scope: z.literal('all-open'),
          editions: z.number().int().nonnegative(),
          counts: z.object({ 'fetch-error': optionalCount, 'http-error': optionalCount, 'archive-budget': z.literal(0).optional() }) }),
      }).refine(report => {
        const known = new Set(report.baseline.knownGaps.map(gapKey));
        const outcomes = ['fetch-error', 'http-error'] as const;
        return ((report.publisherCoverage === 'degraded') === (report.failures.length > 0)) &&
          report.failures.every(failure => known.has(gapKey(failure))) &&
          outcomes.every(outcome => (report.notices.counts[outcome] ?? 0) ===
            report.failures.filter(failure => failure.outcome === outcome).length);
      }),
    });
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env) {
    const params = { scheduledTime: Math.floor(event.scheduledTime / 60_000) * 60_000 };
    const id = instance(params);
    try {
      await env.NOTICES.create({ id, params });
    } catch (error) {
      const { status } = await (await env.NOTICES.get(id)).status();
      if (!['queued', 'running', 'waiting', 'complete'].includes(status)) throw error;
    }
  },
};
