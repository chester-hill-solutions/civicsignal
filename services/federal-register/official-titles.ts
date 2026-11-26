import { z } from 'zod';
import { parseCsvText } from '../../src/csv';
import { acquisitionFailure, bulkPointer, prepareBulkResources, type CsvResource } from './bulk-source';
import { advancePointer, bytesFor, immutableText, type Pointer, refSchema } from './inventory';

const prefix = 'weekly/official-titles';
const sourceLimit = 512 * 1024;
const titlesDataset = '83320390-7715-43bc-a281-2049bf5d4232';
const required = ['Legal title', 'Appellation légale', 'Applied title', "Titre d'usage"];
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const titlesReceiptKey = (id: string) => `${prefix}/runs/${id}.json`;
const titlesPointer = bulkPointer(prefix);
const collectorResult = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('complete'), source: refSchema, records: refSchema, rows: z.number().int().positive(),
    finalUrl: z.url(), lastModified: z.string().max(128).nullable() }),
  acquisitionFailure,
]);
type CollectorResult = z.infer<typeof collectorResult>;

export async function prepareTitles(bucket: R2Bucket, binding: Pointer, inventoryRef: z.infer<typeof refSchema>) {
  const prepared = await prepareBulkResources(bucket, binding, inventoryRef, 'official-titles', titlesDataset);
  const dependency = { discovery: prepared.discovery, packetRef: prepared.packetRef };
  if (prepared.state === 'unavailable') return { ...dependency, status: 'skipped', code: 'titles-catalogue-unavailable' } as const;
  if (prepared.state === 'ready' && prepared.resources.length === 1) return { ...dependency, resource: prepared.resources[0] };
  return { ...dependency, status: 'failed', code: 'invalid-titles-resource' } as const;
}

export async function acquireTitles(collector: Pick<Fetcher, 'fetch'>, resource: CsvResource): Promise<CollectorResult> {
  const response = await collector.fetch('https://collector.internal/official-titles', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(resource),
  });
  if (!response.ok) throw new Error(`Official titles collector returned HTTP ${response.status}.`);
  return collectorResult.parse(await response.json());
}

async function verifyTitles(bucket: R2Bucket, result: Extract<CollectorResult, { status: 'complete' }>) {
  const { source, records, rows: count } = result;
  if (source.key !== `${prefix}/sources/${source.sha256}.csv` || source.bytes > sourceLimit ||
      records.key !== `${prefix}/records/${records.sha256}.json` || records.bytes > 4 * sourceLimit) {
    throw new Error('Invalid official titles archive references.');
  }
  const [csv, normalized] = await Promise.all([bytesFor(bucket, source), bytesFor(bucket, records)]);
  const [fields, ...rows] = parseCsvText(decoder.decode(csv));
  const data: unknown = JSON.parse(decoder.decode(normalized));
  if (!fields || new Set(fields).size !== fields.length || !fields.every(Boolean) || !required.every(name => fields.includes(name)) ||
      count !== rows.length || !rows.every(row => row.length === fields.length)) {
    throw new Error('Official titles row counts or published fields differ from the archive.');
  }
  const parsed = z.strictObject({ schemaVersion: z.literal(1), fields: z.string().array(), rows: z.string().array().array() }).parse(data);
  if (JSON.stringify(parsed.fields) !== JSON.stringify(fields) || JSON.stringify(parsed.rows) !== JSON.stringify(rows)) {
    throw new Error('Official titles normalized data differs from the source rows.');
  }
}

type Prepared = Awaited<ReturnType<typeof prepareTitles>>;

export async function publishTitles(bucket: R2Bucket, binding: Pointer, prepared: Prepared, result?: CollectorResult) {
  const { instanceId, scheduledTime } = binding;
  const receiptKey = titlesReceiptKey(instanceId);
  const { discovery, packetRef: pinned } = prepared;
  const resource = 'resource' in prepared ? prepared.resource : undefined;
  const attempted = result ?? ('status' in prepared ? { status: prepared.status, code: prepared.code, httpStatus: null } : undefined);
  if (!attempted) throw new Error('Official titles acquisition produced no result.');
  const pointer = titlesPointer.parse({ instanceId, scheduledTime, receiptKey, status: attempted.status });
  if (attempted.status === 'complete') await verifyTitles(bucket, attempted);
  await immutableText(bucket, receiptKey, JSON.stringify({ schemaVersion: 1, ...pointer, discovery, packetRef: pinned, resource, ...attempted }),
    'application/json');
  if (pointer.status === 'complete') await advancePointer(bucket, `${prefix}/latest-complete.json`, pointer, titlesPointer);
  await advancePointer(bucket, `${prefix}/latest-attempt.json`, pointer, titlesPointer);
  return { receiptKey, status: pointer.status, ...(attempted.status === 'complete' ? { rows: attempted.rows } : {}) };
}
