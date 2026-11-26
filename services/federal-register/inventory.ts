import { z } from 'zod';
import { parseCsvText } from '../../src/csv';
import { textSha256 } from '../../src/corpora/text-store';

export const prefix = 'weekly/federal-discovery';
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const dataset = /^https:\/\/open\.canada\.ca\/data\/(?:en\/|fr\/)?dataset\/([\da-f-]{36})\/?$/;
const occurrence = z.number().int().positive().lt(4102444800000);
const entryFields = ['entry_url', 'companion_url'] as const;

export const refSchema = z.strictObject({ key: z.string(), sha256: digest, bytes: z.number().int().positive().max(8 * 1024 * 1024) });
export type ObjectRef = z.infer<typeof refSchema>;

export const Pointer = z.strictObject({
  instanceId: z.string(), scheduledTime: occurrence, receiptKey: z.string(), status: z.enum(['complete', 'partial']),
}).refine(row => row.instanceId === 'federal-discovery-' + row.scheduledTime &&
  row.receiptKey === `${prefix}/runs/${row.instanceId}.json`);
export type Pointer = z.infer<typeof Pointer>;

const catalogue = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('index-links'), title: z.string().min(1), links: z.string().array().min(1) }),
  z.object({ kind: z.literal('dataset-resources'), title: z.unknown(), resources: z.object({
    id: z.string().min(1), url: z.string().min(1), format: z.unknown(), titles: z.unknown(), languages: z.unknown(), lastModified: z.unknown(),
  }).array().min(1) }),
]);
const endpointIdentity = z.object({ series: z.string().min(1), endpoint: z.enum(entryFields), url: z.url() });
const endpoint = z.discriminatedUnion('ok', [
  endpointIdentity.extend({ ok: z.literal(true), inventory: catalogue }),
  endpointIdentity.extend({ ok: z.literal(false), reason: z.string().min(1).max(512) }),
]);
const source = z.object({
  url: z.url(), finalUrl: z.url().optional(), status: z.number().int().min(100).max(599).optional(),
  observedAt: z.iso.datetime({ offset: true }), failure: z.string().min(1).max(512).optional(),
  key: z.string().optional(), sha256: digest.optional(), bytes: z.number().int().positive().max(4 * 1024 * 1024).optional(),
});
const packetSchema = z.object({
  schemaVersion: z.literal(1), scheduledTime: occurrence, registerSha256: digest,
  endpoints: endpoint.array().min(1).max(128), sources: source.array().min(1).max(128),
});
type Source = z.infer<typeof source>;

export function encode(value: string) {
  return Uint8Array.from(new TextEncoder().encode(value));
}

export function registerEndpoints(register: string) {
  const [header, ...rows] = parseCsvText(register);
  const index = header.indexOf('series_key');
  if (index < 0 || entryFields.some(field => !header.includes(field))) throw new Error('Federal register header is incomplete.');
  const seen = new Set<string>();
  return rows.flatMap(row => {
    const series = row[index];
    if (!series || seen.has(series)) throw new Error('Federal register repeats a source series.');
    seen.add(series);
    return entryFields.flatMap(endpoint => {
      const entry = row[header.indexOf(endpoint)];
      if (!entry) return [];
      const id = dataset.exec(entry)?.[1];
      const url = id ? 'https://open.canada.ca/data/api/action/package_show?id=' + id : entry;
      return [{ series, endpoint, url, format: id ? 'json' : 'html' } as const];
    });
  });
}

export async function immutableText(bucket: R2Bucket, key: string, content: string, contentType: string) {
  const stored = await bucket.put(key, content, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType } });
  if (!stored && await (await bucket.get(key))?.text() !== content) throw new Error('Conflicting federal discovery archive object.');
}

async function bytesFor(bucket: R2Bucket, ref: ObjectRef) {
  const object = await bucket.get(ref.key);
  if (!object || object.size !== ref.bytes) throw new Error('Missing federal discovery archive object or wrong size.');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== ref.bytes || await textSha256(bytes) !== ref.sha256) {
    throw new Error('Federal discovery archive checksum mismatch.');
  }
  return bytes;
}

export function packetRef(value: unknown): ObjectRef {
  const ref = refSchema.parse(value);
  if (ref.key !== `${prefix}/inventories/${ref.sha256}.json`) throw new Error('Unexpected federal discovery inventory key.');
  return ref;
}

function originalRef(page: Source, format: 'json' | 'html'): ObjectRef | null {
  if (!page.key && !page.sha256 && !page.bytes && page.failure) return null;
  const ref = refSchema.parse({ key: page.key, sha256: page.sha256, bytes: page.bytes });
  if (page.status !== 200 || !page.finalUrl || ref.key !== `${prefix}/sources/${ref.sha256}.${format}`) {
    throw new Error('Invalid federal discovery publisher source reference.');
  }
  return ref;
}

function verifyEndpoints(
  endpoints: z.infer<typeof endpoint>[], expected: ReturnType<typeof registerEndpoints>,
  pages: ReadonlyMap<string, Source>, originals: ReadonlyMap<string, ObjectRef>,
) {
  for (const [index, item] of endpoints.entries()) {
    const match = expected[index];
    const page = pages.get(item.url);
    if (!page || item.series !== match.series || item.endpoint !== match.endpoint || item.url !== match.url ||
        item.ok === Boolean(page.failure)) throw new Error('Federal discovery endpoint metadata mismatch.');
    if (item.ok) {
      if (!originals.has(item.url) || item.inventory.kind !== (match.format === 'json' ? 'dataset-resources' : 'index-links')) {
        throw new Error('Federal discovery endpoint is missing its parsed original.');
      }
    } else if (item.reason !== page.failure) {
      throw new Error('Federal discovery failure does not match the retained request.');
    }
  }
}

export async function verifyInventory(bucket: R2Bucket, ref: ObjectRef, register: string, registerSha: string, scheduledTime: number) {
  const bytes = await bytesFor(bucket, packetRef(ref));
  const packet = packetSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)));
  const expected = registerEndpoints(register);
  if (packet.scheduledTime !== scheduledTime || packet.registerSha256 !== registerSha || packet.endpoints.length !== expected.length) {
    throw new Error('Federal discovery packet does not match its observation or register.');
  }

  const pages = new Map(packet.sources.map(page => [page.url, page]));
  const formats = new Map(expected.map(item => [item.url, item.format]));
  if (pages.size !== packet.sources.length || pages.size !== formats.size) throw new Error('Invalid federal discovery source count.');
  const originals = new Map<string, ObjectRef>();
  for (const [url, format] of formats) {
    const page = pages.get(url);
    if (!page) throw new Error('Missing registered federal endpoint.');
    const ref = originalRef(page, format);
    if (ref) originals.set(url, ref);
  }

  verifyEndpoints(packet.endpoints, expected, pages, originals);

  const archived = [...originals.values()];
  for (let i = 0; i < archived.length; i += 4) {
    await Promise.all(archived.slice(i, i + 4).map(async original => { await bytesFor(bucket, original); }));
  }
  const verified = packet.endpoints.filter(item => item.ok).length;
  return {
    series: new Set(expected.map(item => item.series)).size, endpoints: expected.length, uniqueUrls: pages.size,
    verified, failed: expected.length - verified, originals: archived.length,
    originalBytes: archived.reduce((sum, original) => sum + original.bytes, 0),
  };
}

export async function advancePointer(bucket: R2Bucket, key: string, next: Pointer) {
  const body = JSON.stringify(next);
  for (let attempt = 0; attempt < 6; attempt++) {
    const current = await bucket.get(key);
    if (current) {
      const prior = Pointer.parse(await current.json());
      if (prior.scheduledTime > next.scheduledTime) return;
      if (prior.scheduledTime === next.scheduledTime) {
        if (prior.receiptKey !== next.receiptKey || prior.status !== next.status) throw new Error('Conflicting federal discovery publication pointer.');
        return;
      }
    }
    const onlyIf = current ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' };
    if (await bucket.put(key, body, { onlyIf, httpMetadata: { contentType: 'application/json' } })) return;
  }
  throw new Error('Federal discovery publication pointer changed concurrently.');
}
