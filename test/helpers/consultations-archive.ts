import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import {
  consultationFromRow, parseConsultationCsv, readConsultationDictionary,
  type ConsultationFacts, type ConsultationLanguage, type ConsultationState,
} from '../../src/corpora/consultations';
import { normalizeForSearch } from '../../src/text';

export const baselineConsultations = {
  observedAt: '2026-11-24T17:00:00.000Z',
  csvSha256: '8f34ce7ba8806f8f65ea68cfe89edaadd8faae3dd874d7ea95c58886c05007fe',
  schemaSha256: '712cf342ed36f8349d71513bb963ada6adf32fb2210582cd331e122bcc5d10da',
};

export type ConsultationObservation = typeof baselineConsultations & { revision: string };
export interface ConsultationReceipt {
  observedAt: string;
  revision: string;
  csv: { sha256: string; bytes: number; rows: number };
  schema: { sha256: string; bytes: number };
  counts: { rows: number; stale: number };
  changes: { sample: Array<{ id: string; event: 'added' | 'changed' | 'removed'; changedFields: string[] }> };
}

export function isBaselineConsultationObservation(observation: ConsultationObservation) {
  return observation.csvSha256 === baselineConsultations.csvSha256
    && observation.schemaSha256 === baselineConsultations.schemaSha256
    && observation.revision === '7888621d0aecf4e73cb412dbb481c1cd929f45df7911ef6cd2c01f7b453da278'
    && [baselineConsultations.observedAt, '2026-11-24T18:00:00.000Z'].includes(observation.observedAt);
}

function readArchived(path: string, sha256: string, extension: string) {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error('Invalid consultation input hash');
  const input = join(dirname(path), 'sources', `${sha256}.${extension}`);
  const bytes = readFileSync(input);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error(`Consultation archive hash mismatch for ${input}`);
  }
  return bytes;
}

export function acquiredConsultations(path: string, observation: ConsultationObservation) {
  const csv = readArchived(path, observation.csvSha256, 'csv');
  const schema = readArchived(path, observation.schemaSha256, 'json');
  const parsedSchema: unknown = JSON.parse(schema.toString('utf8'));
  const dictionary = readConsultationDictionary(parsedSchema);
  const records = parseConsultationCsv(csv.toString('utf8')).rows
    .map(row => consultationFromRow(row, dictionary, observation.observedAt).facts);
  return { records, csvBytes: csv.length, schemaBytes: schema.length };
}

export function archivedConsultationState({ dates }: ConsultationFacts, asOf: string): ConsultationState {
  const day = asOf.slice(0, 10);
  if (dates.start === null || dates.end === null) return 'unknown';
  if (day < dates.start) return 'planned';
  if (day > dates.end) return 'closed';
  return 'open';
}

export function archivedConsultationCoverage(records: ConsultationFacts[], asOf: string) {
  const counts = { total: records.length, byState: { open: 0, planned: 0, closed: 0, unknown: 0 },
    statusCodes: {} as Record<string, number> };
  const editions = { missingDescriptionFr: 0, missingTitleFr: 0,
    profileLinkKinds: { official: 0, 'third-party-wrapper': 0, missing: 0, unparsable: 0 } };
  let available = 0;
  for (const record of records) {
    counts.byState[archivedConsultationState(record, asOf)]++;
    counts.statusCodes[record.statusCode] = (counts.statusCodes[record.statusCode] ?? 0) + 1;
    editions.missingDescriptionFr += Number(!record.editions.fr.description);
    editions.missingTitleFr += Number(!record.editions.fr.title);
    editions.profileLinkKinds[record.editions.en.profile.kind]++;
    available += Number(record.reportAvailableOnline === true);
  }
  return { counts, editions, reports: { available } };
}

export function archivedConsultationSearch(records: ConsultationFacts[], language: ConsultationLanguage,
  query: string, asOf: string) {
  const needle = normalizeForSearch(query);
  return records.filter(({ editions }) => {
    const { title, description } = editions[language];
    return normalizeForSearch(`${title} ${description ?? ''}`).includes(needle);
  }).map(record => ({
    id: record.id, title: record.editions[language].title, dates: record.dates,
    state: archivedConsultationState(record, asOf), statusCode: record.statusCode,
  }));
}

interface ArchivedNoticeSource {
  sourceUrl: string;
  bodySha256?: string;
  bodyBytes?: number;
  objectPath?: string;
  status: string;
}

interface ArchivedNoticeSection {
  sourceUrl: string;
  bodySha256: string;
  heading: string;
  kind: string;
  text: string;
  fragment?: string;
}

export function archivedNoticeEditions(db: DatabaseSync, revision: string, consultationId: string) {
  const rows = db.prepare(`SELECT language, status, sources_json, sections_json FROM notices
    WHERE catalogue_revision=? AND consultation_id=? ORDER BY language`).all(revision, consultationId);
  return rows.map(row => {
    const sources: ArchivedNoticeSource[] = JSON.parse(String(row.sources_json));
    const fetched = sources.filter(source => source.status === 'fetched');
    for (const source of fetched) {
      if (!source.objectPath) throw new Error(`Missing archived notice for ${source.sourceUrl}`);
      const bytes = gunzipSync(readFileSync(source.objectPath));
      if (createHash('sha256').update(bytes).digest('hex') !== source.bodySha256 || bytes.length !== source.bodyBytes) {
        throw new Error(`Archived consultation notice differs from its receipt for ${source.sourceUrl}`);
      }
    }
    const sole = fetched.length === 1 ? fetched[0] : undefined;
    const sections: ArchivedNoticeSection[] = JSON.parse(String(row.sections_json));
    return { consultationId, language: row.language, status: row.status, sourceHash: sole?.bodySha256 ?? null,
      sourceUrl: sole?.sourceUrl ?? null, sections: sections.map(section => {
        if (!fetched.some(source => source.sourceUrl === section.sourceUrl && source.bodySha256 === section.bodySha256)) {
          throw new Error(`Section has no archived source for ${consultationId} ${String(row.language)}`);
        }
        const citation = new URL(section.sourceUrl);
        if (section.fragment && /^[A-Za-z0-9_.:-]{1,160}$/u.test(section.fragment)) citation.hash = section.fragment;
        return { kind: section.kind, heading: section.heading, sourceHash: section.bodySha256, sourceUrl: section.sourceUrl,
          citationUrl: citation.href, quote: section.text.slice(0, 4000) };
      }) };
  });
}
