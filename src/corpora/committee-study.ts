import { z } from 'zod';

export const CommitteeStudyLanguageSchema = z.enum(['en', 'fr']);
export type CommitteeStudyLanguage = z.infer<typeof CommitteeStudyLanguageSchema>;

const text = z.string().trim().min(1);
const bilingualText = z.strictObject({ en: text, fr: text });
const officialUrl = z.url({ protocol: /^https$/, hostname: /^(?:www\.)?(?:ourcommons\.ca|noscommunes\.ca|canada\.ca)$/i });
const bilingualUrl = z.strictObject({ en: officialUrl, fr: officialUrl });
export const CommitteeStudyEventTypeSchema = z.enum(['meeting', 'report', 'presentation', 'deadline', 'government-response']);

export const CommitteeStudyPacketSchema = z.strictObject({
  presentationDate: z.iso.date(),
  coverageThrough: z.iso.date(),
  publisher: bilingualText,
  study: z.strictObject({ title: bilingualText, url: bilingualUrl }),
  events: z.array(z.strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9:._-]*$/i),
    date: z.iso.date(),
    type: CommitteeStudyEventTypeSchema,
    label: bilingualText,
    citations: z.array(z.strictObject({ label: bilingualText, url: bilingualUrl })).min(1),
  })).nonempty(),
  responseCitations: z.array(z.strictObject({ date: z.iso.date(), label: bilingualText, url: bilingualUrl })).min(2),
}).superRefine((packet, ctx) => {
  const presentations = packet.events.filter((event) => event.type === 'presentation');
  if (presentations.length !== 1 || presentations[0]?.date !== packet.presentationDate) {
    ctx.addIssue({ code: 'custom', path: ['presentationDate'], message: 'Must match the sole presentation event date.' });
  }
});
export type CommitteeStudyPacket = z.infer<typeof CommitteeStudyPacketSchema>;

export const CommitteeStudyBriefSchema = z.strictObject({
  study: z.strictObject({ parliament: z.literal(45), session: z.literal(1), committee: z.literal('ENVI'), studyActivityId: z.literal(13298665), title: text, url: officialUrl }),
  language: CommitteeStudyLanguageSchema,
  asOf: z.iso.date().describe('The effective historical date used to select visible records and status.'),
  coverageThrough: z.iso.date(),
  publisher: text,
  events: z.array(z.strictObject({
    id: z.string(), date: z.iso.date(), type: CommitteeStudyEventTypeSchema,
    label: text, citations: z.array(z.strictObject({ label: text, url: officialUrl })).min(1),
  })),
  response: z.strictObject({
    status: z.enum(['no-request-in-record', 'awaiting-presentation', 'pending', 'fulfilled', 'overdue']),
    requestDate: z.iso.date().nullable(), presentationDate: z.iso.date().nullable(), deadline: z.iso.date().nullable(), responseDate: z.iso.date().nullable(),
    citations: z.array(z.strictObject({ label: text, url: officialUrl })),
  }),
});
export type CommitteeStudyBrief = z.infer<typeof CommitteeStudyBriefSchema>;
