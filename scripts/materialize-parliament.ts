import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

import { ParliamentInventory, keyPattern, type ParliamentCollection } from '../src/corpora/parliament-catalogue';
import { normalizeForSearch } from '../src/text';

type SqlValue = string | number | null;
interface LocalCatalogueDatabase {
  exec(query: string): unknown;
  prepare(query: string): {
    get(...values: SqlValue[]): unknown;
    run(...values: SqlValue[]): unknown;
  };
}

const migration = new URL('../preview/parliament/migrations/0001_catalogues.sql', import.meta.url);
const entryMigration = new URL('../preview/parliament/migrations/0002_chamber_records.sql', import.meta.url);
const senate = ['sencanada.ca', 'www.sencanada.ca'];
const house = ['www.ourcommons.ca', 'www.noscommunes.ca'];
const officialHosts: Record<ParliamentCollection, readonly string[]> = {
  'senate-votes': senate, 'senate-journals': senate, 'senate-roll-calls': senate,
  bills: ['www.parl.ca', 'parl.ca'],
  'house-votes': house, 'house-journals': house, 'house-roll-calls': house,
};

const expectedKind = { bills: 'bill', 'house-votes': 'house-vote', 'senate-votes': 'senate-vote',
  'house-journals': 'house-journal', 'senate-journals': 'senate-journal',
  'house-roll-calls': 'house-roll-call', 'senate-roll-calls': 'senate-roll-call' } as const;

type InventoryRecord = ReturnType<typeof ParliamentInventory.parse>['records'][number];

function officialCitation(collection: ParliamentCollection, citation: string) {
  const url = new URL(citation);
  return officialHosts[collection].includes(url.host) && !url.username && !url.password;
}

function validateSenateOrigin(key: string, issue?: string, ordinal?: number) {
  if (key.startsWith('j') || issue !== undefined || ordinal !== undefined) {
    if (!issue || !ordinal || key !== 'j' + issue + '-' + ordinal) throw new Error('Invalid Journal roll-call reference.');
  }
}

function validateChildren(record: InventoryRecord, collection: ParliamentCollection) {
  const details = record.details;
  if ('passages' in details) {
    if ((details.status === 'published') !== (details.passages.length > 0)) throw new Error('Inconsistent Journal availability.');
    for (const passage of details.passages) {
      if (!officialCitation(collection, passage.url)) throw new Error('Invalid Journal citation.');
    }
  }
  if ('members' in details) {
    if (details.kind === 'senate-roll-call') validateSenateOrigin(record.key, details.journalIssue, details.journalVoteOrdinal);
    const ids = new Set<string>();
    for (const member of details.members) {
      if (member.url && !officialCitation(collection, member.url)) throw new Error('Invalid parliamentary member citation.');
      if (member.memberId && ids.has(member.memberId)) throw new Error('Duplicate member in a division.');
      if (member.memberId) ids.add(member.memberId);
      if ((member.position === 'paired' && !member.paired) || (details.kind === 'senate-roll-call' && member.paired)) {
        throw new Error('Inconsistent member pairing flag.');
      }
      if (member.position === (details.kind === 'house-roll-call' ? 'abstention' : 'paired')) throw new Error('Unexpected position for chamber.');
    }
  }
}

function readInventory(input: unknown) {
  const packet = ParliamentInventory.parse(input);
  const languages = new Map<string, Set<string>>();
  for (const record of packet.records) {
    if (record.details.kind !== expectedKind[packet.collection]) {
      throw new Error('Edition belongs to a different parliamentary collection.');
    }
    if (!officialCitation(packet.collection, record.url) || !keyPattern(packet.collection).test(record.key)) throw new Error('Unexpected parliamentary identifier or citation.');
    validateChildren(record, packet.collection);
    const editions = languages.get(record.key) ?? new Set<string>();
    if (editions.has(record.language)) throw new Error('Duplicate parliamentary edition.');
    editions.add(record.language);
    languages.set(record.key, editions);
  }
  if ([...languages.values()].some(editions => editions.size !== 2)) throw new Error('Missing bilingual counterpart.');
  packet.records.sort((a, b) => a.key.localeCompare(b.key, 'en') || a.language.localeCompare(b.language, 'en'));
  const hash = createHash('sha256').update('[');
  packet.records.forEach((record, index) => { if (index) hash.update(','); hash.update(JSON.stringify(record)); });
  return { packet, revision: hash.update(']').digest('hex'),
    observedAt: new Date(packet.observedAt).toISOString(), recordsPerLanguage: languages.size };
}

function storeChildren(put: ReturnType<LocalCatalogueDatabase['prepare']>, collection: ParliamentCollection, session: string, record: InventoryRecord) {
  const details = record.details;
  const prefix = [collection, session, record.language, record.key];
  if ('passages' in details) {
    details.passages.forEach((passage, index) => put.run(...prefix, index + 1, JSON.stringify(passage),
      normalizeForSearch(passage.text), null, null));
    return { kind: details.kind, status: details.status, passageCount: details.passages.length };
  }
  if ('members' in details) {
    details.members.forEach((member, index) => put.run(...prefix, index + 1, JSON.stringify(member),
      normalizeForSearch([member.name, member.affiliation, member.constituency, member.province].filter(Boolean).join(' ')),
      member.memberId, member.position));
    const { members, ...metadata } = details;
    if (metadata.kind === 'senate-roll-call' && metadata.journalIssue) {
      const tally = { yeas: 0, nays: 0, abstentions: 0 };
      for (const member of members) {
        if (member.position === 'yea') tally.yeas++;
        else if (member.position === 'nay') tally.nays++;
        else if (member.position === 'abstention') tally.abstentions++;
      }
      return { ...metadata, memberCount: members.length, tally };
    }
    return { ...metadata, memberCount: members.length };
  }
  return details;
}

function checkSenateReplacement(db: LocalCatalogueDatabase, packet: ReturnType<typeof ParliamentInventory.parse>) {
  if (packet.collection !== 'senate-roll-calls') return;
  const receipt = packet.journalReconciliation;
  if (receipt) {
    const additional = packet.records.filter(row => row.language === 'en' && row.key.startsWith('j')).length;
    if (receipt.journalOnlyRecordsPerLanguage !== additional || Date.parse(receipt.observedAt) > Date.parse(packet.observedAt)) {
      throw new Error('Inconsistent Senate Journal reconciliation receipt.');
    }
  } else if (db.prepare(`SELECT 1 FROM parliament_editions WHERE collection=? AND session=? AND key GLOB 'j*' LIMIT 1`)
    .get(packet.collection, packet.session)) {
    throw new Error('A Senate Journal reconciliation is required to replace this supplemented inventory.');
  }
}

/** Publish each complete bilingual collection in one transaction. Replaying the same input is safe. */
export function materializeParliament(db: LocalCatalogueDatabase, input: unknown) {
  const { packet, revision, observedAt, recordsPerLanguage } = readInventory(input);
  const { collection, session } = packet;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(migration, 'utf8'));
    db.exec(readFileSync(entryMigration, 'utf8'));
    const previous = db.prepare('SELECT observed_at, revision FROM parliament_catalogues WHERE collection=? AND session=?')
      .get(collection, session) as { revision: string; observed_at: string } | null | undefined;
    if (previous && (String(previous.observed_at) > observedAt ||
        (previous.observed_at === observedAt && previous.revision !== revision))) {
      throw new Error('A newer or conflicting parliamentary observation already exists.');
    }
    const changed = previous?.revision !== revision;
    if (changed) {
      checkSenateReplacement(db, packet);
      db.prepare('DELETE FROM parliament_editions WHERE collection=? AND session=?').run(collection, session);
      db.prepare('DELETE FROM parliament_entries WHERE collection=? AND session=?').run(collection, session);
      const entry = db.prepare(`INSERT INTO parliament_entries
        (collection, session, language, key, ordinal, payload, search_text, member_id, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const put = db.prepare(`INSERT INTO parliament_editions
        (collection, session, key, language, title, summary, date, url, search_text, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const record of packet.records) put.run(collection, session, record.key, record.language, record.title,
        record.summary, record.date, record.url, normalizeForSearch([record.key, record.title, record.summary].join(' ')), JSON.stringify(storeChildren(entry, collection, session, record)));
    }
    db.prepare(`INSERT INTO parliament_catalogues (collection,session,observed_at,revision,records_per_language)
      VALUES (?,?,?,?,?) ON CONFLICT(collection,session) DO UPDATE SET observed_at=excluded.observed_at,
      revision=excluded.revision, records_per_language=excluded.records_per_language`)
      .run(collection, session, observedAt, revision, recordsPerLanguage);
    db.exec('COMMIT');
    return { collection, session, observedAt, revision, recordsPerLanguage, changed };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

if (import.meta.main) {
  const [database, ...inputs] = process.argv.slice(2);
  if (!database || !inputs.length) throw new Error('Usage: bun scripts/materialize-parliament.ts LOCAL.sqlite INVENTORY.json [...]');
  const { Database } = createRequire(import.meta.url)('bun:sqlite') as {
    Database: new (path: string, options: { create: boolean }) => LocalCatalogueDatabase & { close(): void };
  };
  mkdirSync(dirname(database), { recursive: true });
  const db = new Database(database, { create: true });
  try {
    for (const path of inputs) console.log(JSON.stringify(materializeParliament(db, JSON.parse(readFileSync(path, 'utf8')))));
  } finally { db.close(); }
}
