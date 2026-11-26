import { z } from 'zod';
import { textSha256 } from '../../src/corpora/text-store';
import { packetRef, Pointer, readInventory, refSchema, type ObjectRef } from './inventory';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const discoveryReceipt = z.object({
  schemaVersion: z.literal(1), instanceId: z.string(), scheduledTime: z.number(), status: z.enum(['complete', 'partial']),
  receiptKey: z.string(), packetRef: refSchema,
});

export type CsvResource = { datasetId: string; resourceId: string; url: string };

export function bulkPointer(prefix: string) {
  return z.strictObject({
    instanceId: z.string(), scheduledTime: z.number().int().positive().lt(4102444800000),
    receiptKey: z.string(), status: z.enum(['complete', 'failed', 'skipped']),
  }).refine(row => row.instanceId === `federal-discovery-${row.scheduledTime}` && row.receiptKey === `${prefix}/runs/${row.instanceId}.json`);
}

export const acquisitionFailure = z.strictObject({ status: z.literal('failed'), code: z.string().regex(/^[a-z0-9-]{1,60}$/),
  httpStatus: z.number().int().min(100).max(599).nullable() });

function officialResource(datasetId: string, resourceId: string, url: string): CsvResource | undefined {
  const base = `https://open.canada.ca/data/dataset/${datasetId}/resource/${resourceId}/download/`;
  if (!uuid.test(resourceId) || url.length > 2048 || !url.startsWith(base)) return;
  const filename = url.slice(base.length);
  if (!/^[^\s/?#\\]+\.csv$/i.test(filename)) return;
  try {
    const decoded = decodeURIComponent(filename);
    if (/[/?#\\]/.test(decoded) || Array.from(decoded).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return;
  } catch {
    return;
  }
  return { datasetId, resourceId, url };
}

export async function prepareBulkResources(bucket: R2Bucket, binding: Pointer, inventoryRef: ObjectRef, series: string, datasetId: string) {
  const object = await bucket.get(binding.receiptKey);
  if (!object || object.size <= 0 || object.size > 8192) throw new Error('Missing or oversized federal discovery receipt.');
  const raw = new Uint8Array(await object.arrayBuffer());
  const published = discoveryReceipt.parse(JSON.parse(decoder.decode(raw)));
  const { schemaVersion: _schema, packetRef: rawPacketRef, ...pointer } = published;
  const ref = packetRef(rawPacketRef);
  const selected = Pointer.parse(pointer);
  if (selected.instanceId !== binding.instanceId || selected.status !== binding.status || selected.receiptKey !== binding.receiptKey ||
      ref.sha256 !== inventoryRef.sha256 || ref.key !== inventoryRef.key || ref.bytes !== inventoryRef.bytes || raw.length !== object.size) {
    throw new Error('Bulk input discovery receipt differs from the verified occurrence.');
  }
  const dependency = { discovery: { key: binding.receiptKey, sha256: await textSha256(raw), bytes: raw.length }, packetRef: ref };
  const inventory = await readInventory(bucket, ref);
  if (inventory.scheduledTime !== binding.scheduledTime) throw new Error('Bulk input discovery packet differs from its occurrence.');

  const entry = inventory.endpoints.find(item => item.series === series && item.endpoint === 'entry_url');
  if (!entry?.ok) return { ...dependency, state: 'unavailable' } as const;
  if (entry.inventory.kind !== 'dataset-resources' || new URL(entry.url).searchParams.get('id') !== datasetId) {
    return { ...dependency, state: 'invalid' } as const;
  }
  const csvs = entry.inventory.resources.filter(item => typeof item.format === 'string' && item.format.toUpperCase() === 'CSV');
  const resources = csvs.flatMap(csv => officialResource(datasetId, csv.id, csv.url) ?? []);
  if (!csvs.length || resources.length !== csvs.length || new Set(resources.map(item => item.resourceId)).size !== resources.length) {
    return { ...dependency, state: 'invalid' } as const;
  }
  return { ...dependency, state: 'ready', resources } as const;
}
