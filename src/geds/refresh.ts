import { archiveKeyForOriginal, archiveMetadataKey, snapshotManifestKey, type GedsArchive } from './archive';
import type { ChunkSource } from './csv';
import { allValues, type GedsDatabase } from './db';
import { sha256Hex } from './hash';
import { stableId } from './normalize';
import { ingestGedsRows, scanGedsRows, type GedsCoverage, type GedsIngestion } from './refresh-rows';
import {
  discardGedsStage,
  GedsRefreshError,
  latestGedsSnapshot,
  prepareGedsStage,
  publishGedsStage,
  recordGedsReplay,
  type GedsObservation,
  type GedsStage,
} from './refresh-state';
import type { GedsRefreshSummary, GedsSnapshotRow } from './types';
import { openFirstZipEntry } from './zip';

export { GedsRefreshError } from './refresh-state';

export const GEDS_DATASET_ID = '8ec4a9df-b76b-4a67-8f93-cdbc2e040098';
export const GEDS_SOURCE_URL = 'https://api.geds-sage.gc.ca/GEDS20/dist/opendata/gedsOpenData.zip';
export const GEDS_DATASET_URL = `https://open.canada.ca/data/dataset/${GEDS_DATASET_ID}`;

export interface GedsRefreshInput {
  db: GedsDatabase;
  archive?: GedsArchive;
  now?: Date;
  datasetId?: string;
  resourceId?: string;
  sourceUrl?: string;
  /** Original ZIP, when the caller has it. */
  zipBytes?: Uint8Array;
  /** Original CSV, when the caller is replaying a file rather than an archive. */
  csvBytes?: Uint8Array;
  /** A stream of the decompressed CSV, when the caller does not hold it. */
  csvStream?: ChunkSource;
  sourceDate?: string;
  etag?: string;
  contentLength?: number;
  originalName?: string;
  originalFormat?: 'zip' | 'csv';
  /** Expected original SHA-256, required when only a CSV stream is supplied. */
  zipSha256?: string;
  observationId?: string;
  resume?: boolean;
  onProgress?: (rowsRead: number) => void;
}

export interface GedsFetchResult {
  zipBytes: Uint8Array;
  sourceDate?: string;
  etag?: string;
  contentLength?: number;
  notModified: boolean;
}

export async function fetchGedsSource(
  url = GEDS_SOURCE_URL,
  options: { fetchImpl?: typeof fetch; etag?: string } = {},
): Promise<GedsFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/zip, text/csv;q=0.9, */*;q=0.1' };
  if (options.etag) headers['If-None-Match'] = options.etag;
  const response = await fetchImpl(url, { headers });
  if (response.status === 304) {
    return { zipBytes: new Uint8Array(), notModified: true, etag: options.etag };
  }
  if (!response.ok) {
    throw new GedsRefreshError(`the official source refused ${response.status} at ${url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const lastModified = response.headers.get('last-modified');
  return {
    zipBytes: bytes,
    sourceDate: lastModified ? new Date(lastModified).toISOString() : undefined,
    etag: response.headers.get('etag') ?? undefined,
    contentLength: Number(response.headers.get('content-length')) || bytes.length,
    notModified: false,
  };
}

interface OriginalSource {
  input: GedsRefreshInput;
  bytes?: Uint8Array;
  observation: GedsObservation & { originalName: string };
}

async function observeOriginal(input: GedsRefreshInput): Promise<OriginalSource> {
  const { datasetId = GEDS_DATASET_ID, sourceUrl = GEDS_SOURCE_URL, now = new Date() } = input;
  const observedAt = now.toISOString();
  if (!input.zipBytes && !input.csvBytes && !input.csvStream) {
    const fetched = await fetchGedsSource(sourceUrl);
    if (fetched.notModified) {
      throw new GedsRefreshError('the source answered 304; keep serving the current snapshot');
    }
    input = {
      ...input,
      zipBytes: fetched.zipBytes,
      sourceDate: input.sourceDate ?? fetched.sourceDate,
      etag: input.etag ?? fetched.etag,
      contentLength: input.contentLength ?? fetched.contentLength,
    };
  }

  const bytes = input.zipBytes ?? input.csvBytes;
  const originalFormat = input.originalFormat ?? (input.zipBytes ? 'zip' : 'csv');
  const originalName = input.originalName ?? `gedsOpenData.${originalFormat}`;
  const zipSha256 = input.zipSha256 ?? (bytes && sha256Hex(bytes));
  if (!zipSha256) throw new GedsRefreshError('a ZIP, CSV or csvStream is required');
  const observationId = input.observationId ?? stableId('obs', `${observedAt}|${zipSha256}`);
  const observation = {
    datasetId,
    resourceId: input.resourceId,
    sourceUrl,
    observedAt,
    sourceDate: input.sourceDate,
    etag: input.etag,
    contentLength: input.contentLength,
    originalFormat,
    originalName,
    observationId,
    zipSha256,
    archived: false,
  };
  return { input, bytes, observation };
}

async function archiveOriginal(source: OriginalSource): Promise<void> {
  const { input: { archive }, bytes, observation } = source;
  if (!archive || !bytes) return;
  const { zipSha256, originalName } = observation;
  const key = archiveKeyForOriginal(zipSha256, originalName);
  const exists = archive.has ? await archive.has(key) : (await archive.get(key)) !== null;
  if (!exists) await archive.put(key, bytes);
  const { observationId: _observationId, archived: _archived, ...sourceMetadata } = observation;
  await archive.putJson(archiveMetadataKey(zipSha256), { ...sourceMetadata, archivedAt: observation.observedAt });
  observation.archiveKey = key;
  observation.archiveUrl = observation.sourceUrl;
  observation.archived = true;
}

async function* csvBytesChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

function openCsv({ input, observation }: OriginalSource): ChunkSource {
  if (input.csvStream) return input.csvStream;
  if (observation.originalFormat === 'zip' && input.zipBytes) return openFirstZipEntry(input.zipBytes);
  if (input.csvBytes) return csvBytesChunk(input.csvBytes);
  throw new GedsRefreshError('no CSV stream could be opened from the original');
}

function snapshotSummary(snapshot: GedsSnapshotRow): NonNullable<GedsRefreshSummary['snapshot']> {
  return {
    id: snapshot.snapshot_id,
    seq: snapshot.seq,
    effectiveAt: snapshot.effective_at,
    publishedAt: snapshot.published_at ?? snapshot.effective_at,
    sourceDate: snapshot.source_date ?? undefined,
    archiveKey: snapshot.archive_key ?? undefined,
    manifestKey: snapshot.manifest_key ?? undefined,
  };
}

interface SnapshotCoverage extends GedsCoverage {
  counts: { officeListings: number };
}

interface ArchivedCoverage extends Omit<SnapshotCoverage, 'unresolved'> {
  coverageVersion?: number;
  unresolved: { sample: GedsCoverage['unresolved'] };
}

async function replayCoverage(source: OriginalSource, snapshot: GedsSnapshotRow): Promise<SnapshotCoverage> {
  const { input: { archive }, observation } = source;
  if (archive && snapshot.manifest_key) {
    const manifest = await archive.getJson<ArchivedCoverage>(snapshot.manifest_key);
    if (manifest?.coverageVersion === 1) {
      return { ...manifest, unresolved: manifest.unresolved.sample };
    }
  }
  const coverage = await scanGedsRows(openCsv(source), snapshot.snapshot_id, {
    ...observation,
    observedAt: snapshot.effective_at,
  });
  if (coverage.csvSha256 !== snapshot.csv_sha256) {
    throw new GedsRefreshError('the replay CSV does not match the published original');
  }
  return coverage;
}

function replaySummary(
  snapshot: GedsSnapshotRow,
  observation: GedsObservation,
  coverage: SnapshotCoverage,
  durationMs: number,
  resume = { resumed: false, lastRowNo: snapshot.last_row_no },
): GedsRefreshSummary {
  return {
    ok: true,
    changed: false,
    observation: { ...observation, csvSha256: snapshot.csv_sha256 },
    snapshot: snapshotSummary(snapshot),
    counts: {
      sourceRows: snapshot.row_count,
      storedRows: snapshot.role_count,
      people: snapshot.person_count,
      officeListings: coverage.counts.officeListings,
      organizations: snapshot.organization_count,
      roles: snapshot.role_count,
      changes: 0,
      added: 0,
      changedRoles: 0,
      removed: 0,
      unchanged: snapshot.row_count,
    },
    languageCoverage: coverage.languageCoverage,
    missing: coverage.missing,
    unresolved: coverage.unresolved,
    duplicateRoleKeys: coverage.duplicateRoleKeys,
    resume,
    durationMs,
  };
}

async function archiveManifest(
  source: OriginalSource,
  snapshot: GedsSnapshotRow,
  ingestion: GedsIngestion,
): Promise<string | undefined> {
  const { input: { archive }, bytes, observation } = source;
  if (!archive) return undefined;
  const { counts, csvSha256, languageCoverage, missing, unresolved, unresolvedTotal, duplicateRoleKeys } = ingestion;
  const key = snapshotManifestKey(snapshot.snapshot_id);
  await archive.putJson(key, {
    datasetId: snapshot.dataset_id,
    datasetUrl: GEDS_DATASET_URL,
    sourceUrl: snapshot.source_url,
    resourceId: snapshot.resource_id ?? undefined,
    coverageVersion: 1,
    observationId: observation.observationId,
    snapshotId: snapshot.snapshot_id,
    seq: snapshot.seq,
    effectiveAt: snapshot.effective_at,
    sourceDate: snapshot.source_date,
    original: {
      name: observation.originalName,
      format: observation.originalFormat,
      sha256: observation.zipSha256,
      csvSha256,
      archiveKey: snapshot.archive_key ?? observation.archiveKey ?? null,
      contentLength: observation.contentLength ?? bytes?.length ?? null,
    },
    counts: {
      sourceRows: counts.sourceRows,
      storedRows: counts.roles,
      people: counts.people,
      officeListings: counts.officeListings,
      organizations: counts.organizations,
      roles: counts.roles,
      changes: { added: counts.added, changed: counts.changedRoles, removed: 0 },
    },
    languageCoverage,
    missing,
    unresolved: { total: unresolvedTotal, sample: unresolved },
    duplicateRoleKeys,
    generatedAt: new Date().toISOString(),
  });
  return key;
}

async function publishedSummary(
  source: OriginalSource,
  stage: GedsStage,
  ingestion: GedsIngestion,
  started: number,
): Promise<GedsRefreshSummary> {
  const { input: { db }, observation } = source;
  const manifestKey = await archiveManifest(source, stage.snapshot, ingestion);
  const published = await publishGedsStage(db, { stage, observation, ingestion, manifestKey });
  const changes = await allValues<{ change: string; n: number }>(
    db, 'SELECT change, COUNT(*) AS n FROM geds_changes WHERE seq = ? GROUP BY change', published.seq,
  );
  const byChange = new Map(changes.map((row) => [row.change, Number(row.n)]));
  const { counts, csvSha256, languageCoverage, missing, unresolved, duplicateRoleKeys } = ingestion;
  return {
    ok: true,
    changed: true,
    observation: { ...observation, csvSha256 },
    snapshot: snapshotSummary(published),
    counts: {
      ...counts,
      storedRows: counts.roles,
      changes: [...byChange.values()].reduce((sum, n) => sum + n, 0),
      added: byChange.get('added') ?? counts.added,
      changedRoles: byChange.get('changed') ?? counts.changedRoles,
      removed: byChange.get('removed') ?? 0,
    },
    languageCoverage,
    missing,
    unresolved,
    duplicateRoleKeys,
    resume: { resumed: stage.resumed, lastRowNo: stage.lastRowNo },
    durationMs: Date.now() - started,
  };
}

async function refreshDirectory(input: GedsRefreshInput): Promise<GedsRefreshSummary> {
  const started = Date.now();
  const { db } = input;
  const source = await observeOriginal(input);
  await archiveOriginal(source);
  const { observation } = source;
  const latest = await latestGedsSnapshot(db);
  if (latest && latest.zip_sha256 === observation.zipSha256 && latest.csv_sha256) {
    const coverage = await replayCoverage(source, latest);
    await recordGedsReplay(db, observation, latest, 'identical original; no snapshot');
    return replaySummary(latest, observation, coverage, Date.now() - started);
  }

  const csv = openCsv(source);
  const stage = await prepareGedsStage(db, observation, latest, input.resume !== false);
  const { snapshot, resumed, lastRowNo } = stage;
  const ingestion = await ingestGedsRows(db, stage, csv, {
    ...observation,
    datasetId: snapshot.dataset_id,
    sourceUrl: snapshot.source_url,
    observedAt: snapshot.effective_at,
    sourceDate: snapshot.source_date ?? undefined,
  }, input.onProgress);
  if (ingestion.counts.sourceRows === 0) {
    await discardGedsStage(db, snapshot.seq);
    throw new GedsRefreshError('the official source produced an empty CSV; the published snapshot was kept');
  }
  // A new ZIP container can carry the same CSV as the current publication.
  if (latest && latest.csv_sha256 === ingestion.csvSha256) {
    await discardGedsStage(db, snapshot.seq);
    await recordGedsReplay(db, observation, latest, 'CSV identical to the published snapshot; staging discarded');
    return replaySummary(latest, observation, ingestion, Date.now() - started, { resumed, lastRowNo });
  }

  return publishedSummary(source, stage, ingestion, started);
}

const activeRefreshes = new WeakSet<GedsDatabase>();

/**
 * Build versions behind the latest published sequence. An interrupted import
 * leaves a checkpoint for the same original while readers keep their snapshot.
 * Cross-process local callers share the CLI's database writer lock.
 */
export async function refreshGeds(input: GedsRefreshInput): Promise<GedsRefreshSummary> {
  const { db } = input;
  if (activeRefreshes.has(db)) throw new GedsRefreshError('a GEDS refresh is already running');
  if (!db.batch && !db.exec) throw new GedsRefreshError('the GEDS refresh requires atomic database writes');
  activeRefreshes.add(db);
  try {
    return await refreshDirectory(input);
  } finally {
    activeRefreshes.delete(db);
  }
}

/** A test/local helper: read the published snapshot's manifest. */
export async function readSnapshotManifest(
  archive: GedsArchive,
  snapshot: GedsSnapshotRow,
): Promise<unknown | null> {
  if (!snapshot.manifest_key) return null;
  return archive.getJson(snapshot.manifest_key);
}
