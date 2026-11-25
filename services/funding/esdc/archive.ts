import { z } from 'zod';
import { FundingInventory } from '../../../src/corpora/funding';
import { textSha256 } from '../../../src/corpora/text-store';
import { type ArchiveReader, verifiedBytes } from '../archive';

const prefix = 'funding/esdc';
const indexes = {
  en: 'https://www.canada.ca/en/employment-social-development/services/funding/programs.html',
  fr: 'https://www.canada.ca/fr/emploi-developpement-social/services/financement/programmes.html',
};
const reference = z.strictObject({
  key: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive().max(16 * 1024 * 1024),
  sources: z.number().int().positive().max(1024),
  sourceBytes: z.number().int().positive().max(64 * 1024 * 1024),
});
type Reference = z.infer<typeof reference>;

function inventoryReference(input: unknown) {
  const ref = reference.parse(input);
  if (ref.key !== `${prefix}/inventories/${ref.sha256}.json`) throw new Error('Unexpected ESDC inventory key.');
  return ref;
}

export async function collectEsdc(collector: Fetcher, observedAt: string) {
  const result = await collector.fetch('https://collector.internal/collect', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ observedAt }),
  });
  if (!result.ok) throw new Error(`ESDC acquisition failed (HTTP ${result.status}).`);
  return inventoryReference(await result.json());
}

function publisherPage(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(url.hostname === 'canada.ca' || url.hostname.endsWith('.canada.ca') || url.hostname.endsWith('.gc.ca'))) {
    throw new Error('Unexpected ESDC publisher URL.');
  }
  return value.split('#')[0];
}

async function verifyTerminalPage(bucket: ArchiveReader, observedAt: string, url: string, status: number) {
  const urlHash = await textSha256(Uint8Array.from(new TextEncoder().encode(url)));
  const object = await bucket.get(`${prefix}/observations/${observedAt}/pages/${urlHash}.json`);
  if (!object || !object.size || object.size > 8192) throw new Error('Missing ESDC terminal HTTP checkpoint.');
  const body = await object.arrayBuffer();
  if (body.byteLength !== object.size) throw new Error('Truncated ESDC terminal HTTP checkpoint.');
  const checkpoint = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
  if (checkpoint?.url !== url || checkpoint.status !== status) throw new Error('ESDC terminal HTTP checkpoint mismatch.');
}

async function verifyGapCitations(bucket: ArchiveReader, packet: FundingInventory, archived: Set<string>) {
  const terminalEditions = new Set<string>();
  const terminalPages = new Map<string, number>();
  for (const gap of packet.gaps) {
    const match = /^confirmed-detail-http-(404|410)$/.exec(gap.reason);
    if (!match) continue;
    const url = publisherPage(gap.url), status = Number(match[1]);
    if (archived.has(url) || !gap.id || !packet.records.some(record => record.id === gap.id && record.language === gap.language) ||
        (terminalPages.has(url) && terminalPages.get(url) !== status)) throw new Error('Invalid ESDC terminal HTTP gap.');
    terminalEditions.add(JSON.stringify([gap.id, url]));
    terminalPages.set(url, status);
  }
  for (const gap of packet.gaps) {
    const url = publisherPage(gap.url);
    if (!archived.has(url) && !terminalEditions.has(JSON.stringify([gap.id, url]))) throw new Error('Unaccounted ESDC gap URL.');
  }
  for (const [url, status] of terminalPages) await verifyTerminalPage(bucket, packet.observedAt, url, status);
}

export async function readEsdcInventory(bucket: ArchiveReader, input: Reference, observedAt: string) {
  const ref = inventoryReference(input);
  const bytes = await verifiedBytes(bucket, ref.key, ref.bytes, ref.sha256);
  const packet = FundingInventory.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)));
  if (packet.source !== 'esdc' || packet.observedAt !== observedAt || packet.sources?.length !== ref.sources ||
      packet.sources.reduce((sum, file) => sum + file.bytes, 0) !== ref.sourceBytes ||
      packet.indexes.en !== indexes.en || packet.indexes.fr !== indexes.fr) {
    throw new Error('ESDC inventory does not match acquisition checkpoint or official indexes.');
  }

  const requested = new Set<string>(), archived = new Set<string>(), objects = new Map<string, number>();
  for (const file of packet.sources) {
    const request = publisherPage(file.url), resolved = publisherPage(file.resolvedUrl);
    if (requested.has(request) || !file.bytes || file.bytes > 2 * 1024 * 1024 ||
        (objects.has(file.sha256) && objects.get(file.sha256) !== file.bytes)) throw new Error('Invalid ESDC source inventory.');
    requested.add(request);
    archived.add(request);
    archived.add(resolved);
    objects.set(file.sha256, file.bytes);
  }
  function requireOriginal(url: string) {
    if (!archived.has(publisherPage(url))) throw new Error('ESDC edition cites an unarchived page.');
  }
  Object.values(indexes).forEach(requireOriginal);
  for (const edition of packet.records) {
    requireOriginal(edition.url);
    for (const section of edition.sections) requireOriginal(section.url);
  }

  await verifyGapCitations(bucket, packet, archived);

  // Discard each group of source bodies before starting the next R2 reads.
  const originals = [...objects];
  for (let i = 0; i < originals.length; i += 4) {
    await Promise.all(originals.slice(i, i + 4).map(async ([digest, size]) => {
      await verifiedBytes(bucket, `${prefix}/sources/${digest}.html`, size, digest);
    }));
  }
  return packet;
}
