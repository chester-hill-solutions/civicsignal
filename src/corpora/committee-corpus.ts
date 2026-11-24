import { z } from 'zod';

export const CommitteeLanguageSchema = z.enum(['en', 'fr']);

export const CommitteeKindSchema = z
  .enum([
    'committee', 'study', 'meeting', 'notice', 'minutes', 'evidence', 'report',
    'government-response', 'submission', 'brief', 'exhibit', 'correspondence', 'attachment',
  ])
  .or(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/));

export const CommitteeStatusSchema = z
  .enum(['indexed', 'searchable', 'stored', 'unavailable', 'removed', 'superseded', 'pending'])
  .or(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/));

export const CommitteeRecordSchema = z.strictObject({
  session: z.string().regex(/^\d{1,2}-\d{1,2}$/),
  id: z.string().min(1),
  language: CommitteeLanguageSchema,
  kind: CommitteeKindSchema,
  chamber: z.string().nullable(),
  committeeId: z.string().nullable(),
  title: z.string(),
  url: z.url({ protocol: /^https$/ }),
  status: CommitteeStatusSchema,
  metadata: z.record(z.string(), z.unknown()),
  objectSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});

export const CommitteeCitationSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  url: z.url({ protocol: /^https$/ }),
  language: CommitteeLanguageSchema,
  kind: CommitteeKindSchema,
});

const CommitteeRelationSchema = z.strictObject({
  id: z.string(),
  kind: CommitteeKindSchema,
  relation: z.string(),
  direction: z.enum(['parent', 'child']),
});
const CommitteeCreditSchema = z.strictObject({
  organization: z.string().optional(),
  submitter: z.string().optional(),
});

export const CommitteeCorpusSearchItemSchema = z.strictObject({
  citation: CommitteeCitationSchema,
  position: z.number().int().nonnegative(),
  location: z.string().nullable(),
  text: z.string().max(400).nullable(),
  speaker: z.string().nullable(),
  affiliation: z.string().nullable(),
  authors: z.array(z.string()),
  credits: z.array(CommitteeCreditSchema),
  parents: z.array(CommitteeRelationSchema),
});

export const CommitteeCorpusSearchResponseSchema = z.strictObject({
  items: z.array(CommitteeCorpusSearchItemSchema).max(100),
  language: CommitteeLanguageSchema,
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
  hasMore: z.boolean(),
  coverageBasis: z.literal('materialized-records'),
});

export const CommitteeCorpusPageSchema = z.strictObject({
  items: z.array(CommitteeRecordSchema).max(100),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
  hasMore: z.boolean(),
});

export const CommitteePassageSchema = z.strictObject({
  position: z.number().int().nonnegative(),
  location: z.string().nullable(),
  text: z.string().max(400).nullable(),
  speaker: z.string().nullable(),
  affiliation: z.string().nullable(),
  citation: CommitteeCitationSchema,
});

export const CommitteeDetailResponseSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('not-found'),
    session: z.string(),
    id: z.string(),
    language: CommitteeLanguageSchema.optional(),
  }),
  z.strictObject({
    state: z.literal('found'),
    record: CommitteeRecordSchema,
    links: z.array(CommitteeRelationSchema).max(100),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(100),
    hasMore: z.boolean(),
  }),
]);

export const CommitteePassagesResponseSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('not-found'), session: z.string(), id: z.string(), language: CommitteeLanguageSchema }),
  z.strictObject({
    state: z.literal('found'),
    record: CommitteeRecordSchema,
    items: z.array(CommitteePassageSchema).max(100),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(100),
    hasMore: z.boolean(),
  }),
]);

export const CommitteeCorpusCoverageSchema = z.strictObject({
  session: z.string(),
  cutoff: z.string().nullable(),
  counts: z.array(z.strictObject({
    committeeId: z.string().nullable(),
    chamber: z.string().nullable(),
    language: CommitteeLanguageSchema,
    kind: CommitteeKindSchema,
    status: CommitteeStatusSchema,
    count: z.number().int().nonnegative(),
    directoryCutoffs: z.record(z.string(), z.string().nullable()),
  })),
  outstanding: z.object({
    ids: z.array(z.strictObject({
      id: z.string(),
      committeeId: z.string().nullable(),
      chamber: z.string().nullable(),
      language: CommitteeLanguageSchema,
      kind: CommitteeKindSchema,
      status: CommitteeStatusSchema,
      directoryCutoffs: z.record(z.string(), z.string().nullable()),
    })),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(100),
    total: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  }),
  basis: z.literal('materialized-records'),
});

export type CommitteeLanguage = z.infer<typeof CommitteeLanguageSchema>;
