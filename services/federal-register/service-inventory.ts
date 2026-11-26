import { z } from 'zod';
import { acquisitionFailure, bulkPointer, prepareBulkResources, type CsvResource } from './bulk-source';
import { advancePointer, immutableText, refSchema, type ObjectRef, type Pointer } from './inventory';

const prefix = 'weekly/service-inventory';
const dataset = '3ac0d080-6149-499a-8b06-7ce5f00ec56c';
const required = ['service_id', 'fiscal_yr', 'service_name_en', 'service_name_fr'];
const pointerSchema = bulkPointer(prefix);
const success = z.strictObject({ status: z.literal('complete'), source: refSchema.extend({ bytes: z.number().int().positive().max(24 * 1024 * 1024) }),
  rows: z.number().int().positive(), fields: z.string().min(1).array().min(4).max(128),
  finalUrl: z.url(), lastModified: z.string().max(128).nullable() });
const resultSchema = z.discriminatedUnion('status', [success, acquisitionFailure]);
type ServiceResult = z.infer<typeof resultSchema>;
const checkpointSchema = z.strictObject({ schemaVersion: z.literal(1), scheduledTime: z.number().int(), datasetId: z.string(),
  resourceId: z.string(), url: z.string(), result: success });

export function prepareServiceInventory(bucket: R2Bucket, binding: Pointer, ref: ObjectRef) {
  return prepareBulkResources(bucket, binding, ref, 'service-inventory', dataset);
}

export function serviceResources(prepared: Awaited<ReturnType<typeof prepareServiceInventory>>) {
  return prepared.state === 'ready' && prepared.resources.length <= 12 ? prepared.resources : [];
}

export async function acquireServiceResource(collector: Pick<Fetcher, 'fetch'>, scheduledTime: number, resource: CsvResource) {
  const response = await collector.fetch('https://collector.internal/service-inventory', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...resource, scheduledTime }),
  });
  if (!response.ok) throw new Error(`GC Service Inventory collector returned HTTP ${response.status}.`);
  return resultSchema.parse(await response.json());
}

async function verifyServiceResource(bucket: R2Bucket, scheduledTime: number, resource: CsvResource, result: z.infer<typeof success>) {
  const { source, fields } = result;
  if (source.key !== `${prefix}/sources/${source.sha256}.csv` || new Set(fields).size !== fields.length ||
      !required.every(field => fields.includes(field))) throw new Error('Invalid GC Service Inventory archive reference or fields.');
  const checkpoint = await bucket.get(`${prefix}/checkpoints/${scheduledTime}/${resource.resourceId}.json`);
  if (!checkpoint || checkpoint.size > 32 * 1024) throw new Error('Missing or oversized GC Service Inventory checkpoint.');
  const pin = checkpointSchema.parse(await checkpoint.json());
  if (pin.scheduledTime !== scheduledTime || pin.datasetId !== resource.datasetId || pin.resourceId !== resource.resourceId ||
      pin.url !== resource.url || JSON.stringify(pin.result) !== JSON.stringify(result)) {
    throw new Error('GC Service Inventory checkpoint differs from the acquisition.');
  }
  const head = await bucket.head(source.key);
  const checksum = head?.checksums.sha256;
  if (head?.size !== source.bytes || !checksum || Buffer.from(checksum).toString('hex') !== source.sha256) {
    throw new Error('GC Service Inventory R2 size or upload checksum differs from the acquisition.');
  }
}

export type ServiceAttempt = { resource: CsvResource; result: ServiceResult };

export async function publishServiceInventory(bucket: R2Bucket, binding: Pointer,
  prepared: Awaited<ReturnType<typeof prepareServiceInventory>>, results: ServiceAttempt[]) {
  const { instanceId, scheduledTime } = binding;
  const receiptKey = `${prefix}/runs/${instanceId}.json`;
  const expected = serviceResources(prepared);
  if (results.length !== expected.length) throw new Error('GC Service Inventory acquisition did not cover its selected resources.');
  const counts = { resources: results.length, verified: 0, failed: 0, rows: 0, originalBytes: 0 };
  for (const [index, { resource, result }] of results.entries()) {
    if (resource.resourceId !== expected[index].resourceId || resource.url !== expected[index].url || resource.datasetId !== expected[index].datasetId) {
      throw new Error('GC Service Inventory resource differs from its verified register selection.');
    }
    if (result.status === 'failed') {
      counts.failed++;
      continue;
    }
    await verifyServiceResource(bucket, scheduledTime, resource, result);
    counts.verified++;
    counts.rows += result.rows;
    counts.originalBytes += result.source.bytes;
  }
  const status = prepared.state === 'unavailable' ? 'skipped' : !results.length || counts.failed ? 'failed' : 'complete';
  const code = status === 'skipped' ? 'service-catalogue-unavailable' : !results.length ? 'invalid-service-resources' : undefined;
  const pointer = pointerSchema.parse({ instanceId, scheduledTime, receiptKey, status });
  await immutableText(bucket, receiptKey, JSON.stringify({ schemaVersion: 1, ...pointer, code,
    discovery: prepared.discovery, packetRef: prepared.packetRef, counts,
    resources: results.map(({ resource, result }) => ({ resource, ...result })),
  }), 'application/json');
  if (status === 'complete') await advancePointer(bucket, `${prefix}/latest-complete.json`, pointer, pointerSchema);
  await advancePointer(bucket, `${prefix}/latest-attempt.json`, pointer, pointerSchema);
  return { receiptKey, status, counts };
}
