import { z } from 'zod';
import { textSha256 } from '../../src/corpora/text-store';
import { parseCsvText } from '../../src/csv';
import { advancePointer, bytesFor, immutableText, packetRef, Pointer, prefix as discoveryPrefix, readInventory, refSchema } from './inventory';

const prefix = 'weekly/official-titles';
const sourceLimit = 512 * 1024;
const titlesDataset = '83320390-7715-43bc-a281-2049bf5d4232';
const required = ['Legal title', 'Appellation légale', 'Applied title', "Titre d'usage"];
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const titlesReceiptKey = (id: string) => `${prefix}/runs/${id}.json`;
const titlesPointer = z.strictObject({
  instanceId: z.string(), scheduledTime: z.number().int().positive().lt(4102444800000),
  receiptKey: z.string(), status: z.enum(['complete', 'failed', 'skipped']),
}).refine(row => row.instanceId === `federal-discovery-${row.scheduledTime}` && row.receiptKey === titlesReceiptKey(row.instanceId));
const discoveryReceipt = z.object({
  schemaVersion: z.literal(1), instanceId: z.string(), scheduledTime: z.number(), status: z.enum(['complete', 'partial']),
  receiptKey: z.string(), packetRef: refSchema,
});
const collectorResult = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('complete'), source: refSchema, records: refSchema, rows: z.number().int().positive(),
    finalUrl: z.url(), lastModified: z.string().max(128).nullable() }),
  z.strictObject({ status: z.literal('failed'), code: z.string().regex(/^[a-z0-9-]{1,60}$/),
    httpStatus: z.number().int().min(100).max(599).nullable() }),
]);
type CollectorResult = z.infer<typeof collectorResult>;
type Resource = { datasetId: string; resourceId: string; url: string };

function officialResource(datasetId: string, resourceId: string, url: string): Resource | undefined {
  const base = `https://open.canada.ca/data/dataset/${datasetId}/resource/${resourceId}/download/`;
  if (datasetId !== titlesDataset || !uuid.test(resourceId) || url.length > 2048 || !url.startsWith(base)) return;
  const filename = url.slice(base.length);
  if (!/^[^\s/?#\\]+\.csv$/i.test(filename)) return;
  try {
    if (/[/?#\\]/.test(decodeURIComponent(filename))) return;
  } catch {
    return;
  }
  return { datasetId, resourceId, url };
}

export async function prepareTitles(bucket: R2Bucket, binding: Pointer, inventoryRef: z.infer<typeof refSchema>) {
  const object = await bucket.get(binding.receiptKey);
  if (!object || object.size <= 0 || object.size > 8192) throw new Error('Missing or oversized discovery receipt for official titles.');
  const raw = new Uint8Array(await object.arrayBuffer());
  const published = discoveryReceipt.parse(JSON.parse(decoder.decode(raw)));
  const { schemaVersion: _schema, packetRef: rawPacketRef, ...pointer } = published;
  const ref = packetRef(rawPacketRef);
  const selected = Pointer.parse(pointer);
  if (selected.instanceId !== binding.instanceId || selected.status !== binding.status || selected.receiptKey !== binding.receiptKey ||
      ref.sha256 !== inventoryRef.sha256 || ref.key !== inventoryRef.key || ref.bytes !== inventoryRef.bytes || raw.length !== object.size) {
    throw new Error('Official titles discovery receipt differs from the verified occurrence.');
  }
  const discovery = { key: binding.receiptKey, sha256: await textSha256(raw), bytes: raw.length };
  const dependency = { discovery, packetRef: ref };
  const inventory = await readInventory(bucket, ref);
  if (inventory.scheduledTime !== binding.scheduledTime || binding.receiptKey !== `${discoveryPrefix}/runs/${binding.instanceId}.json`) {
    throw new Error('Official titles discovery packet differs from its occurrence.');
  }
  const title = inventory.endpoints.find(item => item.series === 'official-titles' && item.endpoint === 'entry_url');
  if (!title?.ok) return { ...dependency, status: 'skipped', code: 'titles-catalogue-unavailable' } as const;
  if (title.inventory.kind === 'dataset-resources') {
    const csvs = title.inventory.resources.filter(item => typeof item.format === 'string' && item.format.toUpperCase() === 'CSV');
    const [csv] = csvs;
    const datasetId = new URL(title.url).searchParams.get('id') ?? '';
    const resource = csvs.length === 1 && officialResource(datasetId, csv.id, csv.url);
    if (resource) return { ...dependency, resource };
  }
  return { ...dependency, status: 'failed', code: 'invalid-titles-resource' } as const;
}

export async function acquireTitles(collector: Pick<Fetcher, 'fetch'>, resource: Resource): Promise<CollectorResult> {
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
