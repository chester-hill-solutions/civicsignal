import { z } from 'zod';
import { textSha256 } from '../../src/corpora/text-store';
import { HousePacket } from './publish';

export const prefix = 'committee/house-calls';
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const refSchema = z.object({ key: z.string(), sha256: digest, bytes: z.number().int().positive().max(16 * 1024 * 1024) });
export type PacketRef = z.infer<typeof refSchema>;

export function inventoryReference(raw: unknown): PacketRef {
  const ref = refSchema.parse(raw);
  if (ref.key !== `${prefix}/inventories/${ref.sha256}.json`) throw new Error('Unexpected House calls inventory key.');
  return ref;
}

interface Reader { get(key: string): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null> }

export async function readVerified(bucket: Reader, ref: PacketRef) {
  const object = await bucket.get(ref.key);
  if (!object || object.size !== ref.bytes) throw new Error('Missing or truncated House archive object: ' + ref.key);
  const body = new Uint8Array(await object.arrayBuffer());
  if (body.length !== ref.bytes || await textSha256(body) !== ref.sha256) throw new Error('House archive digest mismatch: ' + ref.key);
  return body;
}

const indexes = ['https://www.ourcommons.ca/Committees/en/Participate','https://www.ourcommons.ca/Committees/fr/Participate'];
const senate = [
  '/en/committees/', '/en/committees/aefa/', '/en/committees/aefa/briefs/45-1', '/en/committees/aefa/studiesandbills/45-1',
  '/fr/comites/', '/fr/comites/aefa/', '/fr/comites/aefa/memoires/45-1', '/fr/comites/aefa/etudesetprojetsdeloi/45-1',
].map(path => 'https://sencanada.ca' + path);

type Source = HousePacket['sources'][number];

function validateSource(source: Source, expected: Set<string>) {
  if (!expected.delete(source.url)) throw new Error('Unexpected or duplicate committee source: ' + source.url);
  const isSenate = senate.includes(source.url);
  const url = new URL(source.url);
  if ((!isSenate && (url.origin !== 'https://www.ourcommons.ca' || !url.pathname.toLowerCase().startsWith('/committees/'))) ||
      source.chamber !== (isSenate ? 'senate' : 'house') || !url.pathname.toLowerCase().includes('/' + source.language + '/')) {
    throw new Error('Mismatched committee source attribution.');
  }
  if (source.state === 'unavailable') {
    if (!isSenate || source.listing !== 'unreadable' || !source.error || source.key || source.sha256 || source.bytes) {
      throw new Error('Unexpected unavailable committee source.');
    }
  } else if (source.status !== 200 || !source.sha256 || !source.bytes || source.bytes > 8 * 1024 * 1024 ||
      source.key !== `${prefix}/sources/${source.sha256}.html`) {
    throw new Error('Invalid committee original reference.');
  }
}

async function verifyPage(bucket: Reader, source: Source, instanceId: string) {
  const urlHash = await textSha256(Uint8Array.from(new TextEncoder().encode(source.url)));
  const checkpoint = await bucket.get(`${prefix}/observations/${instanceId}/pages/${urlHash}.json`);
  if (!checkpoint || checkpoint.size > 16384) throw new Error('Missing or oversized committee page checkpoint.');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const saved = JSON.parse(decoder.decode(await checkpoint.arrayBuffer()));
  // Checkpoints contain only scalar provenance fields. This also covers unavailable Senate probes.
  if (!saved || Object.keys(saved).length !== Object.keys(source).length ||
      !Object.entries(source).every(([field,value]) => saved[field] === value)) throw new Error('Committee page checkpoint differs from inventory.');
  if (source.state === 'archived' && source.key && source.sha256 && source.bytes) {
    await readVerified(bucket, { key: source.key, sha256: source.sha256, bytes: source.bytes });
  }
}

export async function readHouseInventory(bucket: Reader, input: PacketRef, instanceId: string, scheduledTime: number) {
  const ref = inventoryReference(input);
  const bytes = await readVerified(bucket, ref);
  const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  const packet = HousePacket.parse(JSON.parse(decoded));
  if (packet.instanceId !== instanceId || packet.scheduledTime !== scheduledTime || packet.session !== '45-1') {
    throw new Error('Mismatched House observation identity.');
  }
  const expected = new Set([...indexes, ...senate, ...packet.calls.filter(call => call.metadata.listed).map(call => call.url)]);
  for (const source of packet.sources) validateSource(source, expected);
  if (expected.size) throw new Error('Missing committee source observations.');
  for (let i = 0; i < packet.sources.length; i += 4) {
    await Promise.all(packet.sources.slice(i, i + 4).map(source => verifyPage(bucket, source, instanceId)));
  }
  return packet;
}
