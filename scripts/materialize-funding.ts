import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { FundingInventory } from '../src/corpora/funding';
import { normalizeForSearch } from '../src/text';

type Inventory = ReturnType<typeof FundingInventory.parse>;
type Edition = Inventory['records'][number];
type Value = string | number | null;
interface LocalDatabase {
  exec(query: string): unknown;
  prepare(query: string): {
    get(...values: Value[]): unknown;
    all(...values: Value[]): unknown[];
    run(...values: Value[]): unknown;
  };
}
const migration = new URL('../preview/funding/migrations/0001_funding.sql', import.meta.url);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const editionKey = (record: Pick<Edition, 'id' | 'language'>) => record.id + '/' + record.language;

function checkCitation(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !/(?:^|\.)(?:canada\.ca|gc\.ca)$/.test(url.hostname)) throw new Error('Invalid government funding citation: ' + value);
}

function checked(input: unknown) {
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

function updateEditions(db: LocalDatabase, packet: Inventory, observedAt: string) {
  const prior = db.prepare('SELECT id,language,revision FROM funding_editions WHERE source=?').all(packet.source) as
    {id: string; language: Edition['language']; revision: string}[];
  const previous = new Map(prior.map(row => [editionKey(row),row]));
  const change = db.prepare('INSERT INTO funding_versions (source,id,language,observed_at,revision,event,edition_json) VALUES (?,?,?,?,?,?,?)');
  const dropSections = db.prepare('DELETE FROM funding_sections WHERE source=? AND id=? AND language=?');
  const insertSection = db.prepare(`INSERT INTO funding_sections
    (source,id,language,section_index,field,heading,text,url,normalized_heading,normalized_text)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const put = db.prepare(`INSERT INTO funding_editions
    (source,id,language,revision,title,url,status,status_text,availability,sections_json,search_text) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source,id,language) DO UPDATE SET revision=excluded.revision,title=excluded.title,url=excluded.url,
    status=excluded.status,status_text=excluded.status_text,availability=excluded.availability,
    sections_json=excluded.sections_json,search_text=excluded.search_text`);
  const events = { added: 0, changed: 0, removed: 0 };
  for (const row of packet.records) {
    const key = editionKey(row);
    const old = previous.get(key);
    previous.delete(key);
    const revision = hash(row);
    if (old?.revision === revision) continue;
    const event = old ? 'changed' : 'added';
    const text = normalizeForSearch([row.title,row.id,row.statusText,...row.sections.map(section => section.heading + ' ' + section.text)].join('\n'));
    put.run(packet.source,row.id,row.language,revision,row.title,row.url,row.status,row.statusText,row.availability,JSON.stringify(row.sections),text);
    change.run(packet.source,row.id,row.language,observedAt,revision,event,JSON.stringify(row));
    if (old) dropSections.run(packet.source, row.id, row.language);
    row.sections.forEach((section, index) => insertSection.run(packet.source, row.id, row.language, index,
      section.field, section.heading, section.text, section.url, normalizeForSearch(section.heading), normalizeForSearch(section.text)));
    events[event]++;
  }
  const last = db.prepare('SELECT edition_json FROM funding_versions WHERE source=? AND id=? AND language=? ORDER BY observed_at DESC LIMIT 1');
  const drop = db.prepare('DELETE FROM funding_editions WHERE source=? AND id=? AND language=?');
  for (const row of previous.values()) {
    const key = [packet.source,row.id,row.language];
    const entry = last.get(...key) as {edition_json:string};
    change.run(...key,observedAt,row.revision,'removed',entry.edition_json);
    dropSections.run(...key);
    drop.run(...key);
    events.removed++;
  }
  return events;
}

/** Publish an entire observed source and its edition history atomically. */
export function materializeFunding(db: LocalDatabase, input: unknown) {
  const packet = checked(input);
  const observedAt = new Date(packet.observedAt).toISOString();
  const revision = hash({ indexes: packet.indexes, records: packet.records, gaps: packet.gaps });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(migration, 'utf8'));
    const old = db.prepare('SELECT observed_at,revision FROM funding_catalogues WHERE source=?').get(packet.source) as
      {observed_at:string; revision:string} | undefined;
    if (old && (old.observed_at > observedAt || (old.observed_at === observedAt && old.revision !== revision))) {
      throw new Error('A newer or conflicting funding observation already exists.');
    }
    const events = old?.revision === revision ? {added:0,changed:0,removed:0} : updateEditions(db,packet,observedAt);
    db.prepare(`INSERT INTO funding_catalogues (source,observed_at,revision,indexes_json,gaps_json) VALUES (?,?,?,?,?)
      ON CONFLICT(source) DO UPDATE SET observed_at=excluded.observed_at,revision=excluded.revision,
      indexes_json=excluded.indexes_json,gaps_json=excluded.gaps_json`)
      .run(packet.source,observedAt,revision,JSON.stringify(packet.indexes),JSON.stringify(packet.gaps));
    db.exec('COMMIT');
    return { source: packet.source, observedAt, revision, editions: packet.records.length, gaps: packet.gaps.length, events };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

if (import.meta.main) {
  const [path,...inputs] = process.argv.slice(2);
  if (!path || !inputs.length) throw new Error('Usage: bun scripts/materialize-funding.ts LOCAL.sqlite INVENTORY.json [...]');
  const { Database } = createRequire(import.meta.url)('bun:sqlite') as {
    Database: new (file: string, options: {create: boolean}) => LocalDatabase & {close():void};
  };
  mkdirSync(dirname(path), {recursive:true});
  const db = new Database(path, {create:true});
  try {
    for (const file of inputs) console.log(JSON.stringify(materializeFunding(db,JSON.parse(readFileSync(file,'utf8')))));
  } finally { db.close(); }
}
