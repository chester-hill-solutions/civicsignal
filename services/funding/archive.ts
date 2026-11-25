import { z } from 'zod';
import { FundingInventory } from '../../src/corpora/funding';
import { textSha256 } from '../../src/corpora/text-store';

const archiveRef = z.strictObject({
  key: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive().max(8 * 1024 * 1024),
  sources: z.number().int().positive().max(64),
  sourceBytes: z.number().int().positive().max(16 * 1024 * 1024),
});

export async function collectNserc(collector: Fetcher, observedAt: string) {
  const response = await collector.fetch('https://collector.internal/collect', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ observedAt }),
  });
  if (!response.ok) throw new Error(`NSERC acquisition failed (HTTP ${response.status}).`);
  const ref = archiveRef.parse(await response.json());
  if (ref.key !== `funding/nserc/inventories/${ref.sha256}.json`) throw new Error('Unexpected funding inventory key.');
  return ref;
}

interface ArchiveReader {
  get(key: string): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

async function verifiedBytes(bucket: ArchiveReader, key: string, size: number, digest: string) {
  const object = await bucket.get(key);
  if (!object || object.size !== size) throw new Error(`Missing or truncated funding archive object: ${key}`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== size || await textSha256(bytes) !== digest) throw new Error(`Funding archive checksum mismatch: ${key}`);
  return bytes;
}

/** Read the checkpoint and verify that every published citation has an archived original. */
export async function readNsercInventory(bucket: ArchiveReader, ref: z.infer<typeof archiveRef>, observedAt: string) {
  const bytes = await verifiedBytes(bucket, ref.key, ref.bytes, ref.sha256);
  const packet = FundingInventory.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)));
  if (packet.source !== 'nserc' || packet.observedAt !== observedAt || packet.sources?.length !== ref.sources ||
    packet.sources.reduce((sum, file) => sum + file.bytes, 0) !== ref.sourceBytes) {
    throw new Error('Funding inventory does not match the acquisition checkpoint.');
  }
  const requested = new Set<string>(), archived = new Set<string>();
  for (const file of packet.sources) {
    if (requested.has(file.url) || !file.bytes || file.bytes > 2 * 1024 * 1024) throw new Error('Invalid funding source inventory.');
    await verifiedBytes(bucket, `funding/nserc/sources/${file.sha256}.html`, file.bytes, file.sha256);
    requested.add(file.url);
    archived.add(file.url);
    archived.add(file.resolvedUrl);
  }
  const citations = [...Object.values(packet.indexes),
    ...packet.records.flatMap(record => [record.url, ...record.sections.map(section => section.url)])];
  if (citations.some(url => !archived.has(url.split('#')[0]))) throw new Error('Funding edition cites an unarchived page.');
  return packet;
}
