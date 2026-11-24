/**
 * GEDS: the Government Electronic Directory Services directory.
 *
 * The types in this file are deliberately close to the publisher's CSV. The
 * export has no employee number, no unit number and no row id, so every
 * identifier below is *derived* and the derivation is part of the contract
 * (see `docs/GEDS.md`). The values are kept as published — including the
 * columns that are empty — because "the publisher did not give a telephone
 * number" is a fact a caller is entitled to see.
 */

export type GedsLanguage = 'en' | 'fr';

export interface GedsSourceMetadata {
  datasetId: string;
  resourceId?: string;
  sourceUrl: string;
  /** When this copy was observed (ISO 8601). */
  observedAt: string;
  /** The HTTP `Last-Modified` of the original, when it sent one. */
  sourceDate?: string;
  etag?: string;
  contentLength?: number;
  archiveKey?: string;
  archiveUrl?: string;
  originalFormat: 'zip' | 'csv';
  originalName?: string;
}

/** A contact value exactly as the publisher labelled the column. */
export interface GedsContact {
  /** The publisher's field, in the export's own English column name. */
  field: string;
  /** The publisher-facing label in each language. */
  label: { en: string; fr: string };
  value: string;
  /**
   * True when this is not a named individual's direct contact, but the
   * general office the publisher attaches to the unit.
   */
  isGeneralOffice: boolean;
  /** The kind of contact, for a client that has to choose one. */
  kind:
    | 'telephone'
    | 'fax'
    | 'tdd'
    | 'secureTelephone'
    | 'secureFax'
    | 'alternateTelephone'
    | 'administrativeAssistant'
    | 'executiveAssistant'
    | 'email'
    | 'postal';
  /** For a postal contact, the individual published fields. */
  parts?: Record<string, string>;
  citation: GedsCitation;
}

export interface GedsCitation {
  datasetId: string;
  datasetUrl: string;
  resourceUrl: string;
  sourceDate?: string;
  observedAt: string;
  snapshotId: string;
  entity: { type: 'person' | 'organization' | 'role'; id: string };
  /** The publisher's field this value came from. */
  field?: string;
  /** The text a client can show without reassembling the citation. */
  text: string;
}

/** One row of the official CSV, after the header has been mapped. */
export interface GedsRawRow {
  Surname: string;
  GivenName: string;
  Initials: string;
  'Prefix (EN)': string;
  'Prefix (FR)': string;
  'Suffix (EN)': string;
  'Suffix (FR)': string;
  'Title (EN)': string;
  'Title (FR)': string;
  'Telephone Number': string;
  'Fax Number': string;
  'TDD Number': string;
  'Secure Telephone Number': string;
  'Secure Fax Number': string;
  'Alternate Telephone Number': string;
  Email: string;
  'Street Address (EN)': string;
  'Street Address (FR)': string;
  'Country (EN)': string;
  'Country (FR)': string;
  'Province (EN)': string;
  'Province (FR)': string;
  'City (EN)': string;
  'City (FR)': string;
  'Postal Code': string;
  'PO Box (EN)': string;
  'PO Box (FR)': string;
  Mailstop: string;
  'Building (EN)': string;
  'Building (FR)': string;
  Floor: string;
  Room: string;
  'Administrative Assistant': string;
  'Administrative Assistant Telephone Number': string;
  'Executive Assistant': string;
  'Executive Assistant Telephone Number': string;
  'Department Acronym': string;
  'Department Name (EN)': string;
  'Department Name (FR)': string;
  'Organization Acronym': string;
  'Organization Name (EN)': string;
  'Organization Name (FR)': string;
  'Organization Structure (EN)': string;
  'Organization Structure (FR)': string;
}

export interface GedsOrgNode {
  orgId: string;
  orgKey: string;
  departmentAcronym: string;
  departmentNameEn: string;
  departmentNameFr: string;
  nameEn: string;
  nameFr: string;
  acronym: string | null;
  parentOrgId: string | null;
  level: number;
  nodePath: string;
  nameKeyEn: string;
  nameKeyFr: string;
  searchEn: string;
  searchFr: string;
  contentHash: string;
}

export interface GedsNormalizedRow {
  sourceRow: number;
  personId: string;
  personKey: string;
  roleId: string;
  roleKey: string;
  orgId: string;
  orgKey: string;
  surname: string;
  givenName: string;
  fullName: string;
  initials: string | null;
  prefixesEn: string | null;
  prefixesFr: string | null;
  suffixesEn: string | null;
  suffixesFr: string | null;
  titleEn: string | null;
  titleFr: string | null;
  email: string | null;
  telephone: string | null;
  fax: string | null;
  tdd: string | null;
  secureTelephone: string | null;
  secureFax: string | null;
  alternateTelephone: string | null;
  isGeneralOffice: boolean;
  contacts: GedsContact[];
  contactJson: string;
  searchName: string;
  searchTitleEn: string;
  searchTitleFr: string;
  searchEn: string;
  searchFr: string;
  contentHash: string;
  nodes: GedsOrgNode[];
  unresolved: string[];
}

export interface GedsSnapshotRow {
  seq: number;
  snapshot_id: string;
  observation_id: string;
  status: 'building' | 'published' | 'failed' | 'discarded';
  effective_at: string;
  published_at: string | null;
  source_date: string | null;
  source_url: string;
  dataset_id: string;
  resource_id: string | null;
  zip_sha256: string;
  csv_sha256: string;
  archive_key: string | null;
  previous_seq: number | null;
  row_count: number;
  person_count: number;
  organization_count: number;
  role_count: number;
  language_en_count: number;
  language_fr_count: number;
  missing_contact_count: number;
  unresolved_count: number;
  manifest_key: string | null;
  last_row_no: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface GedsObservationRow {
  observation_id: string;
  dataset_id: string;
  resource_id: string | null;
  source_url: string;
  fetched_at: string;
  source_date: string | null;
  etag: string | null;
  content_length: number | null;
  original_format: string;
  original_name: string | null;
  zip_sha256: string;
  csv_sha256: string;
  archive_key: string | null;
  archive_url: string | null;
  changed: number;
  snapshot_id: string | null;
  note: string | null;
  created_at: string;
}

export interface GedsOrgVersionRow {
  org_id: string;
  org_key: string;
  valid_from_seq: number;
  valid_to_seq: number | null;
  last_seen_seq: number;
  department_acronym: string;
  department_name_en: string | null;
  department_name_fr: string | null;
  name_en: string;
  name_fr: string;
  acronym: string | null;
  parent_org_id: string | null;
  level: number;
  node_path: string;
  name_key_en: string;
  name_key_fr: string;
  search_en: string;
  search_fr: string;
  content_hash: string;
}

export interface GedsRoleVersionRow {
  role_id: string;
  role_key: string;
  valid_from_seq: number;
  valid_to_seq: number | null;
  last_seen_seq: number;
  person_id: string;
  org_id: string;
  department_acronym: string;
  title_en: string | null;
  title_fr: string | null;
  surname: string;
  given_name: string;
  initials: string | null;
  prefixes_en: string | null;
  prefixes_fr: string | null;
  suffixes_en: string | null;
  suffixes_fr: string | null;
  full_name: string;
  search_name: string;
  search_title_en: string;
  search_title_fr: string;
  search_en: string;
  search_fr: string;
  email: string | null;
  telephone: string | null;
  fax: string | null;
  tdd: string | null;
  secure_telephone: string | null;
  secure_fax: string | null;
  alternate_telephone: string | null;
  is_general_office: number;
  contact_json: string;
  content_hash: string;
  source_row: number;
}

export interface GedsRefreshSummary {
  ok: boolean;
  changed: boolean;
  observation: GedsSourceMetadata & {
    observationId: string;
    zipSha256: string;
    csvSha256: string;
    archived: boolean;
  };
  snapshot?: {
    id: string;
    seq: number;
    effectiveAt: string;
    publishedAt: string;
    sourceDate?: string;
    archiveKey?: string;
    manifestKey?: string;
  };
  counts: {
    sourceRows: number;
    storedRows: number;
    people: number;
    officeListings: number;
    organizations: number;
    roles: number;
    changes: number;
    added: number;
    changedRoles: number;
    removed: number;
    unchanged: number;
  };
  languageCoverage: {
    en: { rows: number; title: number; department: number; organization: number };
    fr: { rows: number; title: number; department: number; organization: number };
  };
  missing: Record<string, number>;
  unresolved: { sourceRow: number; reason: string }[];
  duplicateRoleKeys: number;
  resume: { resumed: boolean; lastRowNo: number };
  durationMs: number;
}
