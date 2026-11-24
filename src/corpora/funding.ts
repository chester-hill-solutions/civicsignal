import { z } from 'zod';

export const FundingSource = z.enum(['nserc', 'esdc']);
export const FundingLanguage = z.enum(['en', 'fr']);
export const FundingStatus = z.enum(['open', 'closed', 'upcoming', 'ongoing', 'invitation-only', 'unknown']);
export const FundingAvailability = z.enum(['published', 'metadata-only']);
export const FundingSectionField = z.enum(['overview', 'eligibility', 'partners', 'amount', 'deadline', 'status', 'other']);
const httpsUrl = z.url({ protocol: /^https$/ });

export const FundingSection = z.strictObject({
  field: FundingSectionField,
  heading: z.string().min(1),
  text: z.string().min(1).describe('Publisher text. Retain cited terms even when the publisher does not publish their exact definitions.'),
  url: httpsUrl.describe('Citation for this section.'),
});

export const FundingEdition = z.strictObject({
  id: z.string().regex(/^(nserc|esdc)-[a-z0-9]+(?:-[a-z0-9]+)*$/),
  revision: z.string().min(1).optional(),
  language: FundingLanguage,
  title: z.string().trim().min(1),
  url: httpsUrl,
  status: FundingStatus,
  statusText: z.string().nullable(),
  sections: FundingSection.array(),
  availability: FundingAvailability,
});

export const FundingGap = z.strictObject({ language: FundingLanguage, id: z.string().nullable(), url: httpsUrl, reason: z.string().min(1) });
export const FundingInventory = z.strictObject({
  source: FundingSource,
  observedAt: z.iso.datetime({ offset: true }),
  indexes: z.strictObject({ en: httpsUrl, fr: httpsUrl }),
  sources: z.strictObject({ url: httpsUrl, resolvedUrl: httpsUrl, sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(), etag: z.string().nullable(), lastModified: z.string().nullable() }).array().optional(),
  records: FundingEdition.omit({ revision: true }).array(),
  gaps: FundingGap.array(),
}).superRefine((inventory, ctx) => {
  for (const [index, record] of inventory.records.entries()) {
    if (!record.id.startsWith(inventory.source + '-')) ctx.addIssue({ code: 'custom', path: ['records', index, 'id'], message: 'Record id must use its inventory source prefix.' });
  }
});

export const FundingCatalogueCoverage = z.strictObject({
  source: FundingSource,
  observedAt: z.iso.datetime({ offset: true }),
  revision: z.string().min(1),
  indexes: z.strictObject({ en: httpsUrl, fr: httpsUrl }),
  gaps: FundingGap.array(),
  records: z.number().int().nonnegative(),
  recordsPerLanguage: z.strictObject({
    en: z.strictObject({ total: z.number().int().nonnegative(), searchable: z.number().int().nonnegative(), metadataOnly: z.number().int().nonnegative() }),
    fr: z.strictObject({ total: z.number().int().nonnegative(), searchable: z.number().int().nonnegative(), metadataOnly: z.number().int().nonnegative() }),
  }),
});

export const FundingMatch = z.strictObject({
  section: FundingSectionField,
  heading: z.string(),
  snippet: z.string(),
  url: httpsUrl,
});
export const FundingSearchHit = z.strictObject({
  id: FundingEdition.shape.id, revision: z.string().min(1), language: FundingLanguage,
  title: FundingEdition.shape.title, url: FundingEdition.shape.url, status: FundingStatus,
  statusText: z.string().nullable(), availability: FundingAvailability, match: FundingMatch,
});
export const FundingSearchResponse = z.strictObject({
  source: FundingSource,
  revision: z.string().min(1),
  items: FundingSearchHit.array(),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export const FundingLookupResponse = z.strictObject({
  source: FundingSource,
  revision: z.string().min(1),
  item: FundingEdition.nullable(),
});
export const FundingVersion = z.strictObject({
  observedAt: z.iso.datetime({ offset: true }),
  revision: z.string().min(1),
  event: z.enum(['added', 'changed', 'removed']),
  edition: FundingEdition,
});
export const FundingVersionsResponse = z.strictObject({
  source: FundingSource,
  id: FundingEdition.shape.id,
  language: FundingLanguage,
  revision: z.string().min(1),
  items: FundingVersion.array(),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export type FundingEdition = z.infer<typeof FundingEdition>;
export type FundingSource = z.infer<typeof FundingSource>;
export type FundingInventory = z.infer<typeof FundingInventory>;
