import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { OpportunityDeadlineSchema, type OpportunityDeadline } from '../../src/corpora/opportunity';

type Language = 'en' | 'fr';
interface CallMetadata {
  observedAt: string;
  firstObservedAt?: string;
  lastListedAt?: string;
  deadline?: OpportunityDeadline | null;
  listed?: boolean;
  studyId: string;
  instructions?: string;
  delivery?: string;
  instructionUrl?: string;
  contentWarning?: boolean;
}
type Row = { id: string; language: Language; title: string; url: string; committee_id: string; metadata_json: string };
type ReceiptCall = { id: string; language: Language; title: string; citation: string; committeeId: string;
  instructionUrl: string | null; deadline: OpportunityDeadline | null; hasContentWarning: boolean };
export interface CommitteeCallsReceipt {
  observedAt: string;
  session: string;
  calls: ReceiptCall[];
  droppedCalls?: Array<{ id: string; language: Language; lastListedAt: string }>;
}

export const committeeSession = '45-1';
export const committeeAcquisitionPath = process.env.CIVICSIGNAL_COMMITTEES_SOURCE_SQLITE ?? 'data/corpus/committees/committee.sqlite';
export const originalCommitteeCutoff = '2026-11-24T00:07:12+00:00';
export const frozenCalls = () => JSON.parse(readFileSync(
  'docs/evidence/2026-11-24/committee-calls-acceptance.json', 'utf8')) as {
    acquisition: { observedAt: string; callsPerEdition: Record<Language, number> };
    queries: { englishOpenNow: number; apprenticeship: { items: number; hasMore: boolean } };
    detail: { id: string; study: { id: string; title: string; url: string };
      related: { submissions: number; evidence: number; meetings: number }; instructionUrl: string;
      status: string; statusBasis: string; frenchStatus: string; instructionsCharacters: number;
      instructionsTruncated: boolean };
  };

const iso = (value: string) => new Date(value).toISOString();
export const committeeCallTime = iso;

export function committeeCallRows(db: DatabaseSync, query?: string) {
  const like = query === undefined ? '' : "AND (title LIKE ? OR json_extract(metadata_json,'$.instructions') LIKE ?)";
  const bind = query === undefined ? [] : [`%${query}%`, `%${query}%`];
  const rows = db.prepare(`SELECT id,language,title,url,committee_id,metadata_json FROM cc_records
    WHERE session=? AND kind='call' ${like} ORDER BY id,language`).all(committeeSession, ...bind) as Row[];
  return rows.map(({ metadata_json, ...row }) => ({ ...row, metadata: JSON.parse(metadata_json) as CallMetadata }));
}

function callState(firstObservedAt: string, lastListedAt: string, asOf: string, deadline: OpportunityDeadline | null) {
  if (asOf < firstObservedAt) return { status: 'unknown', statusBasis: 'unobserved' };
  if (deadline?.instant) return { status: asOf <= iso(deadline.instant) ? 'open' : 'closed', statusBasis: 'deadline' };
  return { status: asOf.slice(0, 10) <= lastListedAt.slice(0, 10) ? 'open' : 'unknown', statusBasis: 'listing-observation' };
}

export function committeeCallExpected(db: DatabaseSync, row: ReturnType<typeof committeeCallRows>[number], asOf: string) {
  const { metadata } = row;
  const observedAt = iso(metadata.observedAt);
  const firstObservedAt = iso(metadata.firstObservedAt ?? metadata.observedAt);
  const lastListedAt = iso(metadata.lastListedAt ?? metadata.observedAt);
  const deadline = OpportunityDeadlineSchema.nullable().parse(metadata.deadline ?? null);
  const instructions = metadata.delivery === 'excerpt' && typeof metadata.instructions === 'string'
    ? metadata.instructions
    : null;
  const study = db.prepare(`SELECT id,title,url FROM cc_records
    WHERE session=? AND language=? AND id=? AND kind='study'`)
    .get(committeeSession, row.language, `${row.committee_id}-study-${metadata.studyId}`) ?? null;
  return { id: row.id, language: row.language, title: row.title, url: row.url, listed: metadata.listed !== false,
    firstObservedAt, observedAt, lastListedAt, deadline, committee: { id: row.committee_id }, study,
    instructions: instructions?.slice(0, 400) ?? null, instructionsTruncated: (instructions?.length ?? 0) > 400,
    instructionUrl: metadata.instructionUrl ?? null, contentWarning: metadata.contentWarning === true,
    ...callState(firstObservedAt, lastListedAt, asOf, deadline) };
}

export function committeeCallRelated(db: DatabaseSync, language: Language, studyId: string | null) {
  const related = { submissions: 0, evidence: 0, meetings: 0 };
  if (!studyId) return related;
  const rows = db.prepare(`SELECT child.kind FROM cc_links links JOIN cc_records child
    ON child.session=links.session AND child.language=links.language AND child.id=links.child_id
    WHERE links.session=? AND links.language=? AND links.parent_id=?`).all(committeeSession, language, studyId);
  for (const { kind } of rows) {
    if (kind === 'submission' || kind === 'brief') related.submissions++;
    if (kind === 'evidence') related.evidence++;
    if (kind === 'meeting') related.meetings++;
  }
  return related;
}

export function committeeCutoff(db: DatabaseSync) {
  return db.prepare('SELECT cutoff FROM cc_snapshot WHERE session=?').get(committeeSession)?.cutoff;
}

export function archivedCommitteeRecord(db: DatabaseSync, id: string, language: Language) {
  const row = db.prepare(`SELECT kind,chamber,title,url,status,object_sha256 AS objectSha256,metadata_json FROM cc_records
    WHERE session=? AND id=? AND language=?`)
    .get(committeeSession, id, language);
  if (!row) return undefined;
  const { metadata_json, ...fields } = row;
  return { id, language, ...fields, metadata: JSON.parse(String(metadata_json)) as Record<string, unknown> };
}

export function archivedCommitteeCoverage(db: DatabaseSync) {
  return db.prepare(`SELECT coalesce(committee_id, CASE WHEN kind='committee' THEN id END) AS committeeId,
    chamber, language, kind, status, count(*) AS count FROM cc_records
    WHERE session=? AND language='en' AND (committee_id='house-envi' OR (kind='committee' AND id='house-envi'))
    GROUP BY committeeId,chamber,language,kind,status ORDER BY committeeId,chamber,language,kind,status`)
    .all(committeeSession);
}

export function archivedCommitteeEvidenceMatches(db: DatabaseSync, language: Language, term: 'water' | 'eau') {
  const row = db.prepare(`SELECT count(*) AS hits FROM cc_fts f JOIN cc_records r
    ON r.session=f.session AND r.id=f.document_id AND r.language=f.language
    WHERE cc_fts MATCH ? AND f.session=? AND f.language=? AND r.committee_id='house-envi' AND r.kind='evidence'`)
    .get(term, committeeSession, language);
  return Number(row?.hits);
}
