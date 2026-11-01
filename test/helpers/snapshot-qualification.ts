import { gzipSync } from 'node:zlib';
import type { BuildBucket } from '../../services/snapshot/builder';
import { stageCorpus, buildGroup, sortIndexPartition, publishSnapshot, PARTITIONS } from '../../services/snapshot/builder';
import { QUALIFICATION_STAGE_ID, type QualificationControls } from '../../services/snapshot/qualification';

export const revision = { commit: '0507465393c224c0491fc8c17c88340217acc656', date: '2026-10-15' };
export function calendarAt(scheduledTime: number) {
  const at = new Date(scheduledTime);
  return { cron: `${at.getUTCMinutes()} ${at.getUTCHours()} ${at.getUTCDate()} ${at.getUTCMonth() + 1} *`, scheduledTime };
}
export const event = calendarAt(Math.floor(Date.now() / 60000) * 60000);
export const controls: QualificationControls = { SNAPSHOT_STAGE_ID: QUALIFICATION_STAGE_ID,
  SNAPSHOT_PINNED_COMMIT: revision.commit, SNAPSHOT_PINNED_DATE: revision.date,
  SNAPSHOT_QUALIFICATION_ID: 'local-first-publication', SNAPSHOT_QUALIFICATION_CRON: event.cron,
  SNAPSHOT_QUALIFICATION_TIME: String(event.scheduledTime), SNAPSHOT_QUALIFICATION_DEADLINE: String(event.scheduledTime + 2 * 60 * 60 * 1000) };
export const files = [
  { path: 'eng/acts/T-1.xml', id: '100', text: 'A test rule.' },
  { path: 'fra/lois/T-1.xml', id: '200', text: 'Une règle de test.' },
].map(({ path, id, text }) => ({ path, content: `<Statute xmlns:lims="http://justice.gc.ca/lims"><Identification><ShortTitle>Test Act</ShortTitle><Chapter><ConsolidatedNumber>T-1</ConsolidatedNumber></Chapter></Identification><Body><Section lims:id="${id}"><Label>1</Label><Text>${text}</Text></Section></Body></Statute>` }));
export function archive(): Uint8Array<ArrayBuffer> {
  const entries: Buffer[] = [];
  for (const file of files) {
    const content = Buffer.from(file.content), header = Buffer.alloc(512);
    header.write(`laws-lois-xml-fixture/${file.path}`); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    entries.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return new Uint8Array(gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])));
}
export function memoryBucket() {
  const objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; metadata: Record<string, string> }>();
  const writes: string[] = [], deletes: string[] = [];
  let failPut: ((key: string) => 'before' | 'after' | undefined) | undefined;
  const bucket = {
    async head(key: string) { const item = objects.get(key); return item ? { key, size: item.bytes.length, customMetadata: item.metadata } : null; },
    async get(key: string) {
      const item = objects.get(key); if (!item) return null;
      return { key, size: item.bytes.length, customMetadata: item.metadata, body: new Response(item.bytes).body,
        arrayBuffer: async () => item.bytes.slice().buffer, text: async () => new TextDecoder().decode(item.bytes) };
    },
    async put(key: string, input: Uint8Array<ArrayBuffer> | string, options?: { onlyIf?: unknown; customMetadata?: Record<string, string> }) {
      const failure = failPut?.(key);
      if (failure === 'before') throw new Error('private write failure');
      if (options?.onlyIf && objects.has(key)) return null;
      const bytes = typeof input === 'string' ? new Uint8Array(new TextEncoder().encode(input)) : new Uint8Array(input);
      objects.set(key, { bytes, metadata: options?.customMetadata ?? {} }); writes.push(key);
      if (failure === 'after') throw new Error('private lost acknowledgement');
      return { key, size: bytes.length };
    },
    async list({ prefix = '', limit = 1000, cursor }: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const values = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
      const offset = cursor ? Number(cursor) : 0, keys = values.slice(offset, offset + limit), truncated = offset + limit < values.length;
      return { objects: keys.map(key => ({ key, size: objects.get(key)!.bytes.length })), truncated, ...(truncated ? { cursor: String(offset + limit) } : {}), delimitedPrefixes: [] };
    },
    async delete(keys: string | string[]) { for (const key of typeof keys === 'string' ? [keys] : keys) { deletes.push(key); objects.delete(key); } },
  } as unknown as BuildBucket;
  return { bucket, objects, writes, deletes, failWrites(f: typeof failPut) { failPut = f; } };
}

/** Test-only generated-data replacement: real builder, tiny synthetic archive.
 * Production has no environment/data override for its pinned reference. */
export async function qualificationFixtureData() {
  const h = memoryBucket(), plan = await stageCorpus(h.bucket, { async *instruments() { yield* files; } }, revision);
  const groups = []; let offset = 0;
  for (let n = 0; n < plan.groups.length; n++) { const group = await buildGroup(h.bucket, plan, n, offset); groups.push(group); offset += group.bytes; }
  const partitions = [];
  for (const partition of PARTITIONS) partitions.push(await sortIndexPartition(h.bucket, revision.commit, partition, groups));
  const manifest = await publishSnapshot(h.bucket, plan, groups, partitions);
  const entries = [...h.objects].map(([key, value]) => [key, value.bytes.length, value.metadata.sha256] as const);
  return { entries, objects: h.objects, manifest, module: `export const QUALIFICATION_REFERENCE_PINS=[];\nexport const QUALIFICATION_PAYLOADS=${JSON.stringify(entries)};\n` +
    `export const QUALIFICATION_REFERENCE=${JSON.stringify({ revision, parser: 'statutes-v2', rows: manifest.rows.count, payloadBytes: entries.reduce((sum, [, bytes]) => sum + bytes, 0) })};\n` };
}
