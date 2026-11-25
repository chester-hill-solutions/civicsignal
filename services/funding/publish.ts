import type { FundingInventory, FundingSource } from '../../src/corpora/funding';
import {
  checkedFundingInventory, editionKey, fundingDigest, fundingRevision, fundingSearchText, type Edition,
} from '../../src/corpora/funding-publication';
import { normalizeForSearch } from '../../src/text';

type Head = { observed_at: string; revision: string };
type PriorEdition = Pick<Edition, 'id' | 'language'> & { revision: string };
type Metrics = { rowsRead: number; rowsWritten: number };
type Observation = {
  source: string;
  observedAt: string;
  revision: string;
  head: Head | undefined;
  candidate: string;
};

function account(metrics: Metrics, results: D1Result[]) {
  for (const { meta } of results) {
    metrics.rowsRead += meta.rows_read;
    metrics.rowsWritten += meta.rows_written;
  }
}

function sample(packet: FundingInventory, language: Edition['language']) {
  const row = packet.records.find(edition => edition.language === language);
  if (!row) throw new Error('No funding edition for lookup in ' + language);
  return { id: row.id, title: row.title, url: row.url, revision: fundingDigest(row) };
}

async function stageDeltas(db: D1Database, observation: Observation, packet: FundingInventory, metrics: Metrics) {
  const prior = await db.prepare('SELECT id,language,revision FROM funding_editions WHERE source=?')
    .bind(observation.source).all<PriorEdition>();
  account(metrics, [prior]);
  const previous = new Map(prior.results.map(row => [editionKey(row), row]));
  const events = { added: 0, changed: 0, removed: 0 };
  const insert = db.prepare(`INSERT INTO funding_pending_editions
    (source,candidate,observed_at,id,language,event,revision,edition_json,search_text,normalized_sections_json)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source,candidate,id,language) DO NOTHING`);
  const prefix = [observation.source, observation.candidate, observation.observedAt];

  for (const row of packet.records) {
    const key = editionKey(row);
    const old = previous.get(key);
    previous.delete(key);
    const revision = fundingDigest(row);
    if (old?.revision === revision) continue;
    const event = old ? 'changed' : 'added';
    const sections = row.sections.map(section => ({ ...section,
      normalizedHeading: normalizeForSearch(section.heading), normalizedText: normalizeForSearch(section.text),
    }));
    account(metrics, [await insert.bind(...prefix, row.id, row.language, event, revision,
      JSON.stringify(row), fundingSearchText(row), JSON.stringify(sections)).run()]);
    events[event]++;
  }
  for (const row of previous.values()) {
    account(metrics, [await insert.bind(...prefix, row.id, row.language, 'removed',
      row.revision, null, null, null).run()]);
    events.removed++;
  }
  return events;
}

function publishDeltas(db: D1Database, { source, candidate }: Observation) {
  const pending = 'SELECT source,id,language FROM funding_pending_editions WHERE source=? AND candidate=?';
  return [
    db.prepare(`INSERT INTO funding_versions (source,id,language,observed_at,revision,event,edition_json)
      SELECT p.source,p.id,p.language,p.observed_at,p.revision,p.event,COALESCE(p.edition_json,
        (SELECT v.edition_json FROM funding_versions v WHERE v.source=p.source AND v.id=p.id AND v.language=p.language
         ORDER BY v.observed_at DESC LIMIT 1))
      FROM funding_pending_editions p WHERE p.source=? AND p.candidate=?`).bind(source, candidate),
    db.prepare(`DELETE FROM funding_sections WHERE (source,id,language) IN (${pending} AND event<>'added')`)
      .bind(source, candidate),
    db.prepare(`DELETE FROM funding_editions WHERE (source,id,language) IN (${pending} AND event='removed')`)
      .bind(source, candidate),
    db.prepare(`INSERT INTO funding_editions (source,id,language,revision,title,url,status,status_text,availability,sections_json,search_text)
      SELECT source,id,language,revision,edition_json->>'$.title',edition_json->>'$.url',edition_json->>'$.status',
        edition_json->>'$.statusText',edition_json->>'$.availability',edition_json->'$.sections',search_text
      FROM funding_pending_editions WHERE source=? AND candidate=? AND event<>'removed'
      ON CONFLICT(source,id,language) DO UPDATE SET revision=excluded.revision,title=excluded.title,url=excluded.url,
        status=excluded.status,status_text=excluded.status_text,availability=excluded.availability,
        sections_json=excluded.sections_json,search_text=excluded.search_text`).bind(source, candidate),
    db.prepare(`INSERT INTO funding_sections (source,id,language,section_index,field,heading,text,url,normalized_heading,normalized_text)
      SELECT p.source,p.id,p.language,s.key,s.value->>'$.field',s.value->>'$.heading',s.value->>'$.text',s.value->>'$.url',
        s.value->>'$.normalizedHeading',s.value->>'$.normalizedText'
      FROM funding_pending_editions p,json_each(p.normalized_sections_json) s
      WHERE p.source=? AND p.candidate=? AND p.event<>'removed'`).bind(source, candidate),
  ];
}

async function commit(db: D1Database, observation: Observation, packet: FundingInventory, replayed: boolean) {
  const { head, source, observedAt, revision } = observation;
  // If the head moved after the diff, the CHECK fails and D1 rolls back the whole batch.
  return db.batch([
    db.prepare(`INSERT INTO funding_commit_guard SELECT
      (SELECT observed_at FROM funding_catalogues WHERE source=?) IS ? AND
      (SELECT revision FROM funding_catalogues WHERE source=?) IS ?`)
      .bind(source, head?.observed_at ?? null, source, head?.revision ?? null),
    ...(replayed ? [] : publishDeltas(db, observation)),
    db.prepare(`INSERT INTO funding_catalogues (source,observed_at,revision,indexes_json,gaps_json) VALUES (?,?,?,?,?)
      ON CONFLICT(source) DO UPDATE SET observed_at=excluded.observed_at,revision=excluded.revision,
        indexes_json=excluded.indexes_json,gaps_json=excluded.gaps_json`)
      .bind(source, observedAt, revision, JSON.stringify(packet.indexes), JSON.stringify(packet.gaps)),
    db.prepare('DELETE FROM funding_pending_editions WHERE source=? AND observed_at<=?').bind(source, observedAt),
    db.prepare('DELETE FROM funding_commit_guard'),
  ]);
}

export async function publishFunding(db: D1Database, expectedSource: FundingSource, input: unknown) {
  const packet = checkedFundingInventory(input);
  const source = packet.source;
  if (source !== expectedSource) throw new Error(`Expected a funding inventory for ${expectedSource}.`);
  const observedAt = new Date(packet.observedAt).toISOString();
  const revision = fundingRevision(packet);
  const metrics = { rowsRead: 0, rowsWritten: 0 };
  const read = await db.prepare('SELECT observed_at,revision FROM funding_catalogues WHERE source=?').bind(source).all<Head>();
  account(metrics, [read]);
  const head = read.results[0];
  const replayed = head?.revision === revision;
  if (head && (head.observed_at > observedAt || (head.observed_at === observedAt && !replayed))) {
    throw new Error('A newer or conflicting funding observation already exists.');
  }
  const candidate = fundingDigest([head?.observed_at, head?.revision, source, observedAt, revision]);
  const observation = { source, observedAt, revision, head, candidate };
  const events = replayed ? { added: 0, changed: 0, removed: 0 } : await stageDeltas(db, observation, packet, metrics);
  if (head?.observed_at !== observedAt) account(metrics, await commit(db, observation, packet, replayed));
  return { source, observedAt, revision, editions: packet.records.length, gaps: packet.gaps.length, replayed,
    events, samples: { en: sample(packet, 'en'), fr: sample(packet, 'fr') }, ...metrics };
}
