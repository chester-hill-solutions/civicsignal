import type {
  GedsCitation,
  GedsContact,
  GedsNormalizedRow,
  GedsOrgNode,
  GedsRawRow,
  GedsSourceMetadata,
} from './types';

/**
 * Normalisation, and the identifiers that follow from it.
 *
 * The export has no key. So the directory's keys are built from what the
 * publisher does say, in the order the publisher makes it reliable:
 *
 *   person:  email + name, else direct line + name, else name + unit
 *   unit:    department acronym + the chain of DN tokens from the root
 *   role:    person + unit + published title + contact anchor + listing variant
 *
 * The digests are deterministic and non-cryptographic (two FNV-1a passes).
 * They are identifiers, not signatures; the collision argument is in
 * `docs/GEDS.md` and the tests assert that replaying an export produces the
 * same identifiers.
 */

const textEncoder = new TextEncoder();

/** Fold for search: accents removed, case removed, punctuation to spaces. */
export function fold(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** The publisher's value, with incidental whitespace collapsed but accents kept. */
export function published(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
}

export function nullIfEmpty(value: string | null | undefined): string | null {
  const next = published(value);
  return next ? next : null;
}

export function phoneDigits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D+/g, '');
}

export function fullNameOf(surname: string, givenName: string): string {
  return published([givenName, surname].filter(Boolean).join(' '));
}

function fnv1a64(input: string, seed: bigint): bigint {
  let hash = seed;
  for (const byte of textEncoder.encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * 1099511628211n) & 0xffffffffffffffffn;
  }
  return hash;
}

/**
 * A deterministic 128-bit identifier.
 *
 * Two independent FNV-1a passes with different offset bases. This is a naming
 * function, not a security boundary: the inputs are public data and nothing is
 * authenticated by the digest. It is synchronous so a 190,000-row import does
 * not make 600,000 await calls to WebCrypto.
 */
export function stableId(prefix: string, input: string): string {
  const a = fnv1a64(input, 0xcbf29ce484222325n).toString(16).padStart(16, '0');
  const b = fnv1a64(input, 0x84222325cbf29ce4n).toString(16).padStart(16, '0');
  return `${prefix}_${a}${b}`;
}

/** A stable hash of a value's canonical JSON, for change detection. */
export function stableHash(input: string): string {
  return stableId('h', input).slice(2);
}

function canonicalContacts(contacts: GedsContact[]): string {
  return JSON.stringify(
    contacts.map((c) => ({
      field: c.field,
      label: c.label,
      value: c.value,
      kind: c.kind,
      isGeneralOffice: c.isGeneralOffice,
      parts: c.parts ?? null,
    })),
  );
}

interface ParsedNode {
  name: string;
  ou: string | null;
}

function splitPathNodes(path: string): string[] {
  const parts = path.split('):');
  return parts
    .map((part, index) => (index < parts.length - 1 ? `${part})` : part).trim())
    .filter(Boolean);
}

/**
 * A node is `Display Name (OU=...,O=...,C=...)`, except when the publisher has
 * emitted a display name with parentheses in it (`Assistant Deputy Minister
 * Office (PMDB)`). The DN is the *last* balanced parenthesis group, not the
 * first.
 */
function parseNode(node: string): ParsedNode {
  const trimmed = node.trim();
  if (!trimmed.endsWith(')')) return { name: trimmed, ou: null };

  let depth = 0;
  let open = -1;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const char = trimmed[i];
    if (char === ')') depth++;
    else if (char === '(') {
      depth--;
      if (depth === 0) {
        open = i;
        break;
      }
    }
  }
  if (open <= 0) return { name: trimmed, ou: null };

  const name = trimmed.slice(0, open).trim();
  const attrs = trimmed.slice(open + 1, -1);
  const ou = /(?:^|,)\s*ou\s*=\s*([^,]+)/i.exec(attrs)?.[1]?.trim() ?? null;
  return { name, ou };
}

function nodeToken(node: ParsedNode, level: number): string {
  if (level === 0) return 'root';
  if (node.ou) return `ou:${fold(node.ou)}`;
  return `name:${fold(node.name)}`;
}

/**
 * Parse the bilingual organizational path into hierarchy nodes.
 *
 * The DN token chain is the identity. The display name is a versioned label.
 * Two rows that name the same chain in different cases (`O=GC` and `o=gc`)
 * resolve to one unit. Two units that share an acronym (`O-O`) do not, because
 * their chains differ.
 */
export function parseOrganizationPath(
  row: GedsRawRow,
  snapshotId: string,
  source: GedsSourceMetadata,
): { nodes: GedsOrgNode[]; leaf: GedsOrgNode; unresolved: string[] } {
  const unresolved: string[] = [];
  const en = splitPathNodes(published(row['Organization Structure (EN)']));
  const fr = splitPathNodes(published(row['Organization Structure (FR)']));
  const departmentAcronym = published(row['Department Acronym']);
  const departmentNameEn = published(row['Department Name (EN)']);
  const departmentNameFr = published(row['Department Name (FR)']);
  const leafAcronym = nullIfEmpty(row['Organization Acronym']);

  if (!en.length) {
    unresolved.push('missing organization structure');
  }
  if (en.length !== fr.length) {
    unresolved.push(`organization structure depth differs: en=${en.length} fr=${fr.length}`);
  }
  if (!departmentAcronym) unresolved.push('missing department acronym');

  const count = Math.max(en.length, fr.length, 1);
  const nodes: GedsOrgNode[] = [];
  const tokens: string[] = [];
  let parentOrgId: string | null = null;

  for (let level = 0; level < count; level++) {
    const enNode = parseNode(en[level] ?? '');
    const frNode = parseNode(fr[level] ?? '');
    const token = nodeToken(enNode, level);
    tokens.push(token);

    let nameEn = published(enNode.name);
    let nameFr = published(frNode.name);
    if (level === 1) {
      nameEn = departmentNameEn || nameEn;
      nameFr = departmentNameFr || nameFr;
    }
    if (!nameEn) {
      nameEn = nameFr || `Unnamed unit ${level}`;
      unresolved.push(`missing English organization name at level ${level}`);
    }
    if (!nameFr) {
      nameFr = nameEn;
      unresolved.push(`missing French organization name at level ${level}`);
    }

    const orgKey = `${departmentAcronym.toUpperCase()}|${tokens.join('/')}`;
    const orgId = stableId('org', orgKey);
    const acronym = level === 1 ? departmentAcronym : level === count - 1 ? leafAcronym : null;

    const searchEn = [
      fold(nameEn),
      fold(departmentNameEn),
      fold(departmentAcronym),
      fold(acronym ?? ''),
      tokens.join(' '),
    ].join(' | ');
    const searchFr = [
      fold(nameFr),
      fold(departmentNameFr),
      fold(departmentAcronym),
      fold(acronym ?? ''),
      tokens.join(' '),
    ].join(' | ');

    const node: GedsOrgNode = {
      orgId,
      orgKey,
      departmentAcronym,
      departmentNameEn,
      departmentNameFr,
      nameEn,
      nameFr,
      acronym: acronym || null,
      parentOrgId,
      level,
      nodePath: tokens.join('/'),
      nameKeyEn: fold(nameEn),
      nameKeyFr: fold(nameFr),
      searchEn,
      searchFr,
      contentHash: '',
    };
    node.contentHash = stableHash(
      JSON.stringify({
        nameEn: node.nameEn,
        nameFr: node.nameFr,
        acronym: node.acronym,
        parentOrgId: node.parentOrgId,
        level: node.level,
        departmentAcronym: node.departmentAcronym,
      }),
    );
    nodes.push(node);
    parentOrgId = orgId;
  }

  // The root and the department are not a "contactable unit" on their own for
  // the purposes of the directory's leaf lookup, but they are real hierarchy
  // nodes and are preserved. The last node is the published leaf.
  const leaf = nodes.at(-1);
  if (!leaf) throw new Error('No organization node was constructed.');
  void snapshotId;
  void source;
  return { nodes, leaf, unresolved };
}

const CONTACT_FIELDS: {
  field: keyof GedsRawRow;
  kind: GedsContact['kind'];
  en: string;
  fr: string;
}[] = [
  { field: 'Telephone Number', kind: 'telephone', en: 'Telephone Number', fr: 'Numéro de téléphone' },
  { field: 'Email', kind: 'email', en: 'Email', fr: 'Courriel' },
  { field: 'Fax Number', kind: 'fax', en: 'Fax Number', fr: 'Numéro de télécopieur' },
  { field: 'TDD Number', kind: 'tdd', en: 'TDD Number', fr: 'Numéro ATS' },
  {
    field: 'Secure Telephone Number',
    kind: 'secureTelephone',
    en: 'Secure Telephone Number',
    fr: 'Numéro de téléphone sécurisé',
  },
  { field: 'Secure Fax Number', kind: 'secureFax', en: 'Secure Fax Number', fr: 'Numéro de télécopieur sécurisé' },
  {
    field: 'Alternate Telephone Number',
    kind: 'alternateTelephone',
    en: 'Alternate Telephone Number',
    fr: 'Numéro de téléphone alternatif',
  },
];

/** Titles that the publisher uses for a desk rather than a named person. */
const GENERAL_OFFICE_TITLE =
  /\b(general\s+(enquir|inquir)|enquiries|inquiries|reception|accueil|renseignements?\s+g[ée]n[ée]raux)\b/i;

function postalContact(row: GedsRawRow, isGeneralOffice: boolean): GedsContact | null {
  const parts: Record<string, string> = {};
  const add = (key: string, value: string | null | undefined) => {
    const next = published(value);
    if (next) parts[key] = next;
  };
  add('streetEn', row['Street Address (EN)']);
  add('streetFr', row['Street Address (FR)']);
  add('poBoxEn', row['PO Box (EN)']);
  add('poBoxFr', row['PO Box (FR)']);
  add('cityEn', row['City (EN)']);
  add('cityFr', row['City (FR)']);
  add('provinceEn', row['Province (EN)']);
  add('provinceFr', row['Province (FR)']);
  add('countryEn', row['Country (EN)']);
  add('countryFr', row['Country (FR)']);
  add('postalCode', row['Postal Code']);
  add('buildingEn', row['Building (EN)']);
  add('buildingFr', row['Building (FR)']);
  add('mailstop', row['Mailstop']);
  add('floor', row['Floor']);
  add('room', row['Room']);
  if (Object.keys(parts).length === 0) return null;

  const value = [
    parts.streetEn || parts.streetFr,
    parts.cityEn || parts.cityFr,
    parts.provinceEn || parts.provinceFr,
    parts.postalCode,
    parts.countryEn || parts.countryFr,
  ]
    .filter(Boolean)
    .join(', ');
  return {
    field: 'Street Address',
    label: { en: 'Street Address', fr: 'Adresse' },
    value,
    kind: 'postal',
    isGeneralOffice,
    parts,
    citation: null as unknown as GedsCitation,
  };
}

function assistantContact(
  row: GedsRawRow,
  isGeneralOffice: boolean,
): GedsContact[] {
  const out: GedsContact[] = [];
  const add = (field: keyof GedsRawRow, kind: GedsContact['kind'], en: string, fr: string) => {
    const value = published(row[field]);
    if (!value) return;
    out.push({
      field,
      label: { en, fr },
      value,
      kind,
      isGeneralOffice,
      citation: null as unknown as GedsCitation,
    });
  };
  add('Administrative Assistant', 'administrativeAssistant', 'Administrative Assistant', 'Adjoint administratif');
  add(
    'Administrative Assistant Telephone Number',
    'administrativeAssistant',
    'Administrative Assistant Telephone Number',
    'Numéro de téléphone de l’adjoint administratif',
  );
  add('Executive Assistant', 'executiveAssistant', 'Executive Assistant', 'Adjoint exécutif');
  add(
    'Executive Assistant Telephone Number',
    'executiveAssistant',
    'Executive Assistant Telephone Number',
    'Numéro de téléphone de l’adjoint exécutif',
  );
  return out;
}

function citationText(args: {
  department: string;
  organization: string;
  fullName: string;
  title: string;
  label: string;
  value: string;
  observedAt: string;
  isGeneralOffice: boolean;
}): string {
  const who = args.fullName || args.title || 'Unnamed listing';
  const label = args.isGeneralOffice ? `General office — ${args.label}` : args.label;
  return `GEDS — ${args.department} — ${args.organization} — ${who} — ${label}: ${args.value} (observed ${args.observedAt})`;
}

function publishedContacts(row: GedsRawRow, isGeneralOffice: boolean) {
  const contactSeed: GedsContact[] = [];
  for (const spec of CONTACT_FIELDS) {
    const value = published(row[spec.field]);
    if (!value) continue;
    contactSeed.push({
      field: String(spec.field),
      label: { en: spec.en, fr: spec.fr },
      value: spec.field === 'Email' ? value.toLowerCase() : value,
      kind: spec.kind,
      isGeneralOffice,
      citation: null as unknown as GedsCitation,
    });
  }
  const postal = postalContact(row, isGeneralOffice);
  if (postal) contactSeed.push(postal);
  contactSeed.push(...assistantContact(row, isGeneralOffice));

  return contactSeed;
}

export function normalizeRow(
  row: GedsRawRow,
  sourceRow: number,
  snapshotId: string,
  source: GedsSourceMetadata,
): GedsNormalizedRow {
  const surname = published(row.Surname);
  const givenName = published(row.GivenName);
  const fullName = fullNameOf(surname, givenName);
  const titleEn = nullIfEmpty(row['Title (EN)']);
  const titleFr = nullIfEmpty(row['Title (FR)']);
  const email = nullIfEmpty(row.Email)?.toLowerCase() ?? null;
  const telephone = nullIfEmpty(row['Telephone Number']);
  const fax = nullIfEmpty(row['Fax Number']);
  const tdd = nullIfEmpty(row['TDD Number']);
  const secureTelephone = nullIfEmpty(row['Secure Telephone Number']);
  const secureFax = nullIfEmpty(row['Secure Fax Number']);
  const alternateTelephone = nullIfEmpty(row['Alternate Telephone Number']);
  const departmentAcronym = published(row['Department Acronym']);

  const { nodes, leaf, unresolved } = parseOrganizationPath(row, snapshotId, source);
  const isGeneralOffice =
    (!surname && !givenName) || GENERAL_OFFICE_TITLE.test(`${titleEn ?? ''} ${titleFr ?? ''}`);

  const contactSeed = publishedContacts(row, isGeneralOffice);

  // The role key is built before citations, because a citation names the role.
  // It deliberately excludes the snapshot metadata: the same role observed
  // twice must keep the same id.
  const nameKey = `${fold(surname)}|${fold(givenName)}`;
  const personKey =
    email != null
      ? `email:${email}|${nameKey}`
      : telephone != null
        ? `phone:${phoneDigits(telephone)}|${nameKey}`
        : `name:${nameKey}|dept:${fold(departmentAcronym)}|org:${leaf.orgKey}`;
  const personId = stableId('per', personKey);

  const anchor = email ?? phoneDigits(telephone) ?? phoneDigits(alternateTelephone);
  // A second, weaker discriminator keeps two publisher listings distinct when
  // the person, unit, title and primary contact are all identical (the export
  // contains a small number of these).
  const listingKey = stableHash(
    JSON.stringify({
      fax,
      tdd,
      secureTelephone,
      secureFax,
      alternateTelephone,
      address: published(row['Street Address (EN)']),
      postal: published(row['Postal Code']),
      building: published(row['Building (EN)']),
      mailstop: published(row['Mailstop']),
      room: published(row['Room']),
    }),
  );
  const roleKey = [
    personKey,
    leaf.orgKey,
    fold(titleEn ?? ''),
    fold(titleFr ?? ''),
    anchor,
    listingKey,
  ].join('|');
  const roleId = stableId('role', roleKey);

  const contacts = contactSeed.map((contact) => {
    const citation: GedsCitation = {
      datasetId: source.datasetId,
      datasetUrl: `https://open.canada.ca/data/dataset/${source.datasetId}`,
      resourceUrl: source.sourceUrl,
      sourceDate: source.sourceDate,
      observedAt: source.observedAt,
      snapshotId,
      entity: { type: 'role', id: roleId },
      field: contact.field,
      text: citationText({
        department: published(row['Department Name (EN)']) || departmentAcronym,
        organization: leaf.nameEn,
        fullName,
        title: titleEn ?? titleFr ?? '',
        label: contact.label.en,
        value: contact.value,
        observedAt: source.observedAt,
        isGeneralOffice,
      }),
    };
    return { ...contact, citation };
  });

  const initials = nullIfEmpty(row.Initials);
  const prefixesEn = nullIfEmpty(row['Prefix (EN)']);
  const prefixesFr = nullIfEmpty(row['Prefix (FR)']);
  const suffixesEn = nullIfEmpty(row['Suffix (EN)']);
  const suffixesFr = nullIfEmpty(row['Suffix (FR)']);

  const contentHash = stableHash(
    JSON.stringify({
      personId,
      orgId: leaf.orgId,
      surname,
      givenName,
      initials,
      prefixesEn,
      prefixesFr,
      suffixesEn,
      suffixesFr,
      titleEn,
      titleFr,
      isGeneralOffice,
      contacts: canonicalContacts(contacts),
    }),
  );

  const searchName = fold(fullName);
  const searchTitleEn = fold(titleEn ?? '');
  const searchTitleFr = fold(titleFr ?? '');
  const searchEn = [
    searchName,
    searchTitleEn,
    fold(published(row['Department Name (EN)'])),
    fold(leaf.nameEn),
    fold(departmentAcronym),
    fold(email ?? ''),
  ].join(' | ');
  const searchFr = [
    searchName,
    searchTitleFr,
    fold(published(row['Department Name (FR)'])),
    fold(leaf.nameFr),
    fold(departmentAcronym),
    fold(email ?? ''),
  ].join(' | ');

  return {
    sourceRow,
    personId,
    personKey,
    roleId,
    roleKey,
    orgId: leaf.orgId,
    orgKey: leaf.orgKey,
    surname,
    givenName,
    fullName,
    initials,
    prefixesEn,
    prefixesFr,
    suffixesEn,
    suffixesFr,
    titleEn,
    titleFr,
    email,
    telephone,
    fax,
    tdd,
    secureTelephone,
    secureFax,
    alternateTelephone,
    isGeneralOffice,
    contacts,
    contactJson: JSON.stringify(contacts),
    searchName,
    searchTitleEn,
    searchTitleFr,
    searchEn,
    searchFr,
    contentHash,
    nodes,
    unresolved,
  };
}
