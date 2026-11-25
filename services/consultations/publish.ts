import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CsvParser } from '../../src/csv';
import {
  CONSULTATION_SOURCE, consultationFromRow, consultationId, readConsultationDictionary,
} from '../../src/corpora/consultations';
import { canonical, changedPaths, publishedFacts } from '../../src/corpora/consultations-revision';
import type { ConsultationMaterializerInput } from '../../src/corpora/consultations-materialize';

type Totals = { rowsRead: number; rowsWritten: number };
type Catalogue = { observed_at: string; revision: string; csv_sha256: string; schema_sha256: string; record_count: number };
type Existing = { id: string; published_hash: string; removed_at: string | null };
type Pending = { id: string; event: 'added' | 'changed' | 'removed'; publishedHash?: string;
  facts?: string; searchEn?: string; searchFr?: string; changedFields: string[] };

function account(totals: Totals, result: D1Result) {
  totals.rowsRead += result.meta.rows_read;
  totals.rowsWritten += result.meta.rows_written;
}

function* sourceRows(csv: string) {
  const parser = new CsvParser();
  let header: string[] | undefined;
  function* entries(rows: Generator<string[]>) {
    for (const fields of rows) {
      if (!header) {
        header = fields.map(name => name.trim());
        continue;
      }
      if (fields.length !== header.length) throw new Error('Consultation CSV row width differs from its header.');
      yield Object.fromEntries(header.map((key, index) => [key, fields[index]])) as Record<string, string>;
    }
  }
  yield* entries(parser.read(csv.replace(/^\uFEFF/, '')));
  yield* entries(parser.finish());
}

// Keep compact row strings for sorting. The full publisher CSV includes several
// thousand long bilingual descriptions. Retaining the parser's string ropes or a
// second copy of all normalized facts would exhaust a Worker's isolate memory.
function sortedRows(csv: string) {
  const raw = new Map<string, string>();
  for (const row of sourceRows(csv)) {
    const id = consultationId(row.owner_org?.trim() ?? '', row.registration_number?.trim() ?? '');
    if (raw.has(id)) throw new Error(`Consultations CSV contains duplicate id: ${id}`);
    raw.set(id, JSON.stringify(row));
  }
  return [...raw].sort(([a], [b]) => a.localeCompare(b, 'en'));
}

async function readHead(db: D1Database, totals: Totals) {
  const result = await db.prepare('SELECT * FROM consultations_catalogues WHERE source=?')
    .bind(CONSULTATION_SOURCE).all<Catalogue>();
  account(totals, result);
  return result.results[0];
}

async function readExisting(db: D1Database, totals: Totals) {
  const existing = new Map<string, Existing>();
  let cursor = '';
  for (;;) {
    const result = await db.prepare('SELECT id,published_hash,removed_at FROM consultation_items WHERE id>? ORDER BY id LIMIT 512')
      .bind(cursor).all<Existing>();
    account(totals, result);
    for (const row of result.results) {
      existing.set(row.id, row);
      cursor = row.id;
    }
    if (result.results.length < 512) return existing;
  }
}

async function stage(db: D1Database, candidate: string, observedAt: string, pending: Pending[], totals: Totals) {
  if (pending.length === 0) return;
  const changed = pending.filter(row => row.event === 'changed');
  if (changed.length) {
    const old = await db.prepare('SELECT id,facts_json FROM consultation_items WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(changed.map(row => row.id))).all<{ id: string; facts_json: string }>();
    account(totals, old);
    const byId = new Map(old.results.map(row => [row.id, row.facts_json]));
    for (const row of changed) {
      const oldFacts = byId.get(row.id);
      if (!oldFacts || !row.facts) throw new Error('Missing consultation facts for change verification.');
      row.changedFields = changedPaths(publishedFacts(JSON.parse(oldFacts)), publishedFacts(JSON.parse(row.facts)))
        .sort((a, b) => a.localeCompare(b, 'en'));
    }
  }
  const result = await db.prepare(`INSERT INTO consultation_pending
    (candidate,observed_at,id,event,published_hash,facts_json,search_en,search_fr,changed_fields_json)
    SELECT ?,?,value->>'$.id',value->>'$.event',value->>'$.publishedHash',value->>'$.facts',
      value->>'$.searchEn',value->>'$.searchFr',value->>'$.changedFields' FROM json_each(?)
    WHERE true ON CONFLICT(candidate,id) DO NOTHING`)
    .bind(candidate, observedAt, JSON.stringify(pending)).run();
  account(totals, result);
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function stageChanges(db: D1Database, input: ConsultationMaterializerInput, observedAt: string,
  candidate: string, totals: Totals) {
  const entries = sortedRows(input.csvText);
  const dictionary = readConsultationDictionary(input.dictionaryJson);
  const previous = await readExisting(db, totals);
  const digest = createHash('sha256').update(`{"csvSha256":"${input.csvSha256}","records":[`);
  let pending: Pending[] = [];
  let count = 0;
  for (const [id, serializedRow] of entries) {
    const { facts, searchText } = consultationFromRow(JSON.parse(serializedRow), dictionary, observedAt);
    const published = publishedFacts(facts);
    const text = canonical(published);
    digest.update(count++ ? ',' : '').update(text);
    const hash = sha256(text);
    const old = previous.get(id);
    previous.delete(id);
    if (old?.published_hash === hash && old.removed_at === null) continue;
    const event = old && old.removed_at === null ? 'changed' : 'added';
    pending.push({ id, event, publishedHash: hash, facts: JSON.stringify(facts),
      searchEn: searchText.en, searchFr: searchText.fr, changedFields: [] });
    if (pending.length === 16) {
      await stage(db, candidate, observedAt, pending, totals);
      pending = [];
    }
  }
  for (const row of previous.values()) {
    if (row.removed_at === null) {
      pending.push({ id: row.id, event: 'removed', changedFields: [] });
      if (pending.length === 16) {
        await stage(db, candidate, observedAt, pending, totals);
        pending = [];
      }
    }
  }
  await stage(db, candidate, observedAt, pending, totals);
  digest.update(`],"schemaSha256":"${input.schemaSha256}","source":"${CONSULTATION_SOURCE}"}`);
  return { revision: digest.digest('hex'), rows: count };
}

function commitChanges(db: D1Database, candidate: string, observedAt: string, priorAt: string | null) {
  return [
    db.prepare(`INSERT INTO consultations_revisions (id,observed_at,revision,event,changed_fields_json,facts_json)
      SELECT p.id,?,COALESCE(i.revision,0)+1,p.event,p.changed_fields_json,COALESCE(p.facts_json,(SELECT r.facts_json FROM consultations_records r WHERE r.id=p.id))
      FROM consultation_pending p LEFT JOIN consultation_items i ON i.id=p.id WHERE p.candidate=?`).bind(observedAt,candidate),
    db.prepare(`INSERT INTO consultation_items
      (id,published_hash,facts_json,search_en,search_fr,first_observed_at,revision)
      SELECT id,published_hash,facts_json,search_en,search_fr,?,1 FROM consultation_pending
      WHERE candidate=? AND event<>'removed'
      ON CONFLICT(id) DO UPDATE SET published_hash=excluded.published_hash,facts_json=excluded.facts_json,
        search_en=excluded.search_en,search_fr=excluded.search_fr,revision=consultation_items.revision+1,
        removed_at=NULL,last_seen_before_removal=NULL`).bind(observedAt,candidate),
    db.prepare(`UPDATE consultation_items SET removed_at=?,last_seen_before_removal=?,revision=revision+1
      WHERE id IN (SELECT id FROM consultation_pending WHERE candidate=? AND event='removed')`).bind(observedAt,priorAt,candidate),
  ];
}

type Publication = { input: ConsultationMaterializerInput; observedAt: string; candidate: string;
  revision: string; rows: number; head: Catalogue | undefined; replayed: boolean };

async function commit(db: D1Database, publication: Publication, totals: Totals) {
  const { input, observedAt, candidate, revision, rows, head, replayed } = publication;
  // D1 rolls back the entire batch if the optimistic head check fails. Overlapping
  // observations must re-diff against the winner before touching serving records.
  const batch = [
    db.prepare(`INSERT INTO consultation_commit_guard SELECT
      (SELECT observed_at FROM consultations_catalogues WHERE source=?) IS ? AND
      (SELECT revision FROM consultations_catalogues WHERE source=?) IS ?`)
      .bind(CONSULTATION_SOURCE,head?.observed_at ?? null,CONSULTATION_SOURCE,head?.revision ?? null),
    ...(replayed ? [] : commitChanges(db,candidate,observedAt,head?.observed_at ?? null)),
    db.prepare(`INSERT INTO consultations_catalogues (source,observed_at,revision,csv_sha256,schema_sha256,
      csv_source_json,schema_source_json,record_count) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(source) DO UPDATE SET observed_at=excluded.observed_at,revision=excluded.revision,
      csv_sha256=excluded.csv_sha256,schema_sha256=excluded.schema_sha256,
      csv_source_json=excluded.csv_source_json,schema_source_json=excluded.schema_source_json,record_count=excluded.record_count`)
      .bind(CONSULTATION_SOURCE,observedAt,revision,input.csvSha256,input.schemaSha256,
        JSON.stringify(input.csvSource ?? {}),JSON.stringify(input.schemaSource ?? {}),rows),
    db.prepare('DELETE FROM consultation_pending WHERE observed_at<=?').bind(observedAt),
    db.prepare('DELETE FROM consultation_commit_guard'),
  ];
  for (const result of await db.batch(batch)) account(totals, result);
}

export async function publishConsultations(db: D1Database, input: ConsultationMaterializerInput) {
  if (![input.csvSha256, input.schemaSha256].every(hash => /^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('Invalid consultation source hashes.');
  }
  const observedAt = new Date(z.iso.datetime({ offset:true }).parse(input.observedAt)).toISOString();
  const totals = { rowsRead: 0, rowsWritten: 0 };
  const head = await readHead(db, totals);
  const replayed = Boolean(head && head.csv_sha256 === input.csvSha256 && head.schema_sha256 === input.schemaSha256);
  if (head && (head.observed_at > observedAt || (head.observed_at === observedAt && !replayed))) {
    throw new Error('A newer or conflicting consultation observation already exists.');
  }
  const first = sourceRows(input.csvText).next().value;
  if (!first) throw new Error('Empty consultations catalogue.');
  const { facts } = consultationFromRow(first, readConsultationDictionary(input.dictionaryJson), observedAt);
  const sample = { sampleId: facts.id, sampleTitles: { en: facts.editions.en.title, fr: facts.editions.fr.title } };
  if (head && replayed && head.observed_at === observedAt) {
    return { observedAt, revision: head.revision, rows: head.record_count, replayed, ...sample, ...totals };
  }
  const candidate = sha256(JSON.stringify([head?.observed_at,head?.revision,observedAt,input.csvSha256,input.schemaSha256]));
  const { revision, rows } = head && replayed ? { revision: head.revision, rows: head.record_count }
    : await stageChanges(db,input,observedAt,candidate,totals);
  await commit(db, { input, observedAt, candidate, revision, rows, head, replayed }, totals);
  return { observedAt, revision, rows, replayed, ...sample, ...totals };
}
