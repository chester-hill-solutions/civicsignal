import { z } from 'zod';

export const ParliamentCollection = z.enum(['bills', 'house-votes', 'senate-votes', 'house-journals', 'senate-journals', 'house-roll-calls', 'senate-roll-calls']);
export type ParliamentCollection = z.infer<typeof ParliamentCollection>;
export const ParliamentSession = z.string().regex(/^[1-9]\d?-[1-9]\d?$/);
export const ParliamentLanguage = z.enum(['en', 'fr']);
const count = z.number().int().nonnegative().nullable();
const sourceUrl = z.url({ protocol: /^https$/ });
const natural = z.number().int().nonnegative();
const journalStatus = z.enum(['published', 'unavailable']);
export const ParliamentPassage = z.object({
  text: z.string().min(1), url: sourceUrl,
  links: z.object({ label: z.string().min(1), url: z.url({ protocol: /^https?$/ }) }).array(),
});
export const VotePosition = z.enum(['yea', 'nay', 'paired', 'abstention']);
export const ParliamentMember = z.object({
  name: z.string().min(1), position: VotePosition,
  paired: z.boolean().describe('House pairing flag, including a member who also cast a vote. Always false in Senate records.'),
  memberId: z.string().min(1).nullable(),
  affiliation: z.string().nullable(), constituency: z.string().nullable(),
  province: z.string().nullable(), url: sourceUrl.nullable(),
});
const journalRollCallOrigin = {
  journalIssue: z.string().regex(/^[1-9]\d*$/).optional().describe('Senate Journal issue for a roll call absent from the standing-vote index.'),
  journalVoteOrdinal: z.number().int().positive().optional().describe('One-based roll call in source order within the cited Journal issue.'),
};
export const detailsByCollection = {
  bills: z.object({ kind: z.literal('bill'), legisInfoId: z.number().int().positive(), status: z.string().min(1) }),
  'house-votes': z.object({ kind: z.literal('house-vote'), result: z.string().min(1), yeas: count, nays: count, paired: count }),
  'senate-votes': z.object({ kind: z.literal('senate-vote'), result: z.string().min(1), yeas: count, nays: count, abstentions: count }),
  'house-journals': z.object({ kind: z.literal('house-journal'), status: journalStatus, passageCount: natural }),
  'senate-journals': z.object({ kind: z.literal('senate-journal'), status: journalStatus, passageCount: natural }),
  'house-roll-calls': z.object({ kind: z.literal('house-roll-call'), memberCount: natural }),
  'senate-roll-calls': z.object({ kind: z.literal('senate-roll-call'), memberCount: natural, ...journalRollCallOrigin,
    tally: z.object({ yeas: natural, nays: natural, abstentions: natural }).optional()
      .describe('Tally from the named positions when this vote has no standing-vote index entry.') }),
} as const;
const CatalogueDetails = z.discriminatedUnion('kind', [
  detailsByCollection.bills, detailsByCollection['house-votes'], detailsByCollection['senate-votes'],
  detailsByCollection['house-journals'], detailsByCollection['senate-journals'],
  detailsByCollection['house-roll-calls'], detailsByCollection['senate-roll-calls'],
]);
export const ParliamentEdition = z.object({
  key: z.string().min(1),
  details: CatalogueDetails,
  language: ParliamentLanguage,
  title: z.string().trim().min(1),
  summary: z.string(),
  date: z.iso.date().nullable(),
  url: z.url({ protocol: /^https$/ }),
});
const rawDetails = z.discriminatedUnion('kind', [
  detailsByCollection.bills, detailsByCollection['house-votes'], detailsByCollection['senate-votes'],
  z.object({ kind: z.literal('house-journal'), status: journalStatus, passages: ParliamentPassage.array() }),
  z.object({ kind: z.literal('senate-journal'), status: journalStatus, passages: ParliamentPassage.array() }),
  z.object({ kind: z.literal('house-roll-call'), members: ParliamentMember.array().min(1) }),
  z.object({ kind: z.literal('senate-roll-call'), members: ParliamentMember.array().min(1), ...journalRollCallOrigin }),
]);
export const ParliamentInventory = z.object({
  collection: ParliamentCollection, session: ParliamentSession,
  journalReconciliation: z.object({ observedAt: z.iso.datetime({ offset: true }), journalOnlyRecordsPerLanguage: natural }).optional(),
  observedAt: z.iso.datetime({ offset: true }), records: ParliamentEdition.extend({ details: rawDetails }).array().min(1),
});
export const ParliamentCoverage = z.object({
  session: ParliamentSession, collection: ParliamentCollection, observedAt: z.iso.datetime(),
  revision: z.string().regex(/^[a-f0-9]{64}$/), recordsPerLanguage: z.number().int().positive(),
  basis: z.literal('publisher-inventory'),
  latestRecordDate: z.iso.date().nullable().describe('Latest dated record in this inventory. Each source defines its record date.'),
  attribution: z.string(),
  journalOnlyRecordsPerLanguage: natural.optional().describe('Supplemental Senate roll calls sourced solely from Journals. Included in recordsPerLanguage.'),
  unavailableEditions: z.object({ en: natural, fr: natural }).optional()
    .describe('Indexed sitting editions whose Journal was unavailable at observation. Included in recordsPerLanguage.'),

});
export const ParliamentList = z.object({
  coverage: ParliamentCoverage, items: ParliamentEdition.array(), nextOffset: z.number().int().nonnegative().nullable(),
});
export const ParliamentLookup = z.object({ coverage: ParliamentCoverage, item: ParliamentEdition.nullable() });

export type ParliamentEdition = z.infer<typeof ParliamentEdition>;
export type ParliamentCoverage = z.infer<typeof ParliamentCoverage>;
export type ParliamentList = z.infer<typeof ParliamentList>;
export type ParliamentLookup = z.infer<typeof ParliamentLookup>;

export function keyPattern(collection: ParliamentCollection) {
  if (collection === 'senate-roll-calls') return /^(?:[1-9]\d*|j[1-9]\d*-[1-9]\d*)$/;
  if (collection === 'house-journals') return /^[1-9]\d*[A-Z]?$/;
  return collection === 'bills' ? /^[cs]-[1-9]\d*$/ : /^[1-9]\d*$/;
}

const parent = ParliamentEdition.pick({ key: true, language: true, title: true, date: true, url: true });
export const PassageHit = z.object({ edition: parent, ordinal: natural, passage: ParliamentPassage });
export const MemberHit = z.object({ edition: parent, ordinal: natural, member: ParliamentMember });
export const PassagePage = ParliamentList.extend({ items: PassageHit.array() });
export const MemberPage = ParliamentList.extend({ items: MemberHit.array() });

export function childResource(collection: ParliamentCollection) {
  if (collection.endsWith('-journals')) return 'passages';
  if (collection.endsWith('-roll-calls')) return 'members';
  return undefined;
}
