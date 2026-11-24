import { allValues, firstValue, type GedsDatabase, type GedsSqlValue, type GedsStatement } from './db';
import { stableId } from './normalize';
import type { GedsIngestion } from './refresh-rows';
import type { GedsRefreshSummary, GedsSnapshotRow } from './types';

export class GedsRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GedsRefreshError';
  }
}

export type GedsObservation = Omit<GedsRefreshSummary['observation'], 'csvSha256'>;

export interface GedsStage {
  snapshot: GedsSnapshotRow;
  resumed: boolean;
  lastRowNo: number;
}

const latestPublishedSeq = "SELECT MAX(seq) FROM geds_snapshots WHERE status = 'published'";

// The CLI owns the writer lock. Every staging write also checks that its
// sequence still owns the build and was started from the current publication.
export const currentGedsStage = `EXISTS (
  SELECT 1 FROM geds_snapshots s
  WHERE s.seq = ? AND s.status = 'building'
    AND s.previous_seq IS (${latestPublishedSeq})
    AND s.seq = (SELECT MIN(seq) FROM geds_snapshots WHERE status = 'building')
)`;

export function latestGedsSnapshot(db: GedsDatabase): Promise<GedsSnapshotRow | null> {
  return firstValue(db, "SELECT * FROM geds_snapshots WHERE seq = (" + latestPublishedSeq + ")");
}

export async function prepareGedsStage(
  db: GedsDatabase,
  observation: GedsObservation,
  latest: GedsSnapshotRow | null,
  resume: boolean,
): Promise<GedsStage> {
  const pending = await allValues<GedsSnapshotRow>(
    db,
    "SELECT * FROM geds_snapshots WHERE status IN ('building', 'failed') ORDER BY seq DESC",
  );
  const previousSeq = latest?.seq ?? null;
  const candidate = pending[0];
  const resumable = resume
    && candidate?.status === 'building'
    && candidate.zip_sha256 === observation.zipSha256
    && candidate.previous_seq === previousSeq
    && candidate.seq > (previousSeq ?? 0)
    ? candidate
    : undefined;

  for (const snapshot of pending) {
    if (snapshot !== resumable) await discardGedsStage(db, snapshot.seq);
  }
  if (resumable) {
    return { snapshot: resumable, resumed: true, lastRowNo: resumable.last_row_no };
  }
  const snapshot = await createGedsStage(db, observation, previousSeq);
  return { snapshot, resumed: false, lastRowNo: 0 };
}

async function createGedsStage(
  db: GedsDatabase,
  observation: GedsObservation,
  previousSeq: number | null,
): Promise<GedsSnapshotRow> {
  const previousAttempt = await firstValue<{ seq: number }>(
    db,
    'SELECT seq FROM geds_snapshots WHERE effective_at = ? AND zip_sha256 = ? ORDER BY seq DESC LIMIT 1',
    observation.observedAt,
    observation.zipSha256,
  );
  const seed = `${observation.observedAt}|${observation.zipSha256}`;
  const snapshotId = stableId('snap', previousAttempt ? `${seed}|${previousAttempt.seq}` : seed);
  const creation = await db.prepare(
    `INSERT INTO geds_snapshots
      (snapshot_id, observation_id, status, effective_at, source_date, source_url, dataset_id,
       resource_id, zip_sha256, csv_sha256, archive_key, previous_seq, created_at, updated_at)
     SELECT ?, ?, 'building', ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?
     WHERE ? IS (${latestPublishedSeq})
       AND NOT EXISTS (SELECT 1 FROM geds_snapshots WHERE status = 'building')
     RETURNING *`,
  ).bind(
    snapshotId,
    observation.observationId,
    observation.observedAt,
    observation.sourceDate ?? null,
    observation.sourceUrl,
    observation.datasetId,
    observation.resourceId ?? null,
    observation.zipSha256,
    observation.archiveKey ?? null,
    previousSeq,
    observation.observedAt,
    observation.observedAt,
    previousSeq,
  ).first<GedsSnapshotRow>();
  if (!creation) throw new GedsRefreshError('the publication base changed before the GEDS build started');
  return creation;
}

async function atomicWrite(db: GedsDatabase, statements: GedsStatement[]): Promise<void> {
  if (db.batch) {
    await db.batch(statements);
    return;
  }
  if (!db.exec) throw new GedsRefreshError('the GEDS refresh requires atomic database writes');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const statement of statements) await statement.run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function discardGedsStage(db: GedsDatabase, seq: number): Promise<void> {
  const discardable = `EXISTS (
    SELECT 1 FROM geds_snapshots WHERE seq = ? AND status IN ('building', 'failed')
  )`;
  // A different publication must never make this sequence's staged intervals
  // visible. Restore version markers as well as removing the staged rows.
  const versions = ['geds_roles', 'geds_organizations'].flatMap((table) => [
    db.prepare(`DELETE FROM ${table} WHERE valid_from_seq = ? AND ${discardable}`).bind(seq, seq),
    db.prepare(
      `UPDATE ${table} SET valid_to_seq = CASE WHEN valid_to_seq = ? THEN NULL ELSE valid_to_seq END,
        last_seen_seq = CASE WHEN last_seen_seq = ? THEN COALESCE(
          (SELECT MAX(seq) FROM geds_snapshots WHERE status = 'published' AND seq < ?), valid_from_seq
        ) ELSE last_seen_seq END
       WHERE (valid_to_seq = ? OR last_seen_seq = ?) AND ${discardable}`,
    ).bind(seq, seq, seq, seq, seq, seq),
  ]);
  await atomicWrite(db, [
    ...versions,
    db.prepare(`DELETE FROM geds_changes WHERE seq = ? AND ${discardable}`).bind(seq, seq),
    db.prepare(
      `DELETE FROM geds_persons
       WHERE first_seen_seq = ? AND ${discardable}
         AND NOT EXISTS (SELECT 1 FROM geds_roles r WHERE r.person_id = geds_persons.person_id)`,
    ).bind(seq, seq),
    db.prepare(
      `UPDATE geds_persons SET
         first_seen_seq = CASE WHEN first_seen_seq = ? THEN (
           SELECT MIN(valid_from_seq) FROM geds_roles r WHERE r.person_id = geds_persons.person_id
         ) ELSE first_seen_seq END,
         last_seen_seq = CASE WHEN last_seen_seq = ? THEN COALESCE((
           SELECT MAX(last_seen_seq) FROM geds_roles r WHERE r.person_id = geds_persons.person_id
         ), first_seen_seq) ELSE last_seen_seq END
       WHERE (first_seen_seq = ? OR last_seen_seq = ?) AND ${discardable}`,
    ).bind(seq, seq, seq, seq, seq),
    db.prepare(
      `UPDATE geds_snapshots SET status = 'discarded', updated_at = ?
       WHERE seq = ? AND status IN ('building', 'failed')`,
    ).bind(new Date().toISOString(), seq),
  ]);
}

interface ObservationResult {
  csvSha256: string;
  changed: boolean;
  snapshotId: string;
  note: string;
  seq?: number;
}

function observationStatement(
  db: GedsDatabase,
  observation: GedsObservation,
  result: ObservationResult,
): GedsStatement {
  const values: GedsSqlValue[] = [
    observation.observationId,
    observation.datasetId,
    observation.resourceId ?? null,
    observation.sourceUrl,
    observation.observedAt,
    observation.sourceDate ?? null,
    observation.etag ?? null,
    observation.contentLength ?? null,
    observation.originalFormat,
    observation.originalName ?? null,
    observation.zipSha256,
    result.csvSha256,
    observation.archiveKey ?? null,
    observation.sourceUrl,
    result.changed ? 1 : 0,
    result.snapshotId,
    result.note,
    observation.observedAt,
  ];
  const guard = result.seq === undefined ? '' : `WHERE ${currentGedsStage}`;
  if (result.seq !== undefined) values.push(result.seq);
  return db.prepare(
    `INSERT OR REPLACE INTO geds_observations
      (observation_id, dataset_id, resource_id, source_url, fetched_at, source_date, etag,
       content_length, original_format, original_name, zip_sha256, csv_sha256, archive_key,
       archive_url, changed, snapshot_id, note, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ${guard}`,
  ).bind(...values);
}

export async function recordGedsReplay(
  db: GedsDatabase,
  observation: GedsObservation,
  snapshot: GedsSnapshotRow,
  note: string,
): Promise<void> {
  await observationStatement(db, observation, {
    csvSha256: snapshot.csv_sha256,
    changed: false,
    snapshotId: snapshot.snapshot_id,
    note,
  }).run();
}

function versionPublication(
  db: GedsDatabase,
  snapshot: GedsSnapshotRow,
  observedAt: string,
  entity: { table: string; id: string; type: string; summary: string },
): GedsStatement[] {
  const { seq, snapshot_id: snapshotId } = snapshot;
  const { table, id, type, summary } = entity;
  return [
    db.prepare(
      `INSERT OR IGNORE INTO geds_changes
        (id, seq, snapshot_id, entity_type, entity_id, change, summary, occurred_at)
       SELECT ? || ':' || ? || ':' || r.${id} || ':removed', ?, ?, ?, r.${id}, 'removed', ${summary}, ?
       FROM ${table} r
       WHERE r.valid_to_seq IS NULL AND r.valid_from_seq < ? AND r.last_seen_seq < ?
         AND NOT EXISTS (
           SELECT 1 FROM ${table} n WHERE n.${id} = r.${id}
             AND n.valid_to_seq IS NULL AND n.last_seen_seq >= ?
         )
         AND ${currentGedsStage}`,
    ).bind(String(seq), type, seq, snapshotId, type, observedAt, seq, seq, seq, seq),
    db.prepare(
      `UPDATE ${table} SET valid_to_seq = ?
       WHERE valid_to_seq IS NULL AND valid_from_seq < ?
         AND (last_seen_seq < ? OR EXISTS (
           SELECT 1 FROM ${table} n WHERE n.${id} = ${table}.${id} AND n.valid_from_seq = ?
         ))
         AND ${currentGedsStage}`,
    ).bind(seq, seq, seq, seq, seq),
  ];
}

interface Publication {
  stage: GedsStage;
  observation: GedsObservation;
  ingestion: GedsIngestion;
  manifestKey?: string;
}

export async function publishGedsStage(db: GedsDatabase, publication: Publication): Promise<GedsSnapshotRow> {
  const { stage, observation, ingestion, manifestKey } = publication;
  const { snapshot, resumed } = stage;
  const { seq, snapshot_id: snapshotId } = snapshot;
  const { observedAt } = observation;
  const { csvSha256, counts, languageCoverage, missing, unresolvedTotal } = ingestion;
  await atomicWrite(db, [
    ...versionPublication(db, snapshot, observedAt, {
      table: 'geds_roles', id: 'role_id', type: 'role', summary: 'COALESCE(r.title_en, r.full_name)',
    }),
    ...versionPublication(db, snapshot, observedAt, {
      table: 'geds_organizations', id: 'org_id', type: 'organization', summary: 'r.name_en',
    }),
    observationStatement(db, observation, {
      seq, snapshotId, csvSha256, changed: true, note: resumed ? 'resumed snapshot' : 'new snapshot',
    }),
    db.prepare(
      `UPDATE geds_snapshots SET status = 'published', observation_id = ?, published_at = ?, csv_sha256 = ?,
        row_count = ?, person_count = ?, organization_count = ?, role_count = ?,
        language_en_count = ?, language_fr_count = ?, missing_contact_count = ?,
        unresolved_count = ?, manifest_key = ?, last_row_no = ?, updated_at = ?,
        archive_key = COALESCE(archive_key, ?)
       WHERE seq = ? AND ${currentGedsStage}`,
    ).bind(
      observation.observationId, observedAt, csvSha256, counts.sourceRows, counts.people,
      counts.organizations, counts.roles, languageCoverage.en.title, languageCoverage.fr.title, missing.anyContact,
      unresolvedTotal, manifestKey ?? null, counts.sourceRows, observedAt, observation.archiveKey ?? null, seq, seq,
    ),
  ]);

  const published = await firstValue<GedsSnapshotRow>(
    db,
    "SELECT * FROM geds_snapshots WHERE seq = ? AND status = 'published' AND observation_id = ? AND csv_sha256 = ?",
    seq,
    observation.observationId,
    csvSha256,
  );
  if (!published) throw new GedsRefreshError('the publication base changed during the GEDS build');
  return published;
}
