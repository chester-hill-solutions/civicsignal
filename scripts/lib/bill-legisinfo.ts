import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BillRecordSchema, PILOT_BILL, type BillTraceRecord } from '../../src/corpora/bill-trace';

export type BillSpineSource = 'legisinfo' | 'vote' | 'journals';
const text = z.string().min(1);
const localTime = z.iso.datetime({ local: true });
const identity = { ParliamentNumber: z.literal('44'), SessionNumber: z.literal('1') };
const legisinfoSchema = z.object({
  bill: z.object({ ...identity, Id: z.literal('11558854'), NumberCode: z.literal('S-5') }),
  publications: z.array(z.object({
    PublicationId: text, PublicationTypeId: text, PublicationTypeNameEn: text, PublicationTypeNameFr: text,
  })).length(3),
  stages: z.array(z.object({
    ChamberOrganizationId: z.enum(['1', '2']), BillStageId: text, EventTypeId: text,
    EventNameEn: text, EventNameFr: text, EventDateTime: localTime,
  })).length(11),
  concurrence: z.object({ Date: localTime, EventNameEn: text, EventNameFr: text,
    MeetingNumber: z.literal('133'), ChamberOrganizationId: z.literal('2') }),
});
const count = z.number().int().nonnegative();
const voteSchema = z.object({
  ...identity, DivisionNumber: z.literal('338'), DecisionEventDateTime: localTime,
  DivisionSubjectEn: text, DivisionSubjectFr: text, DecisionResultName: z.enum(['Agreed To', 'Negatived']),
  counts: z.strictObject({ yeas: count, nays: count, paired: count }),
});

// Event types recur in both chambers. Resolve each against the session-scoped source record.
const stageIds: Record<string, string> = {
  '2:60110': 'stage:senate:first-reading', '2:60120': 'stage:senate:second-reading',
  '2:60123': 'stage:senate:referral', '2:60124': 'stage:senate:committee',
  '2:60134': 'stage:senate:third-reading', '1:60111': 'stage:house:first-reading',
  '1:60121': 'stage:house:second-reading', '1:60124': 'stage:house:committee',
  '1:60285': 'stage:house:report', '1:60134': 'stage:house:third-reading', '2:60149': 'stage:royal-assent',
};
const stageEvidence: Record<string, BillTraceRecord['links']> = {
  'stage:house:second-reading': [{ relation: 'referred-to', target: 'house:study' }],
  'stage:senate:referral': [{ relation: 'referred-to', target: 'senate:study' }],
  'stage:senate:committee': [{ relation: 'reported-in', target: 'senate:report' }],
  'stage:house:committee': [{ relation: 'reported-in', target: 'house:report' }],
  'stage:house:third-reading': [{ relation: 'decided-by', target: 'vote:338' }],
};
const publications = [
  { type: '80701', sourceId: '11558861', id: 'version:first-reading', stage: 'stage:senate:first-reading',
    en: 'first-reading', fr: 'premiere-lecture' },
  { type: '80703', sourceId: '11903126', id: 'version:senate-passed', stage: 'stage:senate:third-reading',
    en: 'third-reading', fr: 'troisieme-lecture' },
  { type: '80704', sourceId: '12541741', id: 'version:royal-assent', stage: 'stage:royal-assent',
    en: 'royal-assent', fr: 'sanction-royal' },
] as const;

function stages(data: z.infer<typeof legisinfoSchema>): BillTraceRecord[] {
  const rows = data.stages.map((event): BillTraceRecord => {
    const id = stageIds[event.ChamberOrganizationId + ':' + event.EventTypeId];
    if (!id) throw new Error('Unexpected LEGISinfo event ' + event.EventTypeId);
    const chamber = event.ChamberOrganizationId === '1' ? 'house' : 'senate';
    return {
      id, kind: 'stage', chamber: id === 'stage:royal-assent' ? 'parliament' : chamber,
      sourceId: event.EventTypeId, stageId: event.BillStageId,
      date: event.EventDateTime.slice(0, 10), sourceDateTime: event.EventDateTime,
      label: { en: event.EventNameEn, fr: event.EventNameFr }, url: PILOT_BILL.url, links: [...(stageEvidence[id] ?? [])],
    };
  });
  if (new Set(rows.map((row) => row.id)).size !== data.stages.length) throw new Error('Duplicate LEGISinfo stage event.');
  const message = data.concurrence;
  rows.push({
    id: 'stage:senate:concurrence', kind: 'stage', chamber: 'senate', sourceId: message.Date,
    date: message.Date.slice(0, 10), sourceDateTime: message.Date, label: { en: message.EventNameEn, fr: message.EventNameFr },
    url: PILOT_BILL.url, links: [{ relation: 'reported-in', target: 'journal:senate-133' }],
  });
  rows.sort((a, b) => String(a.sourceDateTime).localeCompare(String(b.sourceDateTime)));
  rows.forEach((row, index) => {
    const next = rows[index + 1];
    if (next) row.links.push({ relation: 'precedes', target: next.id });
  });
  return rows;
}

function legisinfo(input: unknown): BillTraceRecord[] {
  const data = legisinfoSchema.parse(input);
  const history = stages(data);
  const versions = publications.map((spec, index): BillTraceRecord => {
    const pub = data.publications.find((row) => row.PublicationTypeId === spec.type && row.PublicationId === spec.sourceId);
    const stage = history.find((row) => row.id === spec.stage);
    if (!pub || !stage) throw new Error('Missing publication or stage for ' + spec.id);
    const links: BillTraceRecord['links'] = [{ relation: 'documents', target: stage.id }];
    const previous = publications[index - 1];
    if (previous) links.push({ relation: 'succeeds', target: previous.id });
    return {
      id: spec.id, kind: 'version', chamber: stage.chamber, sourceId: pub.PublicationId, date: stage.date,
      // Some editions of the XML list the French Royal Assent publication with the English label.
      label: { en: pub.PublicationTypeNameEn, fr: spec.en === 'royal-assent' ? 'Sanction royale' : pub.PublicationTypeNameFr },
      url: { en: 'https://www.parl.ca/DocumentViewer/en/44-1/bill/S-5/' + spec.en,
        fr: 'https://www.parl.ca/documentviewer/fr/44-1/projet-loi/S-5/' + spec.fr }, links,
    };
  });
  return [...versions, ...history];
}

function vote(input: unknown): BillTraceRecord[] {
  const row = voteSchema.parse(input);
  return [{
    id: 'vote:338', kind: 'vote', chamber: 'house', sourceId: row.DivisionNumber, date: row.DecisionEventDateTime.slice(0, 10),
    sourceDateTime: row.DecisionEventDateTime, label: { en: row.DivisionSubjectEn, fr: row.DivisionSubjectFr },
    url: { en: 'https://www.ourcommons.ca/Members/en/votes/44/1/338', fr: 'https://www.noscommunes.ca/Membres/fr/votes/44/1/338' },
    links: [{ relation: 'part-of', target: 'stage:house:third-reading' }, { relation: 'reported-in', target: 'journal:house-202' }],
    tally: { ...row.counts, result: row.DecisionResultName === 'Agreed To' ? 'agreed' : 'negatived' },
  }];
}

function journals(input: unknown): BillTraceRecord[] {
  const { records } = z.object({ records: z.array(BillRecordSchema).length(2) }).parse(input);
  if (!records.some((row) => row.id === 'journal:house-202' && row.chamber === 'house' && row.division)
    || !records.some((row) => row.id === 'journal:senate-133' && row.chamber === 'senate')) {
    throw new Error('Missing chamber Journal for S-5.');
  }
  return records;
}

const project = { legisinfo, vote, journals };
export function loadBillSpine(directory: string, source?: BillSpineSource): BillTraceRecord[] {
  const selected = source ? [source] : ['legisinfo', 'vote', 'journals'] as const;
  return selected.flatMap((group) => project[group](JSON.parse(readFileSync(join(directory, group + '.json'), 'utf8'))));
}
