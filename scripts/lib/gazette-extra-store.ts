import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeForSearch } from '../../src/text';
import { GazetteExtraIssueSchema, GazetteExtraRecordSchema, gazetteExtraIssueId, gazetteExtraRecordBelongsToIssue,
  type GazetteExtraEdition, type GazetteExtraIssueKey, type GazetteExtraRecord } from '../../src/corpora/gazette-extra';
import type { FeedRecord } from '../../src/corpora/source-feed';
import { initializeSourceFeed, recordSourceChanges } from './source-feed-store';

export const GAZETTE_EXTRA_PARSER_VERSION = 'gazette-extra-metadata-v1';
const editionSchema = GazetteExtraIssueSchema.extend({ records: GazetteExtraRecordSchema.array().min(1) });
function issueKey(edition: GazetteExtraEdition): GazetteExtraIssueKey {
  const { records: _records, ...key } = edition;
  return GazetteExtraIssueSchema.parse(key);
}

function publicMetadata(record: GazetteExtraRecord) {
  return { id: record.id, editionType: record.editionType, part: record.part, language: record.language,
    issueDate: record.issueDate, volume: record.volume, extraNumber: record.extraNumber, kind: record.kind,
    title: record.title, citationUrl: record.citationUrl, registrationNumber: record.registrationNumber ?? null,
    registrationDate: record.registrationDate ?? null, consultationDeadline: record.consultationDeadline ?? null,
    effectiveDate: record.effectiveDate ?? null };
}

export function gazetteExtraEditionDigest(edition: GazetteExtraEdition): string {
  const value = { ...issueKey(edition), records: edition.records.map(publicMetadata).sort((a, b) => a.id.localeCompare(b.id)) };
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function validateGazetteExtraEdition(value: unknown): GazetteExtraEdition {
  const parsed = editionSchema.parse(value);
  const key = issueKey(parsed);
  const ids = new Set<string>();
  for (const record of parsed.records) {
    if (!gazetteExtraRecordBelongsToIssue(record, key)) throw new Error('Gazette extra record ID and citation must identify the matching extra edition.');
    if (ids.has(record.id)) throw new Error(`Duplicate Gazette extra record ID: ${record.id}`);
    ids.add(record.id);
    if (key.part === 'I' && record.kind === 'instrument') throw new Error('Part I extras cannot be instruments.');
    if (key.part === 'II' && record.kind !== 'instrument') throw new Error('Part II extra records must be instruments.');
  }
  return parsed;
}

function toFeedRecord(record: GazetteExtraRecord): FeedRecord {
  const metadata = publicMetadata(record);
  return { id: record.id, citationUrl: record.citationUrl, publicationDate: record.issueDate,
    label: record.title, searchText: normalizeForSearch([record.title, record.registrationNumber].filter(Boolean).join(' ')),
    fingerprint: createHash('sha256').update(JSON.stringify(metadata)).digest('hex') };
}

function storedFeedRecords(sqlite: DatabaseSync, key: GazetteExtraIssueKey): FeedRecord[] {
  const rows = sqlite.prepare(`SELECT id,edition_type AS editionType,part,language,issue_date AS issueDate,volume,
    extra_number AS extraNumber,kind,title,citation_url AS citationUrl,registration_number AS registrationNumber,
    registration_date AS registrationDate,consultation_deadline AS consultationDeadline,effective_date AS effectiveDate
    FROM gazette_extra_records WHERE part=? AND language=? AND issue_date=? AND volume=? AND extra_number=? ORDER BY id`)
    .all(key.part, key.language, key.issueDate, key.volume, key.extraNumber) as GazetteExtraRecord[];
  return rows.map(toFeedRecord);
}

function importValidated(sqlite: DatabaseSync, edition: GazetteExtraEdition) {
  const digest = gazetteExtraEditionDigest(edition);
  initializeSourceFeed(sqlite);
  const before = storedFeedRecords(sqlite, edition);
  const after = edition.records.map(toFeedRecord);
  const feedScope = { source: 'gazette' as const, language: edition.language,
    editionId: gazetteExtraIssueId(edition), publicationDate: edition.issueDate, part: edition.part };
  const existing = sqlite.prepare(`SELECT content_sha256 AS digest,parser_version AS parserVersion FROM gazette_extra_editions
    WHERE part=? AND language=? AND issue_date=? AND volume=? AND extra_number=?`)
    .get(edition.part, edition.language, edition.issueDate, edition.volume, edition.extraNumber) as
    { digest: string; parserVersion: string } | undefined;
  if (existing?.digest === digest && existing.parserVersion === GAZETTE_EXTRA_PARSER_VERSION) {
    recordSourceChanges(sqlite, feedScope, before, before);
    return { ...issueKey(edition), status: 'unchanged' as const, written: 0,
      removed: 0, recordCount: edition.records.length };
  }
  const removed = Number(sqlite.prepare(`DELETE FROM gazette_extra_records
    WHERE part=? AND language=? AND issue_date=? AND volume=? AND extra_number=?`)
    .run(edition.part, edition.language, edition.issueDate, edition.volume, edition.extraNumber).changes);
  sqlite.prepare(`INSERT INTO gazette_extra_editions
    (part,language,issue_date,volume,extra_number,record_count,content_sha256,parser_version)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(part,language,issue_date,volume,extra_number) DO UPDATE SET
      record_count=excluded.record_count,content_sha256=excluded.content_sha256,parser_version=excluded.parser_version,
      imported_at=CURRENT_TIMESTAMP`).run(edition.part, edition.language, edition.issueDate, edition.volume,
    edition.extraNumber, edition.records.length, digest, GAZETTE_EXTRA_PARSER_VERSION);
  const insert = sqlite.prepare(`INSERT INTO gazette_extra_records
    (id,edition_type,part,language,issue_date,volume,extra_number,kind,title,citation_url,registration_number,
     registration_date,consultation_deadline,effective_date,search_text)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const record of edition.records) insert.run(record.id, 'extra', record.part, record.language, record.issueDate,
    record.volume, record.extraNumber, record.kind, record.title, record.citationUrl, record.registrationNumber ?? null,
    record.registrationDate ?? null, record.consultationDeadline ?? null, record.effectiveDate ?? null,
    normalizeForSearch([record.title, record.registrationNumber].filter(Boolean).join(' ')));
  recordSourceChanges(sqlite, feedScope, before, after);
  return { ...issueKey(edition), status: 'imported' as const, written: edition.records.length,
    removed, recordCount: edition.records.length };
}

export function importGazetteExtraEditionBatch(sqlite: DatabaseSync, inputs: readonly unknown[]) {
  const editions = inputs.map(validateGazetteExtraEdition);
  const identities = editions.map(gazetteExtraIssueId);
  if (!editions.length || editions.length > 64 || new Set(identities).size !== identities.length) {
    throw new Error('A Gazette extra batch must contain 1 to 64 distinct bilingual edition entries.');
  }
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const result = editions.map((edition) => importValidated(sqlite, edition));
    sqlite.exec('COMMIT');
    return result;
  } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
}

export function storedGazetteExtraEditionDigest(sqlite: DatabaseSync, key: GazetteExtraIssueKey): string | undefined {
  return (sqlite.prepare(`SELECT content_sha256 AS digest FROM gazette_extra_editions
    WHERE part=? AND language=? AND issue_date=? AND volume=? AND extra_number=?`)
    .get(key.part, key.language, key.issueDate, key.volume, key.extraNumber) as { digest: string } | undefined)?.digest;
}

export type { GazetteExtraEdition, GazetteExtraIssueKey, GazetteExtraRecord };
