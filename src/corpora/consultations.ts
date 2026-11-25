import { z } from 'zod';
import { parseCsvText } from '../csv';
import { normalizeForSearch } from '../text';

export const CONSULTATION_SOURCE = 'canada';

export const ConsultationLanguageSchema = z.enum(['en', 'fr']);
export const ConsultationStateSchema = z.enum(['open', 'planned', 'closed', 'unknown']);
export const ConsultationStatusCodeSchema = z.string().regex(/^[A-Z]{1,3}$/);
export const ConsultationLabelSchema = z.strictObject({ en: z.string(), fr: z.string() });

const consultationUrl = z.url({ protocol: /^https?$/ });
export const ConsultationLinkSchema = z.strictObject({
  published: z.string(),
  url: consultationUrl.nullable(),
  kind: z.enum(['official', 'third-party-wrapper', 'missing', 'unparsable']),
  unwrapped: consultationUrl.nullable(),
});

export const ConsultationEditionSchema = z.strictObject({
  language: ConsultationLanguageSchema,
  title: z.string().min(1),
  description: z.string().nullable(),
  profile: ConsultationLinkSchema,
  reportUrl: ConsultationLinkSchema.nullable(),
});

const ConsultationCodeLabelSchema = z.strictObject({
  code: ConsultationStatusCodeSchema,
  label: ConsultationLabelSchema,
  inferred: z.boolean(),
});

const ConsultationDateRangeSchema = z.strictObject({
  start: z.iso.date().nullable(),
  end: z.iso.date().nullable(),
});

const ConsultationCodeEntrySchema = z.strictObject({
  code: z.string(),
  label: ConsultationLabelSchema.nullable(),
});

export const ConsultationFactsSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9.-]+_[A-Za-z0-9.-]+$/),
  source: z.literal(CONSULTATION_SOURCE),
  registrationNumber: z.string(),
  ownerOrg: z.string(),
  institution: ConsultationLabelSchema,
  statusCode: ConsultationStatusCodeSchema,
  status: ConsultationCodeLabelSchema,
  editions: z.strictObject({
    en: ConsultationEditionSchema,
    fr: ConsultationEditionSchema,
  }),
  dates: ConsultationDateRangeSchema,
  stateAtObservation: ConsultationStateSchema,
  statusAgreesWithDates: z.boolean().nullable(),
  subjects: z.array(ConsultationCodeEntrySchema),
  partnerDepartments: z.array(ConsultationCodeEntrySchema),
  reportAvailableOnline: z.boolean().nullable(),
});

export const ConsultationRecordSchema = ConsultationFactsSchema.extend({
  firstObservedAt: z.iso.datetime({ offset: true }),
  lastObservedAt: z.iso.datetime({ offset: true }),
  revision: z.number().int().nonnegative(),
  removedAt: z.iso.datetime({ offset: true }).nullable()
    .describe('When a later full catalogue no longer listed this consultation.'),
});

export const ConsultationRevisionSchema = z.strictObject({
  observedAt: z.iso.datetime({ offset: true }),
  revision: z.number().int().nonnegative(),
  event: z.enum(['added', 'changed', 'removed']),
  changedFields: z.array(z.string()),
});

export const ConsultationSearchItemSchema = z.strictObject({
  id: ConsultationFactsSchema.shape.id,
  registrationNumber: z.string(),
  ownerOrg: z.string(),
  institution: ConsultationLabelSchema,
  title: z.string(),
  description: z.string().max(400).nullable(),
  dates: ConsultationDateRangeSchema,
  state: ConsultationStateSchema,
  statusCode: ConsultationStatusCodeSchema,
  status: ConsultationLabelSchema,
  editions: z.array(ConsultationLanguageSchema),
  reportAvailableOnline: z.boolean().nullable(),
  match: z.strictObject({
    field: z.enum(['title', 'description']),
    snippet: z.string(),
  }),
});

export const ConsultationSearchResponseSchema = z.strictObject({
  source: z.literal(CONSULTATION_SOURCE),
  observedAt: z.iso.datetime({ offset: true }),
  asOf: z.iso.datetime({ offset: true }),
  items: z.array(ConsultationSearchItemSchema),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export const ConsultationLookupResponseSchema = z.strictObject({
  source: z.literal(CONSULTATION_SOURCE),
  observedAt: z.iso.datetime({ offset: true }),
  asOf: z.iso.datetime({ offset: true }),
  item: ConsultationRecordSchema.nullable(),
  revisions: z.array(ConsultationRevisionSchema),
  participationNotices: z.strictObject({
    catalogueRevision: z.string().min(1),
    editions: z.array(z.strictObject({
      consultationId: ConsultationFactsSchema.shape.id,
      catalogueRevision: z.string().min(1),
      language: ConsultationLanguageSchema,
      status: z.enum(['pending', 'fetched', 'missing-link', 'unrecognized-link-kind', 'unrecognized-host',
        'unrecognized-url', 'http-error', 'fetch-error', 'archive-budget']),
      checkedAt: z.iso.datetime({ offset: true }),
      httpStatus: z.number().int().min(100).max(599).nullable(),
      sourceHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
      sourceBytes: z.number().int().nonnegative().nullable(),
      sourceUrl: z.url({ protocol: /^https?$/ }).nullable(),
      finalUrl: z.url({ protocol: /^https?$/ }).nullable(),
      sources: z.array(z.strictObject({
        order: z.number().int().nonnegative(),
        status: z.enum(['pending', 'fetched', 'missing-link', 'unrecognized-link-kind', 'unrecognized-host',
          'unrecognized-url', 'http-error', 'fetch-error', 'archive-budget']),
        sourceUrl: z.url({ protocol: /^https?$/ }).nullable(),
        finalUrl: z.url({ protocol: /^https?$/ }).nullable(),
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
        sourceBytes: z.number().int().nonnegative().nullable(),
      })),
      lastAttemptStatus: z.string().min(1).max(50).nullable().optional(),
      lastAttemptAt: z.iso.datetime({ offset: true }).nullable().optional(),
      sections: z.array(z.strictObject({
        kind: z.enum(['eligibility', 'deadline', 'submission-instructions']),
        heading: z.string().min(1),
        citationUrl: z.url({ protocol: /^https?$/ }),
        sourceUrl: z.url({ protocol: /^https?$/ }),
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
        quote: z.string().min(1).max(4000),
        truncated: z.boolean(),
      })),
    })),
  }).optional().describe('Present only when the optional local notice store is configured. Editions are joined on the exact current catalogue revision, consultation ID, and language.'),
});

export const ConsultationCoverageSchema = z.strictObject({
  source: z.literal(CONSULTATION_SOURCE),
  observedAt: z.iso.datetime({ offset: true }),
  csvSha256: z.string(),
  schemaSha256: z.string(),
  counts: z.strictObject({
    total: z.number().int().nonnegative(),
    byState: z.strictObject({
      open: z.number().int().nonnegative(),
      planned: z.number().int().nonnegative(),
      closed: z.number().int().nonnegative(),
      unknown: z.number().int().nonnegative(),
    }),
    statusCodes: z.record(z.string(), z.number().int().nonnegative()),
    removed: z.number().int().nonnegative()
      .describe('Records absent from the latest full catalogue; still retrievable with their history.'),
    stale: z.number().int().nonnegative()
      .describe('Records last observed before the current catalogue observation.'),
  }),
  editions: z.strictObject({
    missingDescriptionFr: z.number().int().nonnegative(),
    missingTitleFr: z.number().int().nonnegative(),
    profileLinkKinds: z.strictObject({
      official: z.number().int().nonnegative(),
      'third-party-wrapper': z.number().int().nonnegative(),
      missing: z.number().int().nonnegative(),
      unparsable: z.number().int().nonnegative(),
    }),
  }),
  reports: z.strictObject({ available: z.number().int().nonnegative() }),
  revisions: z.strictObject({ total: z.number().int().nonnegative() }),
});

export type ConsultationLanguage = z.infer<typeof ConsultationLanguageSchema>;
export type ConsultationState = z.infer<typeof ConsultationStateSchema>;
export type ConsultationLabel = z.infer<typeof ConsultationLabelSchema>;
export type ConsultationLink = z.infer<typeof ConsultationLinkSchema>;
export type ConsultationEdition = z.infer<typeof ConsultationEditionSchema>;
export type ConsultationFacts = z.infer<typeof ConsultationFactsSchema>;
export type ConsultationRecord = z.infer<typeof ConsultationRecordSchema>;
export type ConsultationRevision = z.infer<typeof ConsultationRevisionSchema>;
export type ConsultationSearchItem = z.infer<typeof ConsultationSearchItemSchema>;
export type ConsultationSearchResponse = z.infer<typeof ConsultationSearchResponseSchema>;
export type ConsultationLookupResponse = z.infer<typeof ConsultationLookupResponseSchema>;
export type ConsultationNoticeEdition = NonNullable<ConsultationLookupResponse['participationNotices']>['editions'][number];
export type ConsultationCoverage = z.infer<typeof ConsultationCoverageSchema>;

export interface ConsultationDictionary {
  subjects: Map<string, ConsultationLabel>;
  partnerDepartments: Map<string, ConsultationLabel>;
  statusLabels: Map<string, ConsultationLabel>;
}

/**
 * The composite identity, with the publisher's case kept in the registration.
 *
 * The source repeats numbers across departments, and one department published
 * `c-ISC0016` and `c-isc0016` as separate consultations. Lowercasing the
 * registration merged them, so only the owner is normalised here.
 */
export function consultationId(ownerOrg: string, registrationNumber: string): string {
  const owner = ownerOrg.toLowerCase().replace(/[^a-z0-9.-]/g, '-');
  const registration = registrationNumber.replace(/[^A-Za-z0-9.-]/g, '-');
  return `${owner}_${registration}`;
}

export function parseConsultationCsv(text: string): { header: string[]; rows: Record<string, string>[] } {
  const [header = [], ...values] = parseCsvText(text);
  const names = header.map((name) => name.trim());
  const rows = values.map((fields) => Object.fromEntries(
    names.map((name, index) => [name, fields[index] ?? '']),
  ));
  return { header: names, rows };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function choicesFor(schema: unknown, fieldId: string): Map<string, ConsultationLabel> {
  if (!isObject(schema) || !Array.isArray(schema.resources)) return new Map();
  for (const resource of schema.resources) {
    if (!isObject(resource) || resource.resource_name !== 'consultations' || !Array.isArray(resource.fields)) continue;
    for (const field of resource.fields) {
      if (!isObject(field) || field.id !== fieldId || !isObject(field.choices)) continue;
      const labels = new Map<string, ConsultationLabel>();
      for (const [code, choice] of Object.entries(field.choices)) {
        if (isObject(choice) && typeof choice.en === 'string' && typeof choice.fr === 'string') {
          labels.set(code, { en: choice.en, fr: choice.fr });
        }
      }
      return labels;
    }
  }
  return new Map();
}

export function readConsultationDictionary(schema: unknown): ConsultationDictionary {
  return {
    subjects: choicesFor(schema, 'subjects'),
    partnerDepartments: choicesFor(schema, 'partner_departments'),
    statusLabels: choicesFor(schema, 'status'),
  };
}

function normalizedHttpUrl(value: string): string | null {
  let candidate = value.trim();
  if (!/^[a-z][a-z\d+.-]*:/i.test(candidate)) {
    if (!/^[a-z\d.-]+(?::\d+)?(?:\/|$)/i.test(candidate)) return null;
    candidate = `https://${candidate}`;
  }
  try {
    const parsed = new URL(candidate);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function consultationLink(raw: string | undefined): ConsultationLink {
  const published = (raw ?? '').trim();
  if (!published || /^(?:n\/?a)$/i.test(published)) {
    return { published, url: null, kind: 'missing', unwrapped: null };
  }
  const normalized = normalizedHttpUrl(published);
  if (!normalized) return { published, url: null, kind: 'unparsable', unwrapped: null };

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return { published, url: null, kind: 'unparsable', unwrapped: null };
  }
  if (parsed.hostname.toLowerCase().endsWith('.safelinks.protection.outlook.com')) {
    const target = parsed.searchParams.get('url');
    const unwrapped = target ? normalizedHttpUrl(target) : null;
    return { published, url: unwrapped, kind: 'third-party-wrapper', unwrapped };
  }
  return { published, url: normalized, kind: 'official', unwrapped: null };
}

function rowDate(value: string | undefined): string | null {
  const date = (value ?? '').trim();
  return z.iso.date().safeParse(date).success ? date : null;
}

function codeList(value: string | undefined, labels: Map<string, ConsultationLabel>) {
  return (value ?? '').split(',').map((code) => code.trim()).filter(Boolean)
    .map((code) => ({ code, label: labels.get(code) ?? null }));
}

function statusLabel(code: string, dictionary: ConsultationDictionary): { label: ConsultationLabel; inferred: boolean } {
  const found = dictionary.statusLabels.get(code);
  if (found) return { label: found, inferred: false };
  if (code === 'C') return { label: { en: 'Closed', fr: 'Fermée' }, inferred: true };
  return { label: { en: code, fr: code }, inferred: true };
}

function splitInstitution(value: string): ConsultationLabel {
  const separator = value.indexOf(' | ');
  if (separator < 0) return { en: value.trim(), fr: value.trim() };
  return {
    en: value.slice(0, separator).trim(),
    fr: value.slice(separator + 3).trim(),
  };
}

export function stateAsOf(
  dates: { start: string | null; end: string | null },
  asOf: string,
): { state: ConsultationState; basis: 'dates' | 'missing-dates' } {
  if (!dates.start || !dates.end) return { state: 'unknown', basis: 'missing-dates' };
  const instant = Date.parse(asOf);
  const start = Date.parse(`${dates.start}T00:00:00.000Z`);
  const end = Date.parse(`${dates.end}T23:59:59.999Z`);
  if (instant < start) return { state: 'planned', basis: 'dates' };
  if (instant > end) return { state: 'closed', basis: 'dates' };
  return { state: 'open', basis: 'dates' };
}

export function statusAgrees(code: string, state: ConsultationState): boolean | null {
  const expected: Record<string, ConsultationState> = { O: 'open', P: 'planned', C: 'closed' };
  return Object.hasOwn(expected, code) ? expected[code] === state : null;
}

function reportOnline(value: string | undefined): boolean | null {
  const flag = (value ?? '').trim();
  if (flag === 'Y') return true;
  if (flag === 'N') return false;
  return null;
}

function reportLink(value: string | undefined): ConsultationLink | null {
  const published = (value ?? '').trim();
  return published ? consultationLink(published) : null;
}

function editionFor(
  language: ConsultationLanguage,
  title: string,
  description: string | null,
  profile: ConsultationLink,
  reportUrl: ConsultationLink | null,
): ConsultationEdition {
  return { language, title, description, profile, reportUrl };
}

function searchable(title: string, description: string | null): string {
  return normalizeForSearch(`${title} ${description ?? ''}`);
}

export function consultationFromRow(
  row: Record<string, string>,
  dictionary: ConsultationDictionary,
  observedAt: string,
): { facts: ConsultationFacts; searchText: { en: string; fr: string } } {
  const registrationNumber = row.registration_number?.trim() ?? '';
  const ownerOrg = row.owner_org?.trim() ?? '';
  const statusCode = row.status?.trim() ?? '';
  const englishTitle = row.title_en?.trim() ?? '';
  const frenchTitle = row.title_fr?.trim() ?? '';
  const englishDescription = row.description_en?.trim() || null;
  const frenchDescription = row.description_fr?.trim() || null;
  const dates = { start: rowDate(row.start_date), end: rowDate(row.end_date) };
  const atObservation = stateAsOf(dates, observedAt);
  const facts = ConsultationFactsSchema.parse({
    id: consultationId(ownerOrg, registrationNumber),
    source: CONSULTATION_SOURCE,
    registrationNumber,
    ownerOrg,
    institution: splitInstitution(row.owner_org_title ?? ''),
    statusCode,
    status: { code: statusCode, ...statusLabel(statusCode, dictionary) },
    editions: {
      en: editionFor('en', englishTitle, englishDescription,
        consultationLink(row.profile_page_en), reportLink(row.report_link_en)),
      fr: editionFor('fr', frenchTitle, frenchDescription,
        consultationLink(row.profile_page_fr), reportLink(row.report_link_fr)),
    },
    dates,
    stateAtObservation: atObservation.state,
    statusAgreesWithDates: statusAgrees(statusCode, atObservation.state),
    subjects: codeList(row.subjects, dictionary.subjects),
    partnerDepartments: codeList(row.partner_departments, dictionary.partnerDepartments),
    reportAvailableOnline: reportOnline(row.report_available_online),
  });
  return {
    facts,
    searchText: {
      en: searchable(englishTitle, englishDescription),
      fr: searchable(frenchTitle, frenchDescription),
    },
  };
}
