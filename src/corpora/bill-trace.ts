import { z } from 'zod';

export const PILOT_BILL = {
  parliament: 44, session: 1, number: 'S-5', legisinfoId: 11558854,
  title: { en: 'Strengthening Environmental Protection for a Healthier Canada Act',
    fr: 'Loi sur le renforcement de la protection de l’environnement pour un Canada en santé' },
  url: { en: 'https://www.parl.ca/legisinfo/en/bill/44-1/s-5', fr: 'https://www.parl.ca/legisinfo/fr/projet-de-loi/44-1/s-5' },
} as const;
export const BILL_KEY = '44-1/s-5';
export const BillSourceSchema = z.enum(['legisinfo', 'house', 'senate', 'vote', 'journals']);
export type BillSource = z.infer<typeof BillSourceSchema>;
export const BillLanguageSchema = z.enum(['en', 'fr']);
export type BillLanguage = z.infer<typeof BillLanguageSchema>;
const text = z.string().trim().min(1);
const officialUrl = z.url({ protocol: /^https$/, hostname: /^(?:www\.)?(?:parl\.ca|ourcommons\.ca|noscommunes\.ca|sencanada\.ca)$/i });
const id = z.string().regex(/^[a-z0-9][a-z0-9:._-]*$/i);
const link = z.strictObject({
  relation: z.enum(['precedes', 'documents', 'reported-in', 'part-of', 'reports-on', 'amends', 'studies', 'succeeds', 'referred-to', 'decided-by']),
  target: id,
});
const tally = z.strictObject({ yeas: z.number().int().nonnegative(), nays: z.number().int().nonnegative(),
  paired: z.number().int().nonnegative(), result: z.enum(['agreed', 'negatived']) });
const committee = z.strictObject({
  organizationId: z.number().int().positive(), acronym: text, name: z.strictObject({ en: text, fr: text }),
});
export const BillRecordSchema = z.strictObject({
  id, sourceId: text, kind: z.enum(['version', 'stage', 'study', 'meeting', 'evidence', 'minutes', 'report', 'amendment', 'vote', 'journal']),
  chamber: z.enum(['house', 'senate', 'parliament']), date: z.iso.date().optional(),
  sourceDateTime: z.iso.datetime({ local: true }).optional().describe('Parliamentary source date and time as published.'),
  stageId: text.optional().describe('LEGISinfo BillStageId for this stage event.'),
  label: z.strictObject({ en: text, fr: text }), url: z.strictObject({ en: officialUrl, fr: officialUrl }),
  links: z.array(link), committee: committee.optional(),
  amendment: z.strictObject({ clause: text, disposition: z.enum(['adopted', 'rejected', 'withdrawn']) }).optional(),
  witnesses: z.array(text).nonempty().optional(),
  tally: tally.optional(),
  division: tally.extend({ number: z.number().int().positive() }).optional(),
});
export type BillTraceRecord = z.infer<typeof BillRecordSchema>;

export const CommitteePacketSchema = z.strictObject({
  parliament: z.literal(PILOT_BILL.parliament), session: z.literal(PILOT_BILL.session),
  billNumber: z.literal(PILOT_BILL.number), legisinfoId: z.literal(PILOT_BILL.legisinfoId),
  source: z.enum(['house', 'senate']), records: z.array(BillRecordSchema).nonempty(),
});

export const BillBriefSchema = z.strictObject({
  bill: z.strictObject({ parliament: z.number().int(), session: z.number().int(), number: text,
    legisinfoId: z.number().int().positive(), title: text, url: officialUrl }),
  language: BillLanguageSchema, complete: z.boolean().describe('Every source in the selected replay was available.'),
  coverage: z.array(z.strictObject({ source: BillSourceSchema, status: z.enum(['available', 'missing']), count: z.number().int().nonnegative() })),
  records: z.array(BillRecordSchema.extend({ label: text, url: officialUrl, source: BillSourceSchema,
    committee: committee.extend({ name: text }).optional(), links: z.array(link.extend({ available: z.boolean() })) })),
  attribution: text,
});
export type BillBrief = z.infer<typeof BillBriefSchema>;
