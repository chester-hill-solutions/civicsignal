import { z } from 'zod';
import { allValues, firstValue, type GedsDatabase } from './db';
import { fold } from './normalize';
import type {
  GedsContact,
  GedsLanguage,
  GedsOrgVersionRow,
  GedsRoleVersionRow,
  GedsSnapshotRow,
} from './types';

/**
 * Read models for the GEDS surfaces.
 *
 * Every query resolves `asOf` to exactly one published snapshot and then asks
 * for the versions that were current **at that sequence**. A role that closed
 * in a later snapshot is still returned for an earlier `asOf`; a role that did
 * not exist yet is not.
 */

export class GedsQueryError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'GedsQueryError';
  }
}

export interface GedsReadContext {
  db: GedsDatabase;
  lang: GedsLanguage;
  asOf?: string;
  snapshot: GedsSnapshotRow;
}

export interface Page {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
}

export function parseLanguage(value: string | null | undefined): GedsLanguage {
  if (!value) return 'en';
  const normalized = value.toLowerCase().trim();
  if (normalized === 'fr' || normalized.startsWith('fr-')) return 'fr';
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  throw new GedsQueryError('INVALID_ARGUMENT', 'lang must be en or fr', 400);
}

export function parseLimit(value: string | null | undefined): number {
  if (value == null || value === '') return 20;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new GedsQueryError('INVALID_ARGUMENT', 'limit must be an integer from 1 to 100', 400);
  }
  return n;
}

export function parseOffset(value: string | null | undefined): number {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10_000) {
    throw new GedsQueryError('INVALID_ARGUMENT', 'offset must be an integer from 0 to 10000', 400);
  }
  return n;
}

function asOfBound(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // A date means the end of that date in UTC: the caller asked what the
  // directory said on the day, and the observation time is normally later that
  // day.
  if (z.iso.date().safeParse(trimmed).success) return trimmed + 'T23:59:59.999Z';
  if (!z.iso.datetime({ offset: true }).safeParse(trimmed).success) {
    throw new GedsQueryError('INVALID_ARGUMENT', 'asOf must be an ISO 8601 date or timestamp with a timezone', 400);
  }
  return new Date(trimmed).toISOString();
}

export async function resolveSnapshot(
  db: GedsDatabase,
  asOf?: string,
): Promise<GedsSnapshotRow> {
  const bound = asOfBound(asOf);
  const snapshot = bound
    ? await firstValue<GedsSnapshotRow>(
        db,
        `SELECT * FROM geds_snapshots
          WHERE status = 'published' AND effective_at <= ?
          ORDER BY effective_at DESC, seq DESC LIMIT 1`,
        bound,
      )
    : await firstValue<GedsSnapshotRow>(
        db,
        `SELECT * FROM geds_snapshots WHERE status = 'published' ORDER BY seq DESC LIMIT 1`,
      );
  if (!snapshot) {
    throw new GedsQueryError(
      'NO_SNAPSHOT_AS_OF',
      bound
        ? `No published GEDS snapshot was observed on or before ${bound}`
        : 'No GEDS snapshot has been published',
      404,
    );
  }
  return snapshot;
}

export async function readContext(
  db: GedsDatabase,
  params: { lang?: string | null; asOf?: string | null },
): Promise<GedsReadContext> {
  return {
    db,
    lang: parseLanguage(params.lang),
    asOf: asOfBound(params.asOf ?? undefined),
    snapshot: await resolveSnapshot(db, params.asOf ?? undefined),
  };
}

function pageOf(limit: number, offset: number, total: number): Page {
  return { limit, offset, total, hasMore: offset + limit < total };
}

interface OrgJoinedRow extends GedsOrgVersionRow {
  parent_name_en: string | null;
  parent_name_fr: string | null;
  parent_acronym: string | null;
}

function orgView(row: OrgJoinedRow, lang: GedsLanguage) {
  const parent =
    row.parent_org_id && row.parent_name_en
      ? {
          id: row.parent_org_id,
          name: lang === 'fr' ? row.parent_name_fr || row.parent_name_en : row.parent_name_en,
          nameEn: row.parent_name_en,
          nameFr: row.parent_name_fr || row.parent_name_en,
          acronym: row.parent_acronym,
        }
      : null;
  return {
    id: row.org_id,
    name: lang === 'fr' ? row.name_fr : row.name_en,
    nameEn: row.name_en,
    nameFr: row.name_fr,
    acronym: row.acronym,
    department: {
      acronym: row.department_acronym,
      name: lang === 'fr' ? row.department_name_fr : row.department_name_en,
      nameEn: row.department_name_en,
      nameFr: row.department_name_fr,
    },
    parent,
    level: row.level,
    path: row.node_path,
  };
}

const ORG_SELECT = `SELECT o.*,
    p.name_en AS parent_name_en, p.name_fr AS parent_name_fr, p.acronym AS parent_acronym
  FROM geds_organizations o
  LEFT JOIN geds_organizations p
    ON p.org_id = o.parent_org_id
   AND p.valid_from_seq <= ?
   AND (p.valid_to_seq IS NULL OR p.valid_to_seq > ?)
  WHERE o.valid_from_seq <= ?
    AND (o.valid_to_seq IS NULL OR o.valid_to_seq > ?)`;

export async function searchOrganizations(
  ctx: GedsReadContext,
  params: { q?: string | null; limit?: string | null; offset?: string | null; exact?: boolean },
) {
  const q = (params.q ?? '').trim();
  if (q.length > 200) throw new GedsQueryError('INVALID_ARGUMENT', 'q is too long', 400);
  const limit = parseLimit(params.limit ?? undefined);
  const offset = parseOffset(params.offset ?? undefined);
  const folded = fold(q);
  const seq = ctx.snapshot.seq;

  const filters: string[] = ['o.level > 0'];
  const values: (string | number)[] = [seq, seq, seq, seq];
  if (folded) {
    if (params.exact) {
      filters.push('(o.name_key_en = ? OR o.name_key_fr = ? OR lower(o.acronym) = ?)');
      values.push(folded, folded, folded);
    } else {
      const like = `%${folded}%`;
      filters.push('(o.search_en LIKE ? OR o.search_fr LIKE ? OR lower(o.acronym) LIKE ?)');
      values.push(like, like, like);
    }
  }
  const where = `${ORG_SELECT} AND ${filters.join(' AND ')}`;
  const count = await firstValue<{ n: number }>(
    ctx.db,
    `SELECT COUNT(*) AS n FROM (${where})`,
    ...values,
  );
  const rows = await allValues<OrgJoinedRow>(
    ctx.db,
    `${where}
     ORDER BY CASE WHEN o.level = 1 THEN 0 ELSE 1 END, o.level, o.name_en
     LIMIT ? OFFSET ?`,
    ...values,
    limit,
    offset,
  );
  return {
    items: rows.map((row) => orgView(row, ctx.lang)),
    page: pageOf(limit, offset, Number(count?.n ?? 0)),
  };
}

async function orgById(ctx: GedsReadContext, orgId: string): Promise<OrgJoinedRow | null> {
  const seq = ctx.snapshot.seq;
  return firstValue<OrgJoinedRow>(
    ctx.db,
    `${ORG_SELECT} AND o.org_id = ?`,
    seq,
    seq,
    seq,
    seq,
    orgId,
  );
}

export async function getOrganization(ctx: GedsReadContext, orgId: string) {
  const row = await orgById(ctx, orgId);
  if (!row) throw new GedsQueryError('NOT_FOUND', `No organization ${orgId} at this snapshot`, 404);

  const seq = ctx.snapshot.seq;
  const ancestors = await allValues<OrgJoinedRow>(
    ctx.db,
    `WITH RECURSIVE up(org_id, depth) AS (
       SELECT org_id, 0 FROM geds_organizations
        WHERE org_id = ? AND valid_from_seq <= ? AND (valid_to_seq IS NULL OR valid_to_seq > ?)
       UNION ALL
       SELECT p.org_id, up.depth + 1
         FROM up
         JOIN geds_organizations c
           ON c.org_id = up.org_id AND c.valid_from_seq <= ?
          AND (c.valid_to_seq IS NULL OR c.valid_to_seq > ?)
         JOIN geds_organizations p
           ON p.org_id = c.parent_org_id AND p.valid_from_seq <= ?
          AND (p.valid_to_seq IS NULL OR p.valid_to_seq > ?)
     )
     SELECT o.*, p.name_en AS parent_name_en, p.name_fr AS parent_name_fr, p.acronym AS parent_acronym
       FROM up JOIN geds_organizations o ON o.org_id = up.org_id
       AND o.valid_from_seq <= ? AND (o.valid_to_seq IS NULL OR o.valid_to_seq > ?)
       LEFT JOIN geds_organizations p ON p.org_id = o.parent_org_id
       AND p.valid_from_seq <= ? AND (p.valid_to_seq IS NULL OR p.valid_to_seq > ?)
      ORDER BY up.depth DESC`,
    orgId,
    seq,
    seq,
    seq,
    seq,
    seq,
    seq,
    seq,
    seq,
    seq,
    seq,
  );

  const children = await allValues<OrgJoinedRow>(
    ctx.db,
    `${ORG_SELECT} AND o.parent_org_id = ? ORDER BY o.name_en LIMIT 100`,
    seq,
    seq,
    seq,
    seq,
    orgId,
  );

  const peopleCount = await firstValue<{ n: number }>(
    ctx.db,
    `SELECT COUNT(DISTINCT person_id) AS n FROM geds_roles
      WHERE org_id = ? AND is_general_office = 0
        AND valid_from_seq <= ? AND (valid_to_seq IS NULL OR valid_to_seq > ?)`,
    orgId,
    seq,
    seq,
  );

  const office = await firstValue<GedsRoleVersionRow>(
    ctx.db,
    `SELECT * FROM geds_roles
      WHERE org_id = ? AND is_general_office = 1
        AND valid_from_seq <= ? AND (valid_to_seq IS NULL OR valid_to_seq > ?)
      ORDER BY valid_from_seq DESC, role_id LIMIT 1`,
    orgId,
    seq,
    seq,
  );

  return {
    organization: orgView(row, ctx.lang),
    ancestors: ancestors.map((ancestor) => orgView(ancestor, ctx.lang)),
    children: children.map((child) => orgView(child, ctx.lang)),
    peopleCount: Number(peopleCount?.n ?? 0),
    officeContact: office ? roleView(office, ctx.lang, ctx, null) : null,
  };
}

export async function getHierarchy(ctx: GedsReadContext, orgId: string) {
  const detail = await getOrganization(ctx, orgId);
  return {
    organization: detail.organization,
    ancestors: detail.ancestors,
    children: detail.children,
  };
}

interface RoleJoinedRow extends GedsRoleVersionRow {
  org_name_en: string;
  org_name_fr: string;
  org_acronym: string | null;
  org_level: number;
}

const ROLE_JOIN = `FROM geds_roles r
  JOIN geds_organizations o
    ON o.org_id = r.org_id
   AND o.valid_from_seq <= ?
   AND (o.valid_to_seq IS NULL OR o.valid_to_seq > ?)
  WHERE r.valid_from_seq <= ?
    AND (r.valid_to_seq IS NULL OR r.valid_to_seq > ?)`;

function parseContacts(row: GedsRoleVersionRow): GedsContact[] {
  try {
    const parsed = JSON.parse(row.contact_json) as GedsContact[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function contactFor(row: GedsRoleVersionRow, lang: GedsLanguage, ctx: GedsReadContext) {
  const contacts = parseContacts(row);
  const order = [
    'telephone',
    'email',
    'alternateTelephone',
    'secureTelephone',
    'fax',
    'tdd',
    'secureFax',
    'postal',
    'administrativeAssistant',
    'executiveAssistant',
  ];
  const selected =
    order
      .map((kind) => contacts.find((contact) => contact.kind === kind))
      .find((contact): contact is GedsContact => Boolean(contact)) ?? null;
  if (!selected) return null;
  return contactView(selected, lang, ctx, row);
}

function contactView(
  contact: GedsContact,
  lang: GedsLanguage,
  ctx: GedsReadContext,
  row: GedsRoleVersionRow | null,
) {
  const publisherLabel = lang === 'fr' ? contact.label.fr : contact.label.en;
  const label = contact.isGeneralOffice
    ? lang === 'fr'
      ? `Bureau principal — ${publisherLabel}`
      : `General office — ${publisherLabel}`
    : publisherLabel;
  return {
    kind: contact.kind,
    field: contact.field,
    label,
    publisherLabel,
    value: contact.value,
    isGeneralOffice: contact.isGeneralOffice,
    ...(contact.parts ? { parts: contact.parts } : {}),
    citation: {
      ...contact.citation,
      asOf: ctx.asOf ?? ctx.snapshot.effective_at,
      text: contact.citation.text,
      ...(row ? { roleId: row.role_id, personId: row.person_id } : {}),
    },
  };
}

function roleView(row: RoleJoinedRow | GedsRoleVersionRow, lang: GedsLanguage, ctx: GedsReadContext, _unused: null) {
  const joined = row as RoleJoinedRow;
  const orgNameEn = joined.org_name_en ?? null;
  const orgNameFr = joined.org_name_fr ?? null;
  const contacts = parseContacts(row);
  return {
    id: row.role_id,
    title: {
      en: row.title_en,
      fr: row.title_fr,
      selected: lang === 'fr' ? row.title_fr ?? row.title_en : row.title_en ?? row.title_fr,
    },
    organization:
      orgNameEn != null
        ? {
            id: row.org_id,
            name: lang === 'fr' ? orgNameFr ?? orgNameEn : orgNameEn,
            nameEn: orgNameEn,
            nameFr: orgNameFr,
            acronym: joined.org_acronym,
          }
        : { id: row.org_id },
    isGeneralOffice: Boolean(row.is_general_office),
    contacts: contacts.map((contact) => contactView(contact, lang, ctx, row)),
    contact: contactFor(row, lang, ctx),
    validFromSeq: row.valid_from_seq,
    observedAt: ctx.snapshot.effective_at,
    asOf: ctx.asOf ?? ctx.snapshot.effective_at,
  };
}

function personBase(row: RoleJoinedRow | GedsRoleVersionRow, lang: GedsLanguage) {
  const joined = row as RoleJoinedRow;
  const orgNameEn = joined.org_name_en ?? null;
  return {
    id: row.person_id,
    name: row.full_name,
    givenName: row.given_name,
    surname: row.surname,
    initials: row.initials,
    title: {
      en: row.title_en,
      fr: row.title_fr,
      selected: lang === 'fr' ? row.title_fr ?? row.title_en : row.title_en ?? row.title_fr,
    },
    organization:
      orgNameEn != null
        ? {
            id: row.org_id,
            name: lang === 'fr' ? joined.org_name_fr ?? orgNameEn : orgNameEn,
            nameEn: orgNameEn,
            nameFr: joined.org_name_fr,
            acronym: joined.org_acronym,
          }
        : { id: row.org_id },
    email: row.email,
    telephone: row.telephone,
    isGeneralOffice: Boolean(row.is_general_office),
  };
}

export async function searchPeople(
  ctx: GedsReadContext,
  params: {
    q?: string | null;
    limit?: string | null;
    offset?: string | null;
    exact?: boolean;
    organizationId?: string | null;
  },
) {
  const q = (params.q ?? '').trim();
  if (q.length > 200) throw new GedsQueryError('INVALID_ARGUMENT', 'q is too long', 400);
  const limit = parseLimit(params.limit ?? undefined);
  const offset = parseOffset(params.offset ?? undefined);
  const folded = fold(q);
  const seq = ctx.snapshot.seq;

  const filters: string[] = ['r.is_general_office = 0'];
  const values: (string | number | null)[] = [seq, seq, seq, seq];
  if (folded) {
    const like = `%${folded}%`;
    if (params.exact) {
      filters.push('(r.search_name = ? OR lower(r.email) = ?)');
      values.push(folded, folded);
    } else {
      filters.push('(r.search_en LIKE ? OR r.search_fr LIKE ? OR lower(r.email) LIKE ?)');
      values.push(like, like, like);
    }
  }
  if (params.organizationId) {
    filters.push('r.org_id = ?');
    values.push(params.organizationId);
  }
  const where = `${ROLE_JOIN}${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`;
  const total = await firstValue<{ n: number }>(
    ctx.db,
    `SELECT COUNT(DISTINCT r.person_id) AS n ${where}`,
    ...values,
  );
  const rows = await allValues<RoleJoinedRow>(
    ctx.db,
    `WITH matched AS (
       SELECT r.*, ROW_NUMBER() OVER (
         PARTITION BY r.person_id ORDER BY r.valid_from_seq DESC, r.role_id
       ) AS rn
       ${where}
     )
     SELECT m.*, o.name_en AS org_name_en, o.name_fr AS org_name_fr,
            o.acronym AS org_acronym, o.level AS org_level
       FROM matched m
       JOIN geds_organizations o ON o.org_id = m.org_id
        AND o.valid_from_seq <= ? AND (o.valid_to_seq IS NULL OR o.valid_to_seq > ?)
      WHERE m.rn = 1
      ORDER BY m.search_name, m.role_id
      LIMIT ? OFFSET ?`,
    ...values,
    seq,
    seq,
    limit,
    offset,
  );

  return {
    items: rows.map((row) => ({
      ...personBase(row, ctx.lang),
      contact: contactFor(row, ctx.lang, ctx),
    })),
    page: pageOf(limit, offset, Number(total?.n ?? 0)),
  };
}

async function rolesForPerson(ctx: GedsReadContext, personId: string) {
  const seq = ctx.snapshot.seq;
  return allValues<RoleJoinedRow>(
    ctx.db,
    `SELECT r.*, o.name_en AS org_name_en, o.name_fr AS org_name_fr,
            o.acronym AS org_acronym, o.level AS org_level
       ${ROLE_JOIN} AND r.person_id = ?
      ORDER BY o.level, o.name_en, r.role_id`,
    seq,
    seq,
    seq,
    seq,
    personId,
  );
}

export async function getPerson(ctx: GedsReadContext, personId: string) {
  const roles = await rolesForPerson(ctx, personId);
  if (!roles.length) {
    throw new GedsQueryError('NOT_FOUND', `No person ${personId} at this snapshot`, 404);
  }
  const first = roles[0];
  if (!first) throw new GedsQueryError('NOT_FOUND', `No person ${personId} at this snapshot`, 404);
  return {
    ...personBase(first, ctx.lang),
    roles: roles.map((role) => roleView(role, ctx.lang, ctx, null)),
    snapshot: snapshotView(ctx.snapshot),
    asOf: ctx.asOf ?? ctx.snapshot.effective_at,
  };
}

export async function getPersonContact(
  ctx: GedsReadContext,
  personId: string,
  params: { organizationId?: string | null; roleId?: string | null },
) {
  const roles = await rolesForPerson(ctx, personId);
  if (!roles.length) {
    throw new GedsQueryError('NOT_FOUND', `No person ${personId} at this snapshot`, 404);
  }
  const filtered = roles.filter(
    (role) =>
      (!params.organizationId || role.org_id === params.organizationId) &&
      (!params.roleId || role.role_id === params.roleId),
  );
  const candidates = filtered.length ? filtered : roles;
  const personRole = candidates[0] ?? roles[0];
  if (!personRole) throw new GedsQueryError('NOT_FOUND', `No person ${personId} at this snapshot`, 404);
  for (const role of candidates) {
    const contact = contactFor(role, ctx.lang, ctx);
    if (contact) {
      return {
        person: personBase(role, ctx.lang),
        role: roleView(role, ctx.lang, ctx, null),
        contact,
        reachedVia: contact.isGeneralOffice ? 'general-office' : 'direct',
        snapshot: snapshotView(ctx.snapshot),
        asOf: ctx.asOf ?? ctx.snapshot.effective_at,
      };
    }
  }

  // The person has no contact of their own. Fall through to the general office
  // of the unit they are published in, and say so rather than inventing a
  // direct line.
  const orgId = candidates[0]?.org_id;
  if (orgId) {
    const office = await firstValue<RoleJoinedRow>(
      ctx.db,
      `SELECT r.*, o.name_en AS org_name_en, o.name_fr AS org_name_fr,
              o.acronym AS org_acronym, o.level AS org_level
         ${ROLE_JOIN} AND r.org_id = ? AND r.is_general_office = 1
        ORDER BY r.valid_from_seq DESC, r.role_id LIMIT 1`,
      ctx.snapshot.seq,
      ctx.snapshot.seq,
      ctx.snapshot.seq,
      ctx.snapshot.seq,
      orgId,
    );
    if (office) {
      const contact = contactFor(office, ctx.lang, ctx);
      if (contact) {
        return {
          person: personBase(personRole, ctx.lang),
          role: roleView(office, ctx.lang, ctx, null),
          contact,
          reachedVia: 'general-office',
          snapshot: snapshotView(ctx.snapshot),
          asOf: ctx.asOf ?? ctx.snapshot.effective_at,
        };
      }
    }
  }
  return {
    person: personBase(personRole, ctx.lang),
    role: null,
    contact: null,
    reachedVia: 'none',
    snapshot: snapshotView(ctx.snapshot),
    asOf: ctx.asOf ?? ctx.snapshot.effective_at,
  };
}

async function orgSubtree(ctx: GedsReadContext, orgId: string): Promise<string[]> {
  const seq = ctx.snapshot.seq;
  const rows = await allValues<{ org_id: string }>(
    ctx.db,
    `WITH RECURSIVE tree(org_id) AS (
       SELECT org_id FROM geds_organizations
        WHERE org_id = ? AND valid_from_seq <= ? AND (valid_to_seq IS NULL OR valid_to_seq > ?)
       UNION ALL
       SELECT c.org_id FROM geds_organizations c
        JOIN tree t ON c.parent_org_id = t.org_id
        WHERE c.valid_from_seq <= ? AND (c.valid_to_seq IS NULL OR c.valid_to_seq > ?)
     )
     SELECT org_id FROM tree`,
    orgId,
    seq,
    seq,
    seq,
    seq,
  );
  return rows.map((row) => row.org_id);
}

export async function getOrganizationPeople(
  ctx: GedsReadContext,
  orgId: string,
  params: { limit?: string | null; offset?: string | null; descendants?: boolean },
) {
  const organization = await orgById(ctx, orgId);
  if (!organization) {
    throw new GedsQueryError('NOT_FOUND', `No organization ${orgId} at this snapshot`, 404);
  }
  const limit = parseLimit(params.limit ?? undefined);
  const offset = parseOffset(params.offset ?? undefined);
  const seq = ctx.snapshot.seq;
  const ids = params.descendants ? await orgSubtree(ctx, orgId) : [orgId];
  const placeholders = ids.map(() => '?').join(', ');
  const total = await firstValue<{ n: number }>(
    ctx.db,
    `SELECT COUNT(DISTINCT r.person_id) AS n FROM geds_roles r
      WHERE r.valid_from_seq <= ? AND (r.valid_to_seq IS NULL OR r.valid_to_seq > ?)
        AND r.is_general_office = 0
        AND r.org_id IN (${placeholders})`,
    seq,
    seq,
    ...ids,
  );

  const rows = await allValues<RoleJoinedRow>(
    ctx.db,
    `WITH matched AS (
       SELECT r.*, ROW_NUMBER() OVER (
         PARTITION BY r.person_id ORDER BY r.valid_from_seq DESC, r.role_id
       ) AS rn
       FROM geds_roles r
      WHERE r.valid_from_seq <= ? AND (r.valid_to_seq IS NULL OR r.valid_to_seq > ?)
        AND r.is_general_office = 0
        AND r.org_id IN (${placeholders})
     )
     SELECT m.*, o.name_en AS org_name_en, o.name_fr AS org_name_fr,
            o.acronym AS org_acronym, o.level AS org_level
       FROM matched m
       JOIN geds_organizations o ON o.org_id = m.org_id
        AND o.valid_from_seq <= ? AND (o.valid_to_seq IS NULL OR o.valid_to_seq > ?)
      WHERE m.rn = 1
      ORDER BY m.search_name, m.role_id
      LIMIT ? OFFSET ?`,
    seq,
    seq,
    ...ids,
    seq,
    seq,
    limit,
    offset,
  );

  const people = [];
  for (const row of rows) {
    const roles = await allValues<RoleJoinedRow>(
      ctx.db,
      `SELECT r.*, o.name_en AS org_name_en, o.name_fr AS org_name_fr,
              o.acronym AS org_acronym, o.level AS org_level
         ${ROLE_JOIN} AND r.person_id = ? AND r.is_general_office = 0
          AND r.org_id IN (${placeholders})
        ORDER BY o.level, o.name_en, r.role_id`,
      seq,
      seq,
      seq,
      seq,
      row.person_id,
      ...ids,
    );
    people.push({
      ...personBase(row, ctx.lang),
      roles: roles.map((role) => roleView(role, ctx.lang, ctx, null)),
      contact: contactFor(row, ctx.lang, ctx),
    });
  }

  let officeContact = null;
  if (!rows.length) {
    const office = await firstValue<RoleJoinedRow>(
      ctx.db,
      `SELECT r.*, o.name_en AS org_name_en, o.name_fr AS org_name_fr,
              o.acronym AS org_acronym, o.level AS org_level
         ${ROLE_JOIN} AND r.org_id = ? AND r.is_general_office = 1
        ORDER BY r.valid_from_seq DESC, r.role_id LIMIT 1`,
      seq,
      seq,
      seq,
      seq,
      orgId,
    );
    if (office) {
      officeContact = {
        role: roleView(office, ctx.lang, ctx, null),
        contact: contactFor(office, ctx.lang, ctx),
        reachedVia: 'general-office',
      };
    }
  }

  return {
    organization: orgView(organization, ctx.lang),
    items: people,
    officeContact,
    page: pageOf(limit, offset, Number(total?.n ?? 0)),
    snapshot: snapshotView(ctx.snapshot),
    asOf: ctx.asOf ?? ctx.snapshot.effective_at,
  };
}

export function snapshotView(snapshot: GedsSnapshotRow) {
  return {
    id: snapshot.snapshot_id,
    seq: snapshot.seq,
    effectiveAt: snapshot.effective_at,
    publishedAt: snapshot.published_at,
    sourceDate: snapshot.source_date,
    sourceUrl: snapshot.source_url,
    datasetId: snapshot.dataset_id,
    datasetUrl: `https://open.canada.ca/data/dataset/${snapshot.dataset_id}`,
    original: {
      sha256: snapshot.zip_sha256,
      csvSha256: snapshot.csv_sha256,
      archiveKey: snapshot.archive_key,
    },
  };
}

export function withSnapshot<T extends object>(
  ctx: GedsReadContext,
  payload: T,
): T & { language: GedsLanguage; asOf: string; snapshot: ReturnType<typeof snapshotView> } {
  return {
    ...payload,
    language: ctx.lang,
    asOf: ctx.asOf ?? ctx.snapshot.effective_at,
    snapshot: snapshotView(ctx.snapshot),
  };
}
