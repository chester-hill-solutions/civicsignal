import { z } from 'zod';

/** Official identity for a Gazette extra edition. Extra numbers are independent of regular issue numbers. */
export const GazetteExtraIssueSchema = z.strictObject({
  part: z.enum(['I', 'II']),
  language: z.enum(['en', 'fr']),
  issueDate: z.iso.date(),
  volume: z.number().int().positive(),
  extraNumber: z.number().int().positive(),
});

export const GazetteExtraRecordSchema = GazetteExtraIssueSchema.extend({
  editionType: z.literal('extra'),
  id: z.string().min(1).max(500),
  kind: z.enum(['notice', 'proposal', 'instrument']),
  title: z.string().trim().min(1).max(2000),
  citationUrl: z.url({ protocol: /^https$/ }),
  registrationNumber: z.string().trim().min(1).max(100).optional(),
  registrationDate: z.iso.date().optional(),
  consultationDeadline: z.iso.date().optional(),
  effectiveDate: z.iso.date().optional(),
});

export type GazetteExtraIssueKey = z.infer<typeof GazetteExtraIssueSchema>;
export type GazetteExtraRecord = z.infer<typeof GazetteExtraRecordSchema>;
export interface GazetteExtraEdition extends GazetteExtraIssueKey { records: GazetteExtraRecord[] }

export function gazetteExtraIssueId(key: GazetteExtraIssueKey): string {
  return `gazette:extra:p${key.part.toLowerCase()}:${key.language}:${key.issueDate}:v${key.volume}:x${key.extraNumber}`;
}

export function gazetteExtraRecordId(key: GazetteExtraIssueKey, sourceToken: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/iu.test(sourceToken)) throw new Error('Invalid Gazette extra source token.');
  return `${gazetteExtraIssueId(key)}:${sourceToken.toLowerCase()}`;
}

export function parseGazetteExtraRecordId(id: string): (GazetteExtraIssueKey & { sourceToken: string }) | undefined {
  const match = /^gazette:extra:p(i|ii):(en|fr):(\d{4}-\d{2}-\d{2}):v([1-9]\d*):x([1-9]\d*):([a-z0-9][a-z0-9-]*)$/iu.exec(id);
  if (!match) return undefined;
  const [, rawPart, rawLanguage, issueDate, rawVolume, rawExtraNumber, sourceToken] = match;
  if (!rawPart || !rawLanguage || !issueDate || !rawVolume || !rawExtraNumber || !sourceToken) return undefined;
  const key = { part: rawPart.toUpperCase() as 'I' | 'II', language: rawLanguage.toLowerCase() as 'en' | 'fr',
    issueDate, volume: Number(rawVolume), extraNumber: Number(rawExtraNumber) };
  const date = new Date(`${key.issueDate}T00:00:00Z`);
  return Number.isSafeInteger(key.volume) && Number.isSafeInteger(key.extraNumber) &&
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === key.issueDate
    ? { ...key, sourceToken: sourceToken.toLowerCase() } : undefined;
}

export function isGazetteExtraCitationForIssue(citation: string, key: GazetteExtraIssueKey): boolean {
  try {
    const url = new URL(citation);
    const partNumber = key.part === 'I' ? '1' : '2';
    const languageCode = key.language === 'en' ? 'eng' : 'fra';
    return url.origin === 'https://gazette.gc.ca' && !url.username && !url.password && !url.search &&
      url.pathname.startsWith(`/rp-pr/p${partNumber}/${key.issueDate.slice(0, 4)}/${key.issueDate}-x${key.extraNumber}/html/`) &&
      url.pathname.endsWith(`-${languageCode}.html`) && !!url.pathname.split('/').at(-1) &&
      !url.pathname.endsWith(`/index-${languageCode}.html`) && !url.hash;
  } catch { return false; }
}

export function gazetteExtraRecordBelongsToIssue(record: Pick<GazetteExtraRecord, 'id' | 'citationUrl'>,
  key: GazetteExtraIssueKey): boolean {
  const parsed = parseGazetteExtraRecordId(record.id);
  return !!parsed && gazetteExtraIssueId(parsed) === gazetteExtraIssueId(key) && isGazetteExtraCitationForIssue(record.citationUrl, key);
}
