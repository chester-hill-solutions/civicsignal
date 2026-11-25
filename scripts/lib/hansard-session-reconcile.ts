import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { HansardChamber } from '../../src/corpora/hansard';
import type { HansardSittingRef } from './hansard-week';

interface EditionRow { sittingId: string; edition: 'en' | 'fr'; sittingDate: string; sha256?: string }
interface ArchiveSitting extends HansardSittingRef { en: string | null; fr: string | null }
interface ArchiveSource { sittingId: string; sittingDate: string; language: 'en' | 'fr'; sourceSha256: string }

export interface SessionReconciliation {
  complete: boolean;
  counts: {
    expectedSittings: number; expectedEditions: number; localEditions: number; feedEditions: number;
    archiveVerifiedWeeks: number; missingWeeks: number; conflicts: number;
  };
  expected: HansardSittingRef[];
  weeks: Array<{ weekOf: string; sittingCount: number; archiveVerified: boolean; dataComplete: boolean; issues: string[] }>;
  missingWeeks: Array<{ weekOf: string; sittingCount: number; reasons: string[] }>;
  conflicts: string[];
}

export interface HansardCoverageOptions { archiveRoot: string; cutoff: string }

export function analyzeHansardSessionCoverage(sqlite: DatabaseSync, chamber: HansardChamber, session: string,
  sittings: HansardSittingRef[], options: HansardCoverageOptions): SessionReconciliation {
  const { archiveRoot, cutoff } = options;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(cutoff)) throw new Error('Invalid Hansard reconciliation cutoff.');
  const expectedById = new Map<string, HansardSittingRef>();
  const conflicts: string[] = [];
  for (const sitting of sittings) {
    if (!sitting.sittingId.startsWith(`${session}-`) || expectedById.has(sitting.sittingId)) {
      conflicts.push(`Publisher calendar has an invalid or duplicate sitting identity: ${sitting.sittingId}.`);
      continue;
    }
    expectedById.set(sitting.sittingId, sitting);
  }
  const prefix = chamber === 'senate' ? 'senate:' : '';
  const localRowsRaw = sqlite.prepare(`SELECT sitting_id AS sittingId, edition, sitting_date AS sittingDate, xml_sha256 AS sha256
    FROM local_hansard_editions WHERE sitting_id GLOB ? ORDER BY sitting_date, sitting_id, edition`)
    .all(`${prefix}${session}-*`) as unknown as EditionRow[];
  const localRows = localRowsRaw.filter((row) => row.sittingDate <= cutoff)
    .map((row) => ({ ...row, sittingId: row.sittingId.slice(prefix.length) }));
  const feedRows = sqlite.prepare(`SELECT edition_id AS sittingId, language AS edition, publication_date AS sittingDate
    FROM source_feed_editions WHERE source = ? AND edition_id GLOB ? ORDER BY publication_date, edition_id, language`)
    .all(chamber, `${session}-*`) as unknown as EditionRow[];
  const feedRowsThroughCutoff = feedRows.filter((row) => row.sittingDate <= cutoff);
  const local = indexRows(localRows, expectedById, `${chamber} local edition`, conflicts);
  const feed = indexRows(feedRowsThroughCutoff, expectedById, `${chamber} source-feed edition`, conflicts);
  const byWeek = groupByWeek([...expectedById.values()]);
  const weeks = [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([weekOf, expected]) => {
    const issues: string[] = [];
    const localComplete = hasBothEditions(expected, local, issues, 'local store');
    const feedComplete = hasBothEditions(expected, feed, issues, 'source feed');
    const archive = inspectWeekArchive(archiveRoot, weekOf, expected, local, chamber);
    issues.push(...archive.issues);
    const dataComplete = localComplete && feedComplete;
    return { weekOf, sittingCount: expected.length, archiveVerified: archive.verified,
      dataComplete, issues: [...new Set(issues)] };
  });
  const missingWeeks = weeks.filter((week) => !week.archiveVerified || !week.dataComplete)
    .map((week) => ({ weekOf: week.weekOf, sittingCount: week.sittingCount,
      reasons: week.issues.length ? week.issues : ['publisher-sitting-not-complete-in-local-store'] }));
  const localEditions = [...local.values()].reduce((sum, rows) => sum + rows.size, 0);
  const feedEditions = [...feed.values()].reduce((sum, rows) => sum + rows.size, 0);
  return { complete: conflicts.length === 0 && missingWeeks.length === 0,
    counts: { expectedSittings: expectedById.size, expectedEditions: expectedById.size * 2, localEditions, feedEditions,
      archiveVerifiedWeeks: weeks.filter((week) => week.archiveVerified).length, missingWeeks: missingWeeks.length, conflicts: conflicts.length },
    expected: [...expectedById.values()].sort((a, b) => a.sittingDate.localeCompare(b.sittingDate)),
    weeks, missingWeeks, conflicts };
}

function indexRows(rows: EditionRow[], expected: Map<string, HansardSittingRef>, label: string,
  conflicts: string[]): Map<string, Map<'en' | 'fr', EditionRow>> {
  const output = new Map<string, Map<'en' | 'fr', EditionRow>>();
  for (const row of rows) {
    const sitting = expected.get(row.sittingId);
    if (!sitting) {
      conflicts.push(`${label} exists outside the current publisher calendar: ${row.sittingId} ${row.edition}.`);
      continue;
    }
    if (row.sittingDate !== sitting.sittingDate) {
      conflicts.push(`${label} date conflicts with the current calendar: ${row.sittingId} ${row.edition}.`);
      continue;
    }
    if (row.edition !== 'en' && row.edition !== 'fr') {
      conflicts.push(`${label} has an invalid language: ${row.sittingId}.`);
      continue;
    }
    const editions = output.get(row.sittingId) ?? new Map<'en' | 'fr', EditionRow>();
    if (editions.has(row.edition)) conflicts.push(`${label} has a duplicate row: ${row.sittingId} ${row.edition}.`);
    editions.set(row.edition, row);
    output.set(row.sittingId, editions);
  }
  return output;
}

function groupByWeek(sittings: HansardSittingRef[]): Map<string, HansardSittingRef[]> {
  const groups = new Map<string, HansardSittingRef[]>();
  for (const sitting of sittings) {
    const date = new Date(`${sitting.sittingDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    const weekOf = date.toISOString().slice(0, 10);
    const group = groups.get(weekOf) ?? [];
    group.push(sitting);
    groups.set(weekOf, group);
  }
  return groups;
}

function hasBothEditions(sittings: HansardSittingRef[], index: Map<string, Map<'en' | 'fr', EditionRow>>,
  issues: string[], source: string): boolean {
  let complete = true;
  for (const sitting of sittings) {
    for (const edition of ['en', 'fr'] as const) {
      if (!index.get(sitting.sittingId)?.has(edition)) {
        issues.push(`${source} is missing ${sitting.sittingId} ${edition}.`);
        complete = false;
      }
    }
  }
  return complete;
}

function inspectWeekArchive(root: string, weekOf: string, expected: HansardSittingRef[],
  local: Map<string, Map<'en' | 'fr', EditionRow>>, chamber: HansardChamber): { verified: boolean; issues: string[] } {
  const weekRoot = resolve(root, weekOf, 'current');
  const manifestPath = join(weekRoot, 'week.json');
  const receiptPath = join(weekRoot, 'receipt.json');
  if (!existsSync(manifestPath) || !existsSync(receiptPath)) return { verified: false, issues: ['weekly-archive-or-receipt-missing'] };
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { weekOf?: string; sittings?: ArchiveSitting[] };
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { chamber?: HansardChamber; session?: string; weekOf?: string; lookupSamples?: ArchiveSource[] };
    if (manifest.weekOf !== weekOf || receipt.weekOf !== weekOf || receipt.chamber !== chamber || !Array.isArray(manifest.sittings)) {
      return { verified: false, issues: ['weekly-archive-metadata-mismatch'] };
    }
    const issues = compareArchiveSittingIdentities(expected, manifest.sittings);
    issues.push(...verifyArchivedEditions(weekRoot, manifest.sittings, receipt.lookupSamples ?? [], local, chamber));
    return { verified: issues.length === 0, issues };
  } catch (error) {
    return { verified: false, issues: [`weekly-archive-read-failed:${error instanceof Error ? error.message : String(error)}`] };
  }
}

function compareArchiveSittingIdentities(expected: HansardSittingRef[], archived: ArchiveSitting[]): string[] {
  const expectedIds = new Set(expected.map((sitting) => `${sitting.sittingId}:${sitting.sittingDate}`));
  const archivedOccurrences = new Map<string, number>();
  for (const sitting of archived) {
    const identity = `${sitting.sittingId}:${sitting.sittingDate}`;
    archivedOccurrences.set(identity, (archivedOccurrences.get(identity) ?? 0) + 1);
  }
  const archivedIds = new Set(archivedOccurrences.keys());
  const issues = [...expectedIds].filter((item) => !archivedIds.has(item)).map((item) => `weekly-archive-missing-sitting:${item}`);
  issues.push(...[...archivedIds].filter((item) => !expectedIds.has(item)).map((item) => `weekly-archive-extra-sitting:${item}`));
  issues.push(...[...archivedOccurrences].filter(([, count]) => count > 1).map(([item]) => `weekly-archive-duplicate-sitting:${item}`));
  return issues;
}

function verifyArchivedEditions(root: string, sittings: ArchiveSitting[], samples: ArchiveSource[],
  local: Map<string, Map<'en' | 'fr', EditionRow>>, chamber: HansardChamber): string[] {
  const sampleByEdition = new Map(samples.map((sample) => [`${sample.sittingId}:${sample.language}`, sample]));
  const issues: string[] = [];
  for (const sitting of sittings) for (const edition of ['en', 'fr'] as const) {
    const issue = verifyOneArchivedEdition(root, sitting, edition, { local, samples: sampleByEdition, chamber });
    if (issue) issues.push(issue);
  }
  return issues;
}

function verifyOneArchivedEdition(root: string, sitting: ArchiveSitting, edition: 'en' | 'fr',
  context: { local: Map<string, Map<'en' | 'fr', EditionRow>>; samples: Map<string, ArchiveSource>; chamber: HansardChamber }): string | undefined {
  const { local, samples, chamber } = context;
  const file = sitting[edition];
  const row = local.get(sitting.sittingId)?.get(edition);
  if (!file || !row?.sha256) return `weekly-archive-edition-missing:${sitting.sittingId}:${edition}`;
  const absoluteFile = resolve(root, file);
  if (!absoluteFile.startsWith(`${root}/`) || !existsSync(absoluteFile)) return `weekly-archive-original-missing:${sitting.sittingId}:${edition}`;
  const digest = createHash('sha256').update(readFileSync(absoluteFile)).digest('hex');
  const sample = samples.get(`${sitting.sittingId}:${edition}`);
  const extension = chamber === 'house' ? '.xml' : '.html';
  return digest !== row.sha256 || file !== `${digest}${extension}` || sample?.sourceSha256 !== digest
    ? `weekly-archive-hash-mismatch:${sitting.sittingId}:${edition}` : undefined;
}
