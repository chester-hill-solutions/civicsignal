import { z } from 'zod';
import { OpportunityBasis, OpportunityDeadlineSchema, OpportunityOpenState } from './opportunity';

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

const httpsUrl = z.url({ protocol: /^https$/ });

/** One committee study that the publisher currently lists as seeking briefs. */
export const CommitteeCallSchema = z.strictObject({
  id: z.string().min(1),
  language: CommitteeLanguageSchema,
  title: z.string().min(1).describe("The publisher's study title in this edition."),
  url: httpsUrl.describe('The study page. Follow it for the order of reference and published briefs.'),
  status: OpportunityOpenState,
  statusBasis: OpportunityBasis,
  deadline: OpportunityDeadlineSchema.nullable(),
  instructions: z.string().max(400).nullable().describe('A short excerpt of the published submission instructions.'),
  instructionsTruncated: z.boolean(),
  instructionUrl: httpsUrl.nullable().describe('The publisher page that accepts a brief.'),
  committee: z.strictObject({ id: z.string(), name: z.string().nullable() }),
  study: z.strictObject({ id: z.string(), title: z.string(), url: httpsUrl }).nullable(),
  listingUrl: httpsUrl.describe('The publisher page that lists this call as current.'),
  contentWarning: z.boolean(),
  contentWarningText: z.string().nullable().describe("The publisher's warning text, when it publishes one."),
  observedAt: z.iso.datetime({ offset: true }),
  firstObservedAt: z.iso.datetime({ offset: true }),
});

export const CommitteeCallsResponseSchema = z.strictObject({
  session: z.string(),
  asOf: z.iso.datetime({ offset: true }).describe('The instant the open state was computed for.'),
  items: z.array(CommitteeCallSchema),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
  hasMore: z.boolean(),
  coverageBasis: z.literal('materialized-records'),
});

export const CommitteeCallDetailResponseSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('found'),
    asOf: z.iso.datetime({ offset: true }),
    item: CommitteeCallSchema,
    related: z.strictObject({
      submissions: z.number().int().nonnegative().describe('Published briefs attached to the linked study.'),
      evidence: z.number().int().nonnegative(),
      meetings: z.number().int().nonnegative(),
    }),
  }),
  z.strictObject({
    state: z.literal('not-found'),
    session: z.string(),
    id: z.string(),
    language: CommitteeLanguageSchema,
  }),
]);

export type CommitteeCall = z.infer<typeof CommitteeCallSchema>;

export type CommitteeLanguage = z.infer<typeof CommitteeLanguageSchema>;
