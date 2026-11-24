import { z } from 'zod';

/** Identity of one language edition of a Canada Gazette issue. */
export const GazetteIssueSchema = z.strictObject({
  part: z.enum(['I', 'II']),
  language: z.enum(['en', 'fr']),
  issueDate: z.iso.date(),
  volume: z.number().int().positive(),
  issueNumber: z.number().int().positive(),
});

/** Metadata retained from an issue index, shared by import and retrieval. */
export const GazetteMetadataSchema = GazetteIssueSchema.extend({
  id: z.string().min(1).max(500),
  kind: z.enum(['notice', 'proposal', 'instrument']),
  title: z.string().trim().min(1).max(2000),
  citationUrl: z.url({ protocol: /^https$/ }),
  registrationNumber: z.string().trim().min(1).max(100).optional(),
  registrationDate: z.iso.date().optional(),
  consultationDeadline: z.iso.date().optional(),
  effectiveDate: z.iso.date().optional(),
});

export type GazetteIssueKey = z.infer<typeof GazetteIssueSchema>;
export type GazettePart = GazetteIssueKey['part'];
export type GazetteLanguage = GazetteIssueKey['language'];
export type GazetteRecord = z.infer<typeof GazetteMetadataSchema>;
export type GazetteRecordKind = GazetteRecord['kind'];

export interface GazetteEdition extends GazetteIssueKey {
  records: GazetteRecord[];
}

export const GAZETTE_PREVIEW_ISSUES = [
  { part: 'I', language: 'en', issueDate: '2026-04-25', volume: 160, issueNumber: 17 },
  { part: 'I', language: 'fr', issueDate: '2026-04-25', volume: 160, issueNumber: 17 },
  { part: 'II', language: 'en', issueDate: '2026-04-22', volume: 160, issueNumber: 8 },
  { part: 'II', language: 'fr', issueDate: '2026-04-22', volume: 160, issueNumber: 8 },
] as const satisfies readonly GazetteIssueKey[];

export function isGazetteIssueSupported(key: GazetteIssueKey): boolean {
  return GAZETTE_PREVIEW_ISSUES.some((issue) => issue.part === key.part && issue.language === key.language
    && issue.issueDate === key.issueDate && issue.volume === key.volume && issue.issueNumber === key.issueNumber);
}

export function gazetteIssueId(key: GazetteIssueKey): string {
  return `gazette:p${key.part.toLowerCase()}:${key.language}:${key.issueDate}:v${key.volume}:n${key.issueNumber}`;
}

export function gazetteRecordId(key: GazetteIssueKey, sourceToken: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/iu.test(sourceToken)) throw new Error('Invalid Gazette source token.');
  return `${gazetteIssueId(key)}:${sourceToken.toLowerCase()}`;
}

export function parseGazetteRecordId(id: string): (GazetteIssueKey & { sourceToken: string }) | undefined {
  const match = /^gazette:p(i|ii):(en|fr):(\d{4}-\d{2}-\d{2}):v([1-9]\d*):n([1-9]\d*):([a-z0-9][a-z0-9-]*)$/iu.exec(id);
  if (!match) return undefined;
  const [, rawPart, rawLanguage, issueDate, rawVolume, rawIssueNumber, sourceToken] = match;
  if (!rawPart || !rawLanguage || !issueDate || !rawVolume || !rawIssueNumber || !sourceToken) return undefined;
  const parsed = {
    part: rawPart.toUpperCase() as GazettePart,
    language: rawLanguage.toLowerCase() as GazetteLanguage,
    issueDate, volume: Number(rawVolume), issueNumber: Number(rawIssueNumber), sourceToken: sourceToken.toLowerCase(),
  };
  const date = new Date(`${parsed.issueDate}T00:00:00Z`);
  return Number.isSafeInteger(parsed.volume) && Number.isSafeInteger(parsed.issueNumber)
    && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === parsed.issueDate ? parsed : undefined;
}

export function isGazetteRecordIdForIssue(id: string, key: GazetteIssueKey): boolean {
  const parsed = parseGazetteRecordId(id);
  return !!parsed && parsed.part === key.part && parsed.language === key.language && parsed.issueDate === key.issueDate
    && parsed.volume === key.volume && parsed.issueNumber === key.issueNumber;
}

/** Ensure a stored citation is an article link in the official matching issue and language. */
export function isGazetteCitationForIssue(citation: string, key: GazetteIssueKey): boolean {
  try {
    const url = new URL(citation);
    const partNumber = key.part === 'I' ? '1' : '2';
    const languageCode = key.language === 'en' ? 'eng' : 'fra';
    return url.origin === 'https://gazette.gc.ca' && !url.username && !url.password && !url.search
      && url.pathname.startsWith(`/rp-pr/p${partNumber}/${key.issueDate.slice(0, 4)}/${key.issueDate}/html/`)
      && url.pathname.endsWith(`-${languageCode}.html`)
      && !url.pathname.endsWith(`/index-${languageCode}.html`)
      && (!url.hash || /^#[a-z0-9_-]+$/iu.test(url.hash));
  } catch {
    return false;
  }
}

export function gazetteRecordBelongsToIssue(record: Pick<GazetteRecord, 'id' | 'citationUrl'>, key: GazetteIssueKey): boolean {
  return isGazetteRecordIdForIssue(record.id, key) && isGazetteCitationForIssue(record.citationUrl, key);
}
