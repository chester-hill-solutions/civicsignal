import { z } from 'zod';
import { textSha256 } from '../../src/corpora/text-store';
import { inventoryReference, prefix as housePrefix } from '../house/archive';

export const sources = ['consultations', 'nserc', 'esdc', 'house'] as const;
export type Source = typeof sources[number];
export const houseInstance = z.string().regex(/^house-calls-\d+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
const packetRef = z.object({ key: z.string(), sha256: digest, bytes: z.number().int().positive() });
const houseReceipt = z.object({
  instanceId: houseInstance,
  scheduledTime: z.number().int().positive(),
  packetRef,
  published: z.object({ observedAt: instant, cutoff: instant, packetSha256: digest }),
});
type HouseReceipt = z.infer<typeof houseReceipt>;

export type HousePublication = {
  instanceId: string;
  receiptKey: string;
  receiptSha256: string;
  observedAt: string;
  cutoff: string;
  packetRef: z.infer<typeof packetRef>;
};
export type HouseSnapshot = {
  sha256: string;
  cutoff: string;
  instanceId: string | null;
  packetSha256: string | null;
  observedAt: string | null;
  editions: number;
  links: number;
};

export interface Archives {
  ARCHIVE: R2Bucket;
  CONSULTATION_ARCHIVE: R2Bucket;
}

export function sourceInstance(source: Source, scheduledTime: number) {
  return `${source === 'house' ? 'house-calls' : source}-${scheduledTime}`;
}

export function receiptKey(source: Source, instance: string) {
  const prefix = { consultations: 'consultations', nserc: 'funding/nserc', esdc: 'funding/esdc', house: housePrefix };
  return `${prefix[source]}/runs/${instance}.json`;
}

export async function readJson(bucket: R2Bucket, key: string, limit = 128 * 1024) {
  const object = await bucket.get(key);
  if (!object || object.size <= 0 || object.size > limit) throw new Error('Missing or oversized archived record.');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== object.size) throw new Error('Truncated archived record.');
  const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  return { data, sha256: await textSha256(bytes) };
}

async function hashJson(value: unknown) {
  return textSha256(Uint8Array.from(new TextEncoder().encode(JSON.stringify(value))));
}

export async function houseSnapshot(db: D1Database): Promise<HouseSnapshot> {
  // One D1 batch pins the head, corpus cutoff, editions and their relationships to the same read.
  const [snapshot, run, calls, links] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT cutoff FROM cc_snapshot WHERE session='45-1'"),
    db.prepare("SELECT * FROM cc_house_runs WHERE session='45-1' ORDER BY scheduled_time DESC LIMIT 1"),
    db.prepare("SELECT * FROM cc_records WHERE session='45-1' AND kind='call' AND chamber='house' ORDER BY id,language"),
    db.prepare(`SELECT l.* FROM cc_links l JOIN cc_records r ON r.session=l.session AND r.language=l.language
      AND r.id=l.child_id WHERE r.session='45-1' AND r.kind='call' AND r.chamber='house'
      ORDER BY l.language,l.parent_id,l.child_id,l.relation`),
  ]);
  const head = run.results[0];
  const cutoff = instant.parse(snapshot.results[0]?.cutoff);
  return {
    sha256: await hashJson([cutoff, head ?? null, calls.results, links.results]),
    cutoff,
    instanceId: head ? houseInstance.parse(head.instance_id) : null,
    packetSha256: head ? digest.parse(head.packet_sha256) : null,
    observedAt: head ? instant.parse(head.observed_at) : null,
    editions: calls.results.length,
    links: links.results.length,
  };
}

function parseHouseReceipt(data: unknown, id: string): HouseReceipt {
  const receipt = houseReceipt.parse(data);
  if (receipt.instanceId !== id || sourceInstance('house', receipt.scheduledTime) !== id ||
      receipt.published.packetSha256 !== receipt.packetRef.sha256) throw new Error('House completion receipt differs from its publication.');
  inventoryReference(receipt.packetRef);
  return receipt;
}

export async function housePublication(bucket: R2Bucket, snapshot: HouseSnapshot): Promise<HousePublication | null> {
  if (!snapshot.instanceId) return null;
  const key = receiptKey('house', snapshot.instanceId);
  const { data, sha256 } = await readJson(bucket, key);
  const receipt = parseHouseReceipt(data, snapshot.instanceId);
  const { observedAt, cutoff, packetSha256: sha } = receipt.published;
  if (snapshot.observedAt !== observedAt || snapshot.cutoff !== cutoff || snapshot.packetSha256 !== sha) {
    throw new Error('Last verified House receipt differs from the D1 head.');
  }
  return { instanceId: receipt.instanceId, receiptKey: key, receiptSha256: sha256, observedAt, cutoff, packetRef: receipt.packetRef };
}

const catalogueReceipt = z.object({
  instanceId: z.string(),
  observedAt: instant,
  published: z.object({ revision: digest }),
});

export async function completedSource(env: Archives, source: Source, id: string, scheduledTime: number, output: unknown) {
  const key = receiptKey(source, id);
  if (z.object({ receiptKey: z.literal(key) }).safeParse(output).success === false) throw new Error('Workflow completion references a different receipt.');
  const bucket = source === 'consultations' ? env.CONSULTATION_ARCHIVE : env.ARCHIVE;
  const { data, sha256 } = await readJson(bucket, key);
  if (source === 'house') {
    const receipt = parseHouseReceipt(data, id);
    const { observedAt, cutoff } = receipt.published;
    return { receiptKey: key, receiptSha256: sha256, observedAt, cutoff, packetRef: receipt.packetRef };
  }
  const receipt = catalogueReceipt.parse(data);
  if (receipt.instanceId !== id || Date.parse(receipt.observedAt) !== scheduledTime) throw new Error('Archived receipt has a different observation.');
  return { receiptKey: key, receiptSha256: sha256, observedAt: receipt.observedAt, revision: receipt.published.revision };
}

export function compareHouse(before: HouseSnapshot | null, after: HouseSnapshot | null, beforeReceipt: HousePublication | null, afterReceipt: HousePublication | null) {
  const unchanged = before && after ? before.sha256 === after.sha256 : null;
  const receiptRetained = beforeReceipt !== null && beforeReceipt.receiptSha256 === afterReceipt?.receiptSha256;
  return { before, after, unchanged, receiptRetained, lastGood: unchanged && receiptRetained ? beforeReceipt : null };
}
