import { createHash } from 'node:crypto';
import { FundingInventory } from './funding';
import { normalizeForSearch } from '../text';

export type Edition = FundingInventory['records'][number];
export const fundingDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const editionKey = (record: Pick<Edition, 'id' | 'language'>) => record.id + '/' + record.language;

function checkCitation(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !/(?:^|\.)(?:canada\.ca|gc\.ca)$/.test(url.hostname)) throw new Error('Invalid government funding citation: ' + value);
}

export function checkedFundingInventory(input: unknown) {
  const packet = FundingInventory.parse(input);
  Object.values(packet.indexes).forEach(checkCitation);
  if (packet.indexes.en === packet.indexes.fr) throw new Error('Funding inventory requires two edition-specific index citations.');
  const keys = new Set<string>();
  for (const row of packet.records) {
    if (!row.id.startsWith(packet.source + '-') || keys.has(editionKey(row))) throw new Error('Invalid or duplicate funding edition: ' + row.id);
    checkCitation(row.url);
    row.sections.forEach(section => checkCitation(section.url));
    if (row.availability === 'published' && !row.sections.length) throw new Error('Published funding edition has no cited terms.');
    keys.add(editionKey(row));
  }
  packet.gaps.forEach(gap => checkCitation(gap.url));
  for (const language of ['en', 'fr']) {
    if (!packet.records.some(row => row.language === language)) throw new Error('Funding inventory lacks an entire language.');
  }
  for (const row of packet.records) {
    const language = row.language === 'en' ? 'fr' : 'en';
    if (!keys.has(row.id + '/' + language) && !packet.gaps.some(gap => gap.id === row.id && gap.language === language)) {
      throw new Error('Unexplained missing funding counterpart: ' + row.id);
    }
  }
  packet.records.sort((a,b) => editionKey(a).localeCompare(editionKey(b), 'en'));
  packet.gaps.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  return packet;
}

export function fundingRevision(packet: FundingInventory): string {
  return fundingDigest({ indexes: packet.indexes, records: packet.records, gaps: packet.gaps });
}

export function fundingSearchText(row: Edition): string {
  return normalizeForSearch([row.title, row.id, row.statusText,
    ...row.sections.map(section => section.heading + ' ' + section.text)].join('\n'));
}
