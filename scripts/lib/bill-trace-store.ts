import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { BILL_KEY, BillRecordSchema, CommitteePacketSchema, BillSourceSchema, type BillSource, type BillTraceRecord } from '../../src/corpora/bill-trace';
import { loadBillSpine } from './bill-legisinfo';

const schema = readFileSync(new URL('../../preview/bills/migrations/0001_bill_trace.sql', import.meta.url), 'utf8');
const committeeKinds = ['study', 'meeting', 'minutes', 'evidence', 'report', 'amendment'];
const kindsBySource: Record<BillSource, readonly string[]> = {
  legisinfo: ['version', 'stage'], house: committeeKinds, senate: committeeKinds, vote: ['vote'], journals: ['journal'],
};

type SourceInput = { source: BillSource; records: BillTraceRecord[] | null };
function loadCommittee(directory: string, source: 'house' | 'senate') {
  const packet = CommitteePacketSchema.parse(JSON.parse(readFileSync(join(directory, source + '.json'), 'utf8')));
  if (packet.source !== source) throw new Error('Committee packet source mismatch.');
  return packet.records;
}

function loadSource(directory: string, source: BillSource): SourceInput {
  try {
    const input: unknown = source === 'house' || source === 'senate'
      ? loadCommittee(directory, source)
      : loadBillSpine(directory, source);
    const records = BillRecordSchema.array().nonempty().parse(input);
    for (const row of records) {
      if (!kindsBySource[source].includes(row.kind)) throw new Error(`Unexpected ${source} record kind: ${row.kind}`);
      if ((source === 'house' || source === 'senate') && row.chamber !== source) throw new Error('Committee chamber mismatch.');
      if ((row.kind === 'amendment') !== Boolean(row.amendment)) throw new Error('An amendment requires its clause and disposition.');
      if ((row.kind === 'vote') !== Boolean(row.tally)) throw new Error('A vote requires its official tally.');
      row.links.sort((a, b) => a.relation.localeCompare(b.relation) || a.target.localeCompare(b.target));
    }
    for (const kind of kindsBySource[source]) {
      if (!records.some((row) => row.kind === kind)) throw new Error(`Missing ${kind} in ${source} packet.`);
    }
    return { source, records: records.sort((a, b) => a.id.localeCompare(b.id)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { source, records: null };
    throw error;
  }
}

function verifyHouseDivision(records: BillTraceRecord[], missing: Set<BillSource>) {
  if (missing.has('journals') || missing.has('vote')) return;
  const journal = records.find((record) => record.kind === 'journal' && record.chamber === 'house');
  const division = journal?.division;
  const vote = records.find((record) => record.kind === 'vote' && record.sourceId === String(division?.number));
  if (!division || !vote?.tally || !journal?.links.some((edge) => edge.target === vote.id)) {
    throw new Error('The House Journal must identify the recorded division.');
  }
  const fields = ['yeas', 'nays', 'paired', 'result'] as const;
  if (journal.date !== vote.date || fields.some((key) => division[key] !== vote.tally?.[key])) {
    throw new Error('House Journal and recorded vote disagree.');
  }
}

function validateGraph(inputs: SourceInput[]) {
  const ids = new Set<string>();
  const records = inputs.flatMap((input) => input.records ?? []);
  const missing = new Set(inputs.filter((input) => !input.records).map((input) => input.source));
  const namespaces: Record<string, BillSource> = { version: 'legisinfo', stage: 'legisinfo', house: 'house', senate: 'senate',
    vote: 'vote', journal: 'journals' };
  verifyHouseDivision(records, missing);
  for (const { id } of records) {
    if (ids.has(id)) throw new Error('Duplicate bill trace ID: ' + id);
    ids.add(id);
  }
  for (const record of records) {
    const edges = new Set<string>();
    for (const { target, relation } of record.links) {
      const owner = namespaces[target.split(':')[0] ?? ''];
      if (!ids.has(target) && !missing.has(owner)) throw new Error(`Unresolved bill trace link ${record.id} -> ${target}`);
      const key = relation + ':' + target;
      if (target === record.id || edges.has(key)) throw new Error('Invalid or repeated bill trace link: ' + record.id);
      edges.add(key);
    }
  }
}

function saveSource(db: DatabaseSync, input: SourceInput, observedAt: string) {
  const previous = db.prepare('SELECT records_json, available FROM bill_trace_sources WHERE bill_key = ? AND source = ?')
    .get(BILL_KEY, input.source) as { records_json: string; available: number } | undefined;
  const json = input.records ? JSON.stringify(input.records) : previous?.records_json ?? '[]';
  const available = input.records === null ? 0 : 1;
  if (previous?.records_json === json && previous.available === available) return 0;
  db.prepare(`INSERT INTO bill_trace_sources (bill_key, source, available, records_json) VALUES (?, ?, ?, ?)
    ON CONFLICT(bill_key,source) DO UPDATE SET available=excluded.available, records_json=excluded.records_json`)
    .run(BILL_KEY, input.source, available, json);
  if (!input.records || json === previous?.records_json) return 0;
  const prior = BillRecordSchema.array().parse(JSON.parse(previous?.records_json ?? '[]'));
  const before = new Map(prior.map((row) => [row.id, JSON.stringify(row)]));
  const after = new Map(input.records.map((row) => [row.id, JSON.stringify(row)]));
  const insert = db.prepare(`INSERT INTO bill_trace_events (bill_key,source,record_id,change,record_json,observed_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  let events = 0;
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(id), current = after.get(id);
    if (old === current) continue;
    insert.run(BILL_KEY, input.source, id, current === undefined ? 'removed' : old === undefined ? 'added' : 'corrected',
      current ?? old ?? '', observedAt);
    events++;
  }
  return events;
}

/** The five sources form one observation. Unavailable input changes coverage only. */
export function replayBillTrace(db: DatabaseSync, directory: string) {
  if (!statSync(directory).isDirectory()) throw new Error('Expected a bill packet directory.');
  const inputs = BillSourceSchema.options.map((source) => loadSource(directory, source));
  validateGraph(inputs);
  const observedAt = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(schema);
    const events = inputs.reduce((sum, input) => sum + saveSource(db, input, observedAt), 0);
    db.exec('COMMIT');
    return { bill: BILL_KEY, events,
      missing: inputs.filter((input) => !input.records).map((input) => input.source),
      records: inputs.reduce((sum, input) => sum + (input.records?.length ?? 0), 0) };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
