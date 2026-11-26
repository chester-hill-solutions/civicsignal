import { z } from 'zod';
import { prefix } from './archive';

const requiredHousePage = /^https:\/\/www\.ourcommons\.ca\/(?:Committees\/(?:en|fr)\/Participate|committees\/(?:en|fr)\/[A-Z0-9]+\/StudyActivity\?studyActivityId=[0-9]+)$/;
const publisherFailure = z.strictObject({
  phase: z.literal('acquisition'), code: z.literal('publisher-http'), status: z.literal(403),
  url: z.string().max(512).regex(requiredHousePage),
});
type PublisherFailure = z.infer<typeof publisherFailure>;
export const HouseFailureReceipt = publisherFailure.extend({
  instanceId: z.string(), scheduledTime: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).refine(v => v.instanceId === `house-calls-${v.scheduledTime}`);

export async function housePublisherFailure(response: Response): Promise<PublisherFailure | null> {
  if (response.status !== 403 || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return null;
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return null;
  }
  const result = publisherFailure.safeParse(value);
  return result.success ? result.data : null;
}

interface Archive {
  put(key: string, data: string, opts: R2PutOptions): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

export async function retainHouseFailure(archive: Archive, instanceId: string, scheduledTime: number, failure: PublisherFailure) {
  const receipt = HouseFailureReceipt.parse({instanceId,scheduledTime,...failure});
  const key = `${prefix}/failures/${instanceId}.json`;
  const body = JSON.stringify(receipt);
  const stored = await archive.put(key,body,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
  if (!stored && await (await archive.get(key))?.text() !== body) throw new Error('Conflicting House publisher failure receipt.');
  return key;
}
