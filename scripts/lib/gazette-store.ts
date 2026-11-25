import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeForSearch } from '../../src/text';
import { GazetteIssueSchema, GazetteMetadataSchema, gazetteIssueId, gazetteRecordBelongsToIssue, type GazetteEdition, type GazetteIssueKey, type GazetteRecord } from '../../src/corpora/gazette';
import type { FeedRecord } from '../../src/corpora/source-feed';
import { initializeSourceFeed, recordSourceChanges } from './source-feed-store';

export const GAZETTE_PARSER_VERSION = 'gazette-metadata-v1';

const edition = GazetteIssueSchema.extend({ records: GazetteMetadataSchema.array() });

export interface GazetteImportResult extends GazetteIssueKey {
  status: 'imported' | 'unchanged';
  written: number;
  removed: number;
}

type OptionalMetadata = 'registrationNumber' | 'registrationDate' | 'consultationDeadline' | 'effectiveDate';
type GazetteFeedMetadata = Omit<GazetteRecord, OptionalMetadata> & Partial<Record<OptionalMetadata, string | null>>;

function publicMetadata(item: GazetteFeedMetadata) {
  return {
    id: item.id, part: item.part, language: item.language, issueDate: item.issueDate,
    volume: item.volume, issueNumber: item.issueNumber, kind: item.kind, title: item.title,
    citationUrl: item.citationUrl, registrationNumber: item.registrationNumber ?? null,
    registrationDate: item.registrationDate ?? null, consultationDeadline: item.consultationDeadline ?? null,
    effectiveDate: item.effectiveDate ?? null,
  };
}

function canonicalEdition(value: GazetteEdition) {
  return JSON.stringify({
    part: value.part, language: value.language, issueDate: value.issueDate,
    volume: value.volume, issueNumber: value.issueNumber,
    records: value.records.map(publicMetadata).sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export function gazetteEditionDigest(value: GazetteEdition): string {
  return createHash('sha256').update(canonicalEdition(value)).digest('hex');
}

export function storedGazetteEditionDigest(sqlite: DatabaseSync, key: GazetteIssueKey): string | undefined {
  return (sqlite.prepare(`SELECT content_sha256 AS digest FROM gazette_editions
    WHERE part = ? AND language = ? AND issue_date = ? AND volume = ? AND issue_number = ?`)
    .get(key.part, key.language, key.issueDate, key.volume, key.issueNumber) as { digest: string } | undefined)?.digest;
}

function toFeedRecord(item: GazetteFeedMetadata): FeedRecord {
  return {
    id: item.id,
    citationUrl: item.citationUrl,
    publicationDate: item.issueDate,
    label: item.title,
    searchText: normalizeForSearch([item.title, item.registrationNumber].filter(Boolean).join(' ')),
    fingerprint: createHash('sha256').update(JSON.stringify(publicMetadata(item))).digest('hex'),
  };
}

function storedFeedRecords(sqlite: DatabaseSync, value: GazetteEdition): FeedRecord[] {
  const table = value.part === 'I' ? 'gazette_notices' : 'gazette_instruments';
  const rows = sqlite.prepare(`SELECT id, part, language, issue_date AS issueDate, volume, issue_number AS issueNumber,
    kind, title, citation_url AS citationUrl, registration_number AS registrationNumber,
    registration_date AS registrationDate, consultation_deadline AS consultationDeadline, effective_date AS effectiveDate
    FROM ${table} WHERE part = ? AND language = ? AND issue_date = ? AND volume = ? AND issue_number = ? ORDER BY id`)
    .all(value.part, value.language, value.issueDate, value.volume, value.issueNumber) as GazetteFeedMetadata[];
  return rows.map(toFeedRecord);
}

export function validateGazetteEdition(value: unknown): GazetteEdition {
  const parsed = edition.parse(value);
  const key = parsed;
  const ids = new Set<string>();
  for (const item of parsed.records) {
    if (gazetteIssueId(item) !== gazetteIssueId(key)) {
      throw new Error('Every Gazette record must match its containing issue edition.');
    }
    if (!gazetteRecordBelongsToIssue(item, key)) {
      throw new Error('Gazette record ID and citation must identify the matching official issue and language.');
    }
    if (ids.has(item.id)) throw new Error(`Duplicate Gazette record ID: ${item.id}`);
    ids.add(item.id);
    if (key.part === 'I' && item.kind === 'instrument') throw new Error('Part I records cannot be instruments.');
    if (key.part === 'II' && item.kind !== 'instrument') throw new Error('Part II records must be instruments.');
  }
  return parsed;
}

function importValidatedGazetteEdition(sqlite: DatabaseSync, value: GazetteEdition): GazetteImportResult {
  const digest = gazetteEditionDigest(value);
  initializeSourceFeed(sqlite);
    const before = storedFeedRecords(sqlite, value);
    const after = value.records.map(toFeedRecord);
    const scope = { source: 'gazette' as const, language: value.language, editionId: gazetteIssueId(value),
      publicationDate: value.issueDate, part: value.part };
    const existing = sqlite.prepare(`SELECT content_sha256 AS digest, parser_version AS parserVersion
      FROM gazette_editions WHERE part = ? AND language = ? AND issue_date = ? AND volume = ? AND issue_number = ?`)
      .get(value.part, value.language, value.issueDate, value.volume, value.issueNumber) as
      { digest: string; parserVersion: string } | undefined;
    if (existing?.digest === digest && existing.parserVersion === GAZETTE_PARSER_VERSION) {
      recordSourceChanges(sqlite, scope, before, before);
      return { part: value.part, language: value.language, issueDate: value.issueDate,
        volume: value.volume, issueNumber: value.issueNumber, status: 'unchanged', written: 0, removed: 0 };
    }

    const table = value.part === 'I' ? 'gazette_notices' : 'gazette_instruments';
    const remove = sqlite.prepare(`DELETE FROM ${table}
      WHERE part = ? AND language = ? AND issue_date = ? AND volume = ? AND issue_number = ?`);
    const removed = Number(remove.run(value.part, value.language, value.issueDate, value.volume, value.issueNumber).changes);
    sqlite.prepare(`INSERT INTO gazette_editions
      (part, language, issue_date, volume, issue_number, record_count, content_sha256, parser_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (part, language, issue_date, volume, issue_number) DO UPDATE SET
        record_count = excluded.record_count, content_sha256 = excluded.content_sha256,
        parser_version = excluded.parser_version, imported_at = CURRENT_TIMESTAMP`)
      .run(value.part, value.language, value.issueDate, value.volume, value.issueNumber,
        value.records.length, digest, GAZETTE_PARSER_VERSION);

    const insert = sqlite.prepare(`INSERT INTO ${table}
      (id, part, language, issue_date, volume, issue_number, kind, title, citation_url,
       registration_number, registration_date, consultation_deadline, effective_date, search_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const item of value.records) {
      const searchText = normalizeForSearch([item.title, item.registrationNumber].filter(Boolean).join(' '));
      insert.run(item.id, item.part, item.language, item.issueDate, item.volume, item.issueNumber,
        item.kind, item.title, item.citationUrl, item.registrationNumber ?? null,
        item.registrationDate ?? null, item.consultationDeadline ?? null, item.effectiveDate ?? null, searchText);
    }
    recordSourceChanges(sqlite, scope, before, after);
    return { part: value.part, language: value.language, issueDate: value.issueDate,
      volume: value.volume, issueNumber: value.issueNumber, status: 'imported', written: value.records.length, removed };
}

/** Replaces one complete issue edition atomically; repeated content performs no writes. */
export function importGazetteEdition(sqlite: DatabaseSync, input: unknown): GazetteImportResult {
  const value = validateGazetteEdition(input);
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const result = importValidatedGazetteEdition(sqlite, value);
    sqlite.exec('COMMIT');
    return result;
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}

/** Replaces the four current bilingual issues as one transaction, including feed cursors. */
export function importGazetteEditions(sqlite: DatabaseSync, inputs: readonly unknown[]): GazetteImportResult[] {
  const values = inputs.map(validateGazetteEdition);
  if (values.length !== 4 || new Set(values.map((value) => gazetteIssueId(value))).size !== 4) {
    throw new Error('A rolling Gazette refresh must include four distinct bilingual issue editions.');
  }
  return importGazetteEditionBatch(sqlite, values);
}

/** Atomically imports a bounded set of independently verified historical issue editions. */
export function importGazetteEditionBatch(sqlite: DatabaseSync, inputs: readonly unknown[]): GazetteImportResult[] {
  const values = inputs.map(validateGazetteEdition);
  if (!values.length || values.length > 400 || new Set(values.map((value) => gazetteIssueId(value))).size !== values.length) {
    throw new Error('A Gazette historical batch must contain 1 to 400 distinct issue editions.');
  }
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const results = values.map((value) => importValidatedGazetteEdition(sqlite, value));
    sqlite.exec('COMMIT');
    return results;
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}

export type { GazetteEdition, GazetteIssueKey, GazetteRecord };
