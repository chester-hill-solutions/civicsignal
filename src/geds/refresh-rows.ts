import { gedsRows, streamChunks, type ChunkSource } from './csv';
import { allValues, firstValue, run, type GedsDatabase, type GedsSqlValue } from './db';
import { Sha256 } from './hash';
import { normalizeRow } from './normalize';
import { currentGedsStage, GedsRefreshError, type GedsStage } from './refresh-state';
import type { GedsContact, GedsNormalizedRow, GedsOrgNode, GedsRawRow, GedsRefreshSummary, GedsSourceMetadata } from './types';

const roleInsert = `INSERT OR REPLACE INTO geds_roles
  (role_id, role_key, valid_from_seq, valid_to_seq, last_seen_seq, person_id, org_id,
   department_acronym, title_en, title_fr, surname, given_name, initials, prefixes_en, prefixes_fr,
   suffixes_en, suffixes_fr, full_name, search_name, search_title_en, search_title_fr, search_en,
   search_fr, email, telephone, fax, tdd, secure_telephone, secure_fax, alternate_telephone,
   is_general_office, contact_json, content_hash, source_row)
  SELECT ?, ?, ?, NULL, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?
  WHERE ${currentGedsStage}`;

const orgInsert = `INSERT OR REPLACE INTO geds_organizations
  (org_id, org_key, valid_from_seq, valid_to_seq, last_seen_seq, department_acronym,
   department_name_en, department_name_fr, name_en, name_fr, acronym, parent_org_id, level,
   node_path, name_key_en, name_key_fr, search_en, search_fr, content_hash)
  SELECT ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE ${currentGedsStage}`;

const personUpsert = `INSERT INTO geds_persons
  (person_id, person_key, first_seen_seq, last_seen_seq, created_at, updated_at)
  SELECT ?, ?, ?, ?, ?, ? WHERE ${currentGedsStage}
  ON CONFLICT(person_id) DO UPDATE SET
    last_seen_seq = MAX(geds_persons.last_seen_seq, excluded.last_seen_seq),
    updated_at = excluded.updated_at`;

const changeInsert = `INSERT OR IGNORE INTO geds_changes
  (id, seq, snapshot_id, entity_type, entity_id, change, summary, occurred_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${currentGedsStage}`;

interface BaseVersion {
  id: string;
  content_hash: string;
  valid_from_seq: number;
}

async function baseVersions(
  db: GedsDatabase,
  baseSeq: number | null,
  table: 'geds_roles' | 'geds_organizations',
  idColumn: 'role_id' | 'org_id',
): Promise<Map<string, BaseVersion>> {
  if (baseSeq === null) return new Map();
  const rows = await allValues<BaseVersion>(db,
    `SELECT ${idColumn} AS id, content_hash, valid_from_seq FROM ${table}
     WHERE valid_from_seq <= ? AND (valid_to_seq IS NULL OR valid_to_seq > ?)
     ORDER BY valid_from_seq`,
    baseSeq,
    baseSeq,
  );
  return new Map(rows.map((row) => [row.id, row]));
}

type LanguageCoverage = GedsRefreshSummary['languageCoverage']['en'];

function emptyLanguageCoverage(): LanguageCoverage {
  return { rows: 0, title: 0, department: 0, organization: 0 };
}

function emptyMeasurements() {
  return {
    seenRoles: new Set<string>(),
    seenOrgs: new Set<string>(),
    people: new Set<string>(),
    offices: new Set<string>(),
    missing: {
      telephone: 0,
      email: 0,
      titleEn: 0,
      titleFr: 0,
      anyContact: 0,
      surnameOrGivenName: 0,
      organizationStructure: 0,
      departmentAcronym: 0,
    },
    unresolved: [] as GedsRefreshSummary['unresolved'],
    unresolvedTotal: 0,
    languageCoverage: { en: emptyLanguageCoverage(), fr: emptyLanguageCoverage() },
    duplicateRoleKeys: 0,
  };
}

type Measurements = ReturnType<typeof emptyMeasurements>;
type RoleChange = 'added' | 'changed' | 'unchanged';
const directContactKinds = new Set<GedsContact['kind']>([
  'telephone', 'fax', 'tdd', 'secureTelephone', 'secureFax', 'alternateTelephone', 'email',
]);

function measureLanguage(coverage: LanguageCoverage, title: string | null, department: string, organization: string): void {
  // Each language uses all inspected source rows as the denominator.
  coverage.rows++;
  if (title) coverage.title++;
  if (department.trim()) coverage.department++;
  if (organization.trim()) coverage.organization++;
}

function measureRow(state: Measurements, row: GedsRawRow, normalized: GedsNormalizedRow): void {
  measureLanguage(state.languageCoverage.en, normalized.titleEn, row['Department Name (EN)'], row['Organization Name (EN)']);
  measureLanguage(state.languageCoverage.fr, normalized.titleFr, row['Department Name (FR)'], row['Organization Name (FR)']);
  if (!normalized.titleEn) state.missing.titleEn++;
  if (!normalized.titleFr) state.missing.titleFr++;
  if (!normalized.telephone) state.missing.telephone++;
  if (!normalized.email) state.missing.email++;
  if (!normalized.contacts.some(({ kind }) => directContactKinds.has(kind))) state.missing.anyContact++;
  if (!normalized.surname || !normalized.givenName) state.missing.surnameOrGivenName++;
  if (!row['Organization Structure (EN)'].trim()) state.missing.organizationStructure++;
  if (!row['Department Acronym'].trim()) state.missing.departmentAcronym++;
  state.unresolvedTotal += normalized.unresolved.length;
  for (const reason of normalized.unresolved.slice(0, Math.max(0, 500 - state.unresolved.length))) {
    state.unresolved.push({ sourceRow: normalized.sourceRow, reason });
  }

  if (normalized.isGeneralOffice) state.offices.add(normalized.personId);
  else state.people.add(normalized.personId);
  if (state.seenRoles.has(normalized.roleId)) state.duplicateRoleKeys++;
  state.seenRoles.add(normalized.roleId);
}

function unseenOrganizations(seen: Set<string>, nodes: GedsOrgNode[]): GedsOrgNode[] {
  return nodes.filter((node) => {
    if (seen.has(node.orgId)) return false;
    seen.add(node.orgId);
    return true;
  });
}

interface RowWriter {
  db: GedsDatabase;
  seq: number;
  snapshotId: string;
  effectiveAt: string;
}

async function noteChange(
  writer: RowWriter,
  entity: { type: 'organization' | 'role'; id: string; summary: string; change: 'added' | 'changed' },
): Promise<void> {
  const { db, seq, snapshotId, effectiveAt } = writer;
  const { type, id, change, summary } = entity;
  await run(db, changeInsert, `${seq}:${type}:${id}:${change}`, seq, snapshotId, type, id, change, summary, effectiveAt, seq);
}

async function writeOrganization(writer: RowWriter, node: GedsOrgNode, base: BaseVersion | undefined): Promise<void> {
  const { db, seq } = writer;
  if (base?.content_hash === node.contentHash) {
    await run(db,
      `UPDATE geds_organizations SET last_seen_seq = ?
       WHERE org_id = ? AND valid_from_seq = ? AND last_seen_seq < ? AND ${currentGedsStage}`,
      seq, node.orgId, base.valid_from_seq, seq, seq,
    );
    return;
  }
  await run(db, orgInsert,
    node.orgId, node.orgKey, seq, seq, node.departmentAcronym, node.departmentNameEn,
    node.departmentNameFr, node.nameEn, node.nameFr, node.acronym, node.parentOrgId,
    node.level, node.nodePath, node.nameKeyEn, node.nameKeyFr, node.searchEn, node.searchFr,
    node.contentHash, seq,
  );
  await noteChange(writer, { type: 'organization', id: node.orgId, summary: node.nameEn, change: base ? 'changed' : 'added' });
}

function roleChange(row: GedsNormalizedRow, base: BaseVersion | undefined): RoleChange {
  if (!base) return 'added';
  return base.content_hash === row.contentHash ? 'unchanged' : 'changed';
}

async function writeRole(writer: RowWriter, row: GedsNormalizedRow, base: BaseVersion | undefined): Promise<void> {
  const { db, seq, effectiveAt } = writer;
  await run(db, personUpsert, row.personId, row.personKey, seq, seq, effectiveAt, effectiveAt, seq);
  if (base?.content_hash === row.contentHash) {
    await run(db,
      `UPDATE geds_roles SET last_seen_seq = ?
       WHERE role_id = ? AND valid_from_seq = ? AND last_seen_seq < ? AND ${currentGedsStage}`,
      seq, row.roleId, base.valid_from_seq, seq, seq,
    );
    return;
  }
  await run(db, roleInsert, ...roleValues(row, seq), seq);
  await noteChange(writer, {
    type: 'role', id: row.roleId, summary: row.titleEn ?? row.fullName, change: base ? 'changed' : 'added',
  });
}

export type GedsCoverage = Pick<GedsRefreshSummary, 'languageCoverage' | 'missing' | 'unresolved' | 'duplicateRoleKeys'>;

interface GedsScan extends GedsCoverage {
  csvSha256: string;
  counts: Pick<GedsRefreshSummary['counts'], 'sourceRows' | 'people' | 'officeListings' | 'roles' | 'organizations'>;
  missing: Measurements['missing'];
  unresolvedTotal: number;
}

export interface GedsIngestion extends GedsScan {
  counts: GedsScan['counts'] & Pick<GedsRefreshSummary['counts'], 'added' | 'changedRoles' | 'unchanged'>;
}

function measuredRows(state: Measurements, csvSha256: string): GedsScan {
  const { people, offices, seenRoles, seenOrgs } = state;
  const { languageCoverage, missing, unresolved, unresolvedTotal, duplicateRoleKeys } = state;
  return {
    csvSha256,
    counts: {
      sourceRows: languageCoverage.en.rows,
      people: people.size,
      officeListings: offices.size,
      roles: seenRoles.size,
      organizations: seenOrgs.size,
    },
    languageCoverage,
    missing,
    unresolved,
    unresolvedTotal,
    duplicateRoleKeys,
  };
}

async function* hashCsv(source: ChunkSource, hash: Sha256): AsyncGenerator<Uint8Array> {
  for await (const chunk of streamChunks(source)) {
    hash.update(chunk);
    yield chunk;
  }
}

export async function scanGedsRows(
  source: ChunkSource,
  snapshotId: string,
  metadata: GedsSourceMetadata,
  writeRow?: (normalized: GedsNormalizedRow, nodes: GedsOrgNode[]) => Promise<void>,
): Promise<GedsScan> {
  const state = emptyMeasurements();
  const csvHash = new Sha256();
  for await (const { row, sourceRow } of gedsRows(hashCsv(source, csvHash))) {
    const normalized = normalizeRow(row, sourceRow, snapshotId, metadata);
    measureRow(state, row, normalized);
    const nodes = unseenOrganizations(state.seenOrgs, normalized.nodes);
    if (writeRow) await writeRow(normalized, nodes);
  }
  return measuredRows(state, csvHash.digestHex());
}

export async function ingestGedsRows(
  db: GedsDatabase,
  stage: GedsStage,
  source: ChunkSource,
  metadata: GedsSourceMetadata,
  onProgress?: (rowsRead: number) => void,
): Promise<GedsIngestion> {
  const { snapshot, lastRowNo } = stage;
  const { seq, snapshot_id: snapshotId, effective_at: effectiveAt, previous_seq: baseSeq } = snapshot;
  const [baseRoles, baseOrgs] = await Promise.all([
    baseVersions(db, baseSeq, 'geds_roles', 'role_id'),
    baseVersions(db, baseSeq, 'geds_organizations', 'org_id'),
  ]);
  const writer = { db, seq, snapshotId, effectiveAt };
  const changes = { added: 0, changedRoles: 0, unchanged: 0 };
  const scanned = await scanGedsRows(source, snapshotId, metadata, async (normalized, nodes) => {
    const { sourceRow } = normalized;
    const base = baseRoles.get(normalized.roleId);
    const change = roleChange(normalized, base);
    if (change === 'changed') changes.changedRoles++;
    else changes[change]++;
    if (sourceRow <= lastRowNo) return;

    for (const node of nodes) await writeOrganization(writer, node, baseOrgs.get(node.orgId));
    await writeRole(writer, normalized, base);
    if (sourceRow % 500 === 0) {
      const checkpoint = await firstValue<{ seq: number }>(db,
        `UPDATE geds_snapshots SET last_row_no = ?, updated_at = ?
         WHERE seq = ? AND ${currentGedsStage} RETURNING seq`,
        sourceRow, new Date().toISOString(), seq, seq,
      );
      if (!checkpoint) throw new GedsRefreshError('the publication base changed during the GEDS build');
      onProgress?.(sourceRow);
    }
  });
  return { ...scanned, counts: { ...scanned.counts, ...changes } };
}

function roleValues(row: GedsNormalizedRow, seq: number): GedsSqlValue[] {
  const lastNode = row.nodes.at(-1);
  if (!lastNode) throw new GedsRefreshError('a normalized GEDS role has no organization nodes');
  return [
    row.roleId,
    row.roleKey,
    seq,
    seq,
    row.personId,
    row.orgId,
    lastNode.departmentAcronym,
    row.titleEn,
    row.titleFr,
    row.surname,
    row.givenName,
    row.initials,
    row.prefixesEn,
    row.prefixesFr,
    row.suffixesEn,
    row.suffixesFr,
    row.fullName,
    row.searchName,
    row.searchTitleEn,
    row.searchTitleFr,
    row.searchEn,
    row.searchFr,
    row.email,
    row.telephone,
    row.fax,
    row.tdd,
    row.secureTelephone,
    row.secureFax,
    row.alternateTelephone,
    row.isGeneralOffice ? 1 : 0,
    row.contactJson,
    row.contentHash,
    row.sourceRow,
  ];
}
