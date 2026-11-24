import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FundingInventory, type FundingSource } from '../../src/corpora/funding';
import { normalizeForSearch } from '../../src/text';

export const baselineFundingRevisions = {
  nserc: '2e930740d7c816bc4767e39efa014a2c1f164840e2cb8d70572ef4e3e1237894',
  esdc: 'b4f1ba63a71f11916593e12d3e1b60a111a34dbb5c8e0630ff0da68d508ee44b',
};

export function acquiredFunding(path: string, source: FundingSource) {
  const directory = dirname(path);
  const bytes = readFileSync(join(directory, source + '.json'));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const archived = readFileSync(join(directory, 'sources', 'inventories', source, digest + '.json'));
  if (!bytes.equals(archived)) throw new Error(`Funding inventory archive hash mismatch for ${source}`);
  const archive = FundingInventory.parse(JSON.parse(bytes.toString('utf8')));
  if (archive.source !== source) throw new Error(`Unexpected funding source in ${source}.json`);
  const editionKey = (row: FundingInventory['records'][number]) => `${row.id}/${row.language}`;
  const records = [...archive.records].sort((left, right) => editionKey(left).localeCompare(editionKey(right), 'en'));
  const gaps = [...archive.gaps].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'));
  const revision = createHash('sha256').update(JSON.stringify({ indexes: archive.indexes, records, gaps })).digest('hex');
  return { archive, observedAt: new Date(archive.observedAt).toISOString(), revision };
}

export function archivedFundingSearch(inventory: FundingInventory, language: 'en' | 'fr', query: string) {
  const needle = normalizeForSearch(query);
  return inventory.records.filter(record => record.language === language && normalizeForSearch(
    [record.title, record.id, record.statusText, ...record.sections.flatMap(section => [section.heading, section.text])]
      .filter(Boolean).join(' '),
  ).includes(needle));
}
