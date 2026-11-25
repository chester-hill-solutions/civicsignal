import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { GAZETTE_PREVIEW_ISSUES, GazetteIssueSchema, gazetteIssueId, isGazetteIssueSupported, type GazetteEdition, type GazetteIssueKey } from '../src/corpora/gazette';
import { recallGazette } from './lib/gazette-recall';
import { fetchGazetteIssue, gazetteIssueUrl, parseGazetteIssue } from './lib/gazette-source';
import { discoverCurrentGazetteIssues, discoverGazetteYearThrough } from './lib/gazette-current';
import { gazetteEditionDigest, importGazetteEdition, importGazetteEditionBatch, importGazetteEditions, storedGazetteEditionDigest, validateGazetteEdition } from './lib/gazette-store';

const USAGE = `Usage:
  bun scripts/gazette-local.ts replay <sqlite-file> <week.json>
  bun scripts/gazette-local.ts import <sqlite-file> <edition.json>
  bun scripts/gazette-local.ts sync <sqlite-file>
  bun scripts/gazette-local.ts sync-current <sqlite-file> [YYYY-MM-DD]
  bun scripts/gazette-local.ts sync-year <sqlite-file> <YYYY> <YYYY-MM-DD>
  bun scripts/gazette-local.ts sync-year-catchup <sqlite-file> <YYYY> <YYYY-MM-DD>
  bun scripts/gazette-local.ts search <sqlite-file> <en|fr> <I|II> "<topic>"
  bun scripts/gazette-local.ts show <sqlite-file> <record-id>
  bun scripts/gazette-local.ts verify-live`;

const manifest = z.strictObject({
  issues: GazetteIssueSchema.extend({ file: z.string().trim().min(1) }).array().length(GAZETTE_PREVIEW_ISSUES.length),
});

async function fetchVerifiedGazettePreview() {
  const editions: GazetteEdition[] = [];
  for (const expected of GAZETTE_PREVIEW_ISSUES) {
    editions.push(validateGazetteEdition(await fetchGazetteIssue(expected)));
  }
  return editions;
}

export async function syncCurrent(databaseFile: string, cutoff?: string, send: typeof fetch = fetch,
  receiptFile = process.env.CIVICSIGNAL_GAZETTE_RECEIPT ?? 'dist/gazette/receipt.json') {
  const keys = await discoverCurrentGazetteIssues(cutoff, send);
  const editions: GazetteEdition[] = [];
  for (const key of keys) editions.push(validateGazetteEdition(await fetchGazetteIssue(key, send, true)));
  const absoluteDatabase = resolve(databaseFile);
  const directory = dirname(absoluteDatabase);
  mkdirSync(directory, { recursive: true });
  const sqlite = openStore(absoluteDatabase);
  let results: ReturnType<typeof importGazetteEditions>;
  let recordCounts = new Map<string, number>();
  try {
    results = importGazetteEditions(sqlite, editions);
    recordCounts = new Map((sqlite.prepare(`SELECT part, language, issue_date, volume, issue_number, record_count
      FROM gazette_editions`).all() as Array<{ part: string; language: string; issue_date: string; volume: number;
        issue_number: number; record_count: number }>).map((row) =>
      [`${row.part}:${row.language}:${row.issue_date}:v${row.volume}:n${row.issue_number}`, row.record_count]));
  } finally { sqlite.close(); }
  const completedAt = new Date().toISOString();
  const receipt = {
    schemaVersion: 1,
    source: 'https://gazette.gc.ca',
    completedAt,
    cutoff: cutoff ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
    databasePath: absoluteDatabase,
    editions: results.map((item) => ({ ...item,
      recordCount: recordCounts.get(`${item.part}:${item.language}:${item.issueDate}:v${item.volume}:n${item.issueNumber}`) ?? null,
    })),
  };
  const absoluteReceipt = resolve(receiptFile);
  mkdirSync(dirname(absoluteReceipt), { recursive: true });
  const temporary = `${absoluteReceipt}.tmp-${process.pid}-${randomUUID()}`;
  let published = false;
  try {
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    renameSync(temporary, absoluteReceipt);
    published = true;
  } finally {
    if (!published) try { unlinkSync(temporary); } catch { /* no temporary remains */ }
  }
  return { complete: true as const, persisted: true as const, atomic: true as const,
    receiptPath: absoluteReceipt, receipt, editions: receipt.editions };
}

const HISTORICAL_CAPTURE_LIMIT = 192 * 1024 * 1024;
const HISTORICAL_RESERVE_BYTES = 64 * 1024 * 1024;
const HISTORICAL_FILE_LIMIT = 2 * 1024 * 1024;

function excludedExtraCounts(listings: Awaited<ReturnType<typeof discoverGazetteYearThrough>>['annualListings']) {
  const issueIds = new Set<string>();
  let listingRows = 0;
  for (const listing of listings) for (const row of listing.extraRows ?? []) {
    issueIds.add(`${listing.part}:${row.date}`);
    listingRows += 1;
  }
  return { excludedExtras: issueIds.size, excludedExtraListingRows: listingRows };
}
type SourceCaptureState = { bytes: number; sources: Map<string, Record<string, unknown>>; errors: Array<{ url: string; error: string }> };
type ArchivedPair = { completedAt: string; sources: Partial<Record<'en' | 'fr', Record<string, unknown>>> };
type CatchupContext = {
  root: string;
  sqlite: DatabaseSync;
  archiveIndex: Map<string, ArchivedPair>;
  send: typeof fetch;
  sources: Map<string, Record<string, unknown>>;
};

function createSourceCapture(send: typeof fetch, root: string, maximumBytes: number) {
  const state: SourceCaptureState = { bytes: 0, sources: new Map(), errors: [] };
  const fetcher: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    const url = input instanceof Request ? input.url : String(input);
    try { return await storeGazetteResponse(await send(input, init), url, root, maximumBytes, state); }
    catch (error) {
      return captureFailure(state, url, error instanceof Error ? error.message : String(error));
    }
  }, { preconnect: () => undefined });
  return { fetcher, state };
}

async function storeGazetteResponse(response: Response, url: string, root: string, maximumBytes: number,
  state: SourceCaptureState): Promise<Response> {
  if (!response.body) return response;
  const { bytes, error } = await readBoundedBody(response.body, maximumBytes - state.bytes);
  if (error) return captureFailure(state, url, error);
  state.bytes += bytes.byteLength;
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? null;
  if (!response.ok || contentType !== 'text/html' || !bytes.length) {
    if (response.ok) state.errors.push({ url, error: `Unexpected source media type or empty body (${contentType ?? 'missing content type'}).` });
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const stats = statfsSync(root);
  if (stats.bavail * stats.bsize - bytes.length < HISTORICAL_RESERVE_BYTES) return captureFailure(state, url, 'Insufficient free disk space to preserve the next Gazette source index.');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const file = `objects/${hash}.html`;
  const path = resolve(root, file);
  try { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== hash) throw new Error(`Existing Gazette object failed hash verification: ${file}`);
  }
  state.sources.set(url, { url, status: response.status, contentType, bytes: bytes.length, sha256: hash, file });
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function readBoundedBody(body: ReadableStream<Uint8Array>, remainingBudget: number): Promise<{ bytes: Uint8Array; error?: string }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let error: string | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > HISTORICAL_FILE_LIMIT || size > remainingBudget) {
        error = 'Gazette source capture exceeded its per-file or run byte budget.';
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }
  } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, ...(error ? { error } : {}) };
}

function captureFailure(state: SourceCaptureState, url: string, error: string): Response {
  state.errors.push({ url, error });
  return new Response(error, { status: 507, headers: { 'Content-Type': 'text/plain' } });
}

/** Captures one bounded year of official issue indexes, importing only verified bilingual pairs. */
export async function syncGazetteYearThrough(databaseFile: string, year: number, cutoff: string,
  send: typeof fetch = fetch, outputRoot = 'dist/gazette/backfills'): Promise<Record<string, unknown>> {
  if (!Number.isInteger(year) || !/^\d{4}-\d{2}-\d{2}$/u.test(cutoff) || cutoff.slice(0, 4) !== String(year) ||
      Number.isNaN(Date.parse(`${cutoff}T00:00:00Z`))) throw new Error('Invalid Gazette historical year and cutoff.');
  const runId = `${year}-through-${cutoff}-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`;
  const absoluteRoot = resolve(outputRoot);
  const receiptDirectory = resolve(absoluteRoot, 'receipts', `${year}-through-${cutoff}`);
  mkdirSync(resolve(absoluteRoot, 'objects'), { recursive: true });
  mkdirSync(receiptDirectory, { recursive: true });
  const { fetcher: captureSend, state: capture } = createSourceCapture(send, absoluteRoot, HISTORICAL_CAPTURE_LIMIT);

  const discovery = await discoverGazetteYearThrough(year, cutoff, captureSend);
  const editions: GazetteEdition[] = [];
  const issueResults: Array<Record<string, unknown>> = [];
  for (const issue of discovery.issues) {
    const result = await fetchHistoricalIssuePair(issue, captureSend, capture.sources, absoluteRoot);
    issueResults.push(result.result);
    editions.push(...result.editions);
  }
  const importResults: ReturnType<typeof importGazetteEditionBatch> = [];
  if (editions.length) {
    const absoluteDatabase = resolve(databaseFile);
    mkdirSync(dirname(absoluteDatabase), { recursive: true });
    const sqlite = openStore(absoluteDatabase);
    try { importResults.push(...importGazetteEditionBatch(sqlite, editions)); } finally { sqlite.close(); }
  }
  const unsupported = discovery.annualListings.flatMap((listing) => (listing.unsupportedRows ?? []).map((row) => ({
    part: listing.part, language: listing.language, date: row.date, text: row.text, reason: 'unrecognized-regular-row',
  })));
  const annualFailures = discovery.annualListings.filter((listing) => listing.error);
  const unavailable = issueResults.filter((item) => item.status === 'unavailable').length + unsupported.length + annualFailures.length;
  const complete = unavailable === 0 && capture.errors.length === 0 && discovery.annualListings.length === 4 &&
    discovery.annualListings.every((listing) => (listing.regularRows ?? 0) > 0) &&
    discovery.annualListings.every((listing) => listing.sha256 && listing.bytes !== undefined);
  const receipt = {
    schemaVersion: 1,
    runId,
    source: 'https://gazette.gc.ca',
    year,
    cutoff,
    completedAt: new Date().toISOString(),
    databasePath: resolve(databaseFile),
    archivePath: resolve(absoluteRoot, 'objects'),
    policy: { editions: 'officially listed regular issues only', languages: 'both English and French required before import',
      extras: 'excluded and counted separately', maxCapturedBytes: HISTORICAL_CAPTURE_LIMIT, maxBytesPerSource: HISTORICAL_FILE_LIMIT },
    annualListings: discovery.annualListings,
    excludedExtras: discovery.annualListings.map((listing) => ({ part: listing.part, language: listing.language,
      count: listing.extraRows?.length ?? 0, rows: listing.extraRows ?? [] })),
    unsupportedRegularRows: unsupported,
    issues: issueResults,
    sources: [...capture.sources.values()],
    captureErrors: capture.errors,
    import: { editions: importResults, imported: importResults.filter((item) => item.status === 'imported').length,
      unchanged: importResults.filter((item) => item.status === 'unchanged').length,
      recordCount: editions.reduce((sum, edition) => sum + edition.records.length, 0) },
    counts: { discoveredIssues: discovery.issues.length, verifiedIssues: issueResults.filter((item) => item.status === 'verified').length,
      unavailableIssues: issueResults.filter((item) => item.status === 'unavailable').length,
      ...excludedExtraCounts(discovery.annualListings),
      unsupportedRegularRows: unsupported.length, archivedSourceBytes: capture.bytes },
    complete,
  };
  const receiptFile = resolve(receiptDirectory, `${runId}.json`);
  writeAtomicJson(receiptFile, receipt);
  const latestFile = resolve(receiptDirectory, 'latest.json');
  writeAtomicJson(latestFile, { receipt: receiptFile, runId, completedAt: receipt.completedAt, complete });
  return { ...receipt, receiptPath: receiptFile, latestReceiptPath: latestFile };
}

async function fetchHistoricalIssuePair(issue: Awaited<ReturnType<typeof discoverGazetteYearThrough>>['issues'][number],
  send: typeof fetch, sources: Map<string, Record<string, unknown>>, archiveRoot: string): Promise<{ editions: GazetteEdition[]; result: Record<string, unknown> }> {
  const base = { part: issue.part, issueDate: issue.issueDate, volume: issue.volume, issueNumber: issue.issueNumber };
  const { en, fr } = issue.languages;
  if (!en || !fr || issue.identityMismatch) {
    const causes = [!en ? 'English annual listing has no matching issue.' : '', !fr ? 'French annual listing has no matching issue.' : '',
      issue.identityMismatch ? 'English and French annual listings disagree on volume or issue number.' : ''].filter(Boolean);
    return { editions: [], result: { ...base, status: 'unavailable', causes } };
  }
  const parsed: Partial<Record<'en' | 'fr', GazetteEdition>> = {};
  const languages: Array<Record<string, unknown>> = [];
  for (const key of [en, fr]) languages.push(await fetchHistoricalLanguage(key, send, sources, parsed, archiveRoot));
  if (!parsed.en || !parsed.fr) return { editions: [], result: { ...base, status: 'unavailable', languages } };
  return { editions: [parsed.en, parsed.fr], result: { ...base, status: 'verified', languages } };
}

async function fetchHistoricalLanguage(key: GazetteIssueKey, send: typeof fetch, sources: Map<string, Record<string, unknown>>,
  parsed: Partial<Record<'en' | 'fr', GazetteEdition>>, archiveRoot: string): Promise<Record<string, unknown>> {
  const url = gazetteIssueUrl(key, true).href;
  try {
    const edition = validateGazetteEdition(await fetchGazetteIssue(key, send, true));
    const source = sources.get(url);
    if (!source) throw new Error('Issue parsed without a retained source hash and original bytes.');
    parsed[key.language] = edition;
    const recoveredArticles = key.part === 'II' && key.language === 'en' && key.issueDate === '2026-06-03'
      ? edition.records.map((record) => {
        const articleSource = sources.get(record.citationUrl);
        if (!articleSource) throw new Error(`Recovered Gazette article was parsed without retained source bytes: ${record.citationUrl}`);
        const number = record.registrationNumber?.match(/^SOR\/2026-(\d+)$/u)?.[1];
        if (!number || typeof source.file !== 'string') throw new Error(`Recovered Gazette article lacks its registered source identity: ${record.id}`);
        const originalIndex = readFileSync(resolve(archiveRoot, source.file), 'utf8');
        const wrongLink = new RegExp(`\\bhref\\s*=\\s*(["'])([^"']*sor-dors${number}-fra\\.html)\\1`, 'iu').exec(originalIndex)?.[2];
        if (!wrongLink) throw new Error(`Original English issue index did not retain its observed French link for ${record.registrationNumber}.`);
        return { recordId: record.id, registrationNumber: record.registrationNumber, url: record.citationUrl,
          observedHref: wrongLink, source: articleSource,
          validation: { documentLanguage: 'en', publishedIssueDate: key.issueDate,
            issueIdentity: `Part ${key.part}, volume ${key.volume}, number ${key.issueNumber}`,
            registrationNumber: record.registrationNumber,
            frenchPartnerRecordId: record.id.replace(':en:', ':fr:'),
            evidence: 'direct official English article response plus the parsed French issue index' } };
      }) : undefined;
    return { language: key.language, source, recordCount: edition.records.length,
      ...(recoveredArticles ? { recoveredArticles } : {}) };
  } catch (error) {
    return { language: key.language, url, source: sources.get(url) ?? null,
      error: error instanceof Error ? error.message : String(error) };
  }
}

/** Weekly catch-up that verifies retained editions and downloads only missing bilingual pairs. */
export async function syncGazetteYearCatchup(databaseFile: string, year: number, cutoff: string,
  send: typeof fetch = fetch, outputRoot = 'dist/gazette/backfills'): Promise<Record<string, unknown>> {
  if (!Number.isInteger(year) || !/^\d{4}-\d{2}-\d{2}$/u.test(cutoff) || cutoff.slice(0, 4) !== String(year) ||
      Number.isNaN(Date.parse(`${cutoff}T00:00:00Z`))) throw new Error('Invalid Gazette catch-up year and cutoff.');
  const runId = `catchup-${year}-through-${cutoff}-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`;
  const absoluteRoot = resolve(outputRoot);
  const receiptDirectory = resolve(absoluteRoot, 'catchups', `${year}-through-${cutoff}`);
  const objectsDirectory = resolve(absoluteRoot, 'objects');
  mkdirSync(objectsDirectory, { recursive: true });
  mkdirSync(receiptDirectory, { recursive: true });
  const { fetcher: captureSend, state: capture } = createSourceCapture(send, absoluteRoot, 64 * 1024 * 1024);

  const discovery = await discoverGazetteYearThrough(year, cutoff, captureSend);
  const absoluteDatabase = resolve(databaseFile);
  mkdirSync(dirname(absoluteDatabase), { recursive: true });
  const sqlite = openStore(absoluteDatabase);
  const editions: GazetteEdition[] = [];
  const issueResults: Array<Record<string, unknown>> = [];
  const archiveIndex = loadVerifiedGazetteArchiveIndex(absoluteRoot, year);
  const corruptArchives: Array<Record<string, unknown>> = [];
  try {
    for (const issue of discovery.issues) {
      const result = await processCatchupIssue(issue, { root: absoluteRoot, sqlite, archiveIndex,
        send: captureSend, sources: capture.sources });
      issueResults.push(result.result);
      editions.push(...result.editions);
      if (result.corrupt) corruptArchives.push(result.corrupt);
    }
    let importResults: ReturnType<typeof importGazetteEditionBatch> = [];
    if (editions.length) importResults = importGazetteEditionBatch(sqlite, editions);
    const unsupported = discovery.annualListings.flatMap((listing) => (listing.unsupportedRows ?? []).map((row) => ({
      part: listing.part, language: listing.language, date: row.date, text: row.text,
    })));
    const failedListings = discovery.annualListings.filter((listing) => listing.error);
    const unavailableIssues = issueResults.filter((result) => result.status === 'unavailable').length;
    const archived = issueResults.filter((result) => result.status === 'archive-verified').length;
    const complete = failedListings.length === 0 && unsupported.length === 0 && unavailableIssues === 0 &&
      corruptArchives.length === 0 && capture.errors.length === 0 && discovery.annualListings.length === 4 &&
      discovery.annualListings.every((listing) => (listing.regularRows ?? 0) > 0 && listing.sha256);
    const receipt = { schemaVersion: 1, runId, source: 'https://gazette.gc.ca', year, cutoff,
      completedAt: new Date().toISOString(), databasePath: absoluteDatabase,
      policy: { existingEditions: 'reuse only after both originals match their recorded hashes and reparse to the imported database digests',
        missingEditions: 'both official language indexes must parse and be archived before atomic import', extras: 'excluded' },
      annualListings: discovery.annualListings,
      sources: [...capture.sources.values()], captureErrors: capture.errors, issues: issueResults,
      corruptArchives, unsupportedRegularRows: unsupported,
      import: { editions: importResults, imported: importResults.filter((item) => item.status === 'imported').length,
        unchanged: importResults.filter((item) => item.status === 'unchanged').length,
        recordCount: editions.reduce((sum, edition) => sum + edition.records.length, 0) },
      counts: { discoveredIssues: discovery.issues.length, newlyVerifiedIssues: issueResults.filter((item) => item.status === 'verified-new').length,
        archiveVerifiedPairs: archived,
        unavailableIssues, corruptArchivePairs: corruptArchives.length, unsupportedRegularRows: unsupported.length,
        ...excludedExtraCounts(discovery.annualListings),
        archivedSourceBytes: capture.bytes }, complete };
    const receiptFile = resolve(receiptDirectory, `${runId}.json`);
    writeAtomicJson(receiptFile, receipt);
    const latestFile = resolve(receiptDirectory, 'latest.json');
    writeAtomicJson(latestFile, { receipt: receiptFile, runId, completedAt: receipt.completedAt, complete });
    return { ...receipt, receiptPath: receiptFile, latestReceiptPath: latestFile };
  } finally { sqlite.close(); }
}

async function processCatchupIssue(issue: Awaited<ReturnType<typeof discoverGazetteYearThrough>>['issues'][number],
  context: CatchupContext): Promise<{ editions: GazetteEdition[]; result: Record<string, unknown>; corrupt?: Record<string, unknown> }> {
  const base = { part: issue.part, issueDate: issue.issueDate, volume: issue.volume, issueNumber: issue.issueNumber };
  const { en, fr } = issue.languages;
  if (!en || !fr || issue.identityMismatch) return { editions: [], result: { ...base, status: 'unavailable', reason: 'annual-listing-language-gap-or-identity-mismatch' } };
  const keys = [en, fr] as const;
  const digests = keys.map((key) => storedGazetteEditionDigest(context.sqlite, key));
  const archived = context.archiveIndex.get(`${issue.part}:${issue.issueDate}:v${issue.volume}:n${issue.issueNumber}`);
  if (archived && digests.every(Boolean)) return verifyCatchupArchive(archived, base, context, keys, digests);
  const fetched = await fetchHistoricalIssuePair(issue, context.send, context.sources, context.root);
  const result = { ...base, status: fetched.result.status === 'verified' ? 'verified-new' : 'unavailable',
    languages: (fetched.result.languages as unknown[]) ?? [], causes: fetched.result.causes };
  return { editions: fetched.editions, result };
}

async function verifyCatchupArchive(archived: ArchivedPair,
  base: Record<string, unknown>, context: CatchupContext,
  keys: readonly [GazetteIssueKey, GazetteIssueKey], digests: Array<string | undefined>): Promise<{
    editions: GazetteEdition[]; result: Record<string, unknown>; corrupt?: Record<string, unknown>;
  }> {
  const results = await Promise.all(keys.map((key, index) => verifyArchivedGazetteLanguage(context.root, context.sqlite, key,
    archived.sources[key.language], digests[index], archived.sources[key.language === 'en' ? 'fr' : 'en'])));
  if (results.every((result) => result.valid)) return { editions: [], result: { ...base, status: 'archive-verified', sources: results.map((result) => result.source) } };
  const failures = results.filter((result) => !result.valid).map((result) => result.error);
  return { editions: [], result: { ...base, status: 'corrupt-archive', failures }, corrupt: { ...base, failures } };
}

function annualReceiptFiles(parent: string, year: number): string[] {
  if (!existsSync(parent)) return [];
  const directories = readdirSync(parent, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith(`${year}-through-`));
  return directories.flatMap(({ name }) => readdirSync(resolve(parent, name))
    .filter(file => file.endsWith('.json') && file !== 'latest.json')
    .map(file => resolve(parent, name, file)));
}

function loadVerifiedGazetteArchiveIndex(root: string, year: number): Map<string, ArchivedPair> {
  const result = new Map<string, ArchivedPair>();
  for (const category of ['receipts', 'catchups']) {
    for (const file of annualReceiptFiles(resolve(root, category), year)) {
      const receipt = JSON.parse(readFileSync(file, 'utf8')) as { completedAt: string; issues: Array<Record<string, unknown>> };
      for (const issue of receipt.issues) addVerifiedIssue(issue, receipt.completedAt, result);
    }
  }
  return result;
}

function addVerifiedIssue(issue: Record<string, unknown>, completedAt: string, output: Map<string, ArchivedPair>): void {
  if (issue.status !== 'verified' && issue.status !== 'verified-new') return;
  const key = `${issue.part}:${issue.issueDate}:v${issue.volume}:n${issue.issueNumber}`;
  if ((output.get(key)?.completedAt ?? '') > completedAt) return;
  const languages: Partial<Record<'en' | 'fr', Record<string, unknown>>> = {};
  for (const language of (issue.languages as Array<Record<string, unknown>> | undefined) ?? []) {
    const code = language.language;
    const source = language.source;
    if ((code === 'en' || code === 'fr') && source && typeof source === 'object') languages[code] = language;
  }
  if (languages.en && languages.fr) output.set(key, { completedAt, sources: languages });
}

async function verifyArchivedGazetteLanguage(root: string, sqlite: DatabaseSync, key: GazetteIssueKey,
  archivedLanguage: Record<string, unknown> | undefined, storedDigest: string | undefined,
  partnerLanguage?: Record<string, unknown>): Promise<{ valid: boolean; source?: unknown; error?: string }> {
  const source = archivedLanguage?.source as Record<string, unknown> | undefined;
  if (!source || typeof source.url !== 'string' || typeof source.sha256 !== 'string' || typeof source.file !== 'string') {
    return { valid: false, error: `${key.language}: verified receipt lacks source identity or hash.` };
  }
  const url = gazetteIssueUrl(key, true).href;
  if (source.url !== url || !/^[a-f0-9]{64}$/u.test(source.sha256)) {
    return { valid: false, error: `${key.language}: archived source URL or SHA-256 is invalid.` };
  }
  const file = resolve(root, source.file);
  if (!file.startsWith(`${resolve(root)}${process.platform === 'win32' ? '\\' : '/'}`) || !existsSync(file)) {
    return { valid: false, error: `${key.language}: archived original is missing or outside the object store.` };
  }
  const bytes = readFileSync(file);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== source.sha256 || (typeof source.bytes === 'number' && source.bytes !== bytes.length)) {
    return { valid: false, error: `${key.language}: archived original bytes do not match the receipt hash or size.` };
  }
  try {
    let edition: GazetteEdition;
    if (key.part === 'II' && key.language === 'en' && key.issueDate === '2026-06-03') {
      const related = archivedLanguage?.['recoveredArticles'];
      if (!Array.isArray(related) || related.length !== 7 || !partnerLanguage || typeof partnerLanguage['source'] !== 'object') {
        return { valid: false, error: `${key.language}: repaired issue receipt lacks seven article archives or the French partner index.` };
      }
      const articleSources = new Map<string, Uint8Array>();
      const articleRefs: Array<Record<string, unknown>> = [];
      const originalIndex = new TextDecoder('utf-8').decode(bytes);
      for (const item of related) {
        if (!item || typeof item !== 'object' || typeof item['url'] !== 'string' || typeof item['observedHref'] !== 'string' ||
            !item['source'] || typeof item['source'] !== 'object') {
          return { valid: false, error: `${key.language}: recovered article receipt is malformed.` };
        }
        const registrationNumber = String(item['registrationNumber'] ?? '');
        const number = /^SOR\/2026-(\d+)$/u.exec(registrationNumber)?.[1];
        if (!number) return { valid: false, error: `${key.language}: recovered article receipt has no exact SOR identity.` };
        const observedHref = new RegExp(`\\bhref\\s*=\\s*(["'])([^"']*sor-dors${number}-fra\\.html)\\1`, 'iu').exec(originalIndex)?.[2];
        if (observedHref !== item['observedHref']) {
          return { valid: false, error: `${key.language}: retained English index no longer contains its recorded French mislink for ${registrationNumber}.` };
        }
        const articleSource = item['source'] as Record<string, unknown>;
        const articleBytes = readVerifiedGazetteSource(root, articleSource, item['url']);
        if (!articleBytes) return { valid: false, error: `${key.language}: recovered English article is missing or fails its receipt hash (${item['url']}).` };
        articleSources.set(item['url'], articleBytes);
        articleRefs.push(item as Record<string, unknown>);
      }
      const partnerSource = partnerLanguage['source'] as Record<string, unknown>;
      const partnerKey: GazetteIssueKey = { ...key, language: 'fr' };
      const partnerBytes = readVerifiedGazetteSource(root, partnerSource, gazetteIssueUrl(partnerKey, true).href);
      if (!partnerBytes) return { valid: false, error: `${key.language}: French partner index is missing or fails its receipt hash.` };
      const mockSend: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
        const requestUrl = input instanceof Request ? input.url : String(input);
        const body = requestUrl === url ? bytes : articleSources.get(requestUrl) ??
          (requestUrl === gazetteIssueUrl(partnerKey, true).href ? partnerBytes : undefined);
        return new Response(body, { status: body ? 200 : 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }, { preconnect: () => undefined });
      edition = validateGazetteEdition(await fetchGazetteIssue(key, mockSend, true));
      const recordById = new Map(edition.records.map((record) => [record.id, record]));
      if (articleRefs.some((item) => !recordById.has(String(item['recordId'])) ||
          recordById.get(String(item['recordId']))?.citationUrl !== item['url'])) {
        return { valid: false, error: `${key.language}: archived recovered article identities do not match the repaired index.` };
      }
    } else {
      edition = validateGazetteEdition(await parseGazetteIssue(new TextDecoder('utf-8').decode(bytes), key, true));
    }
    if (!storedDigest || gazetteEditionDigest(edition) !== storedDigest) {
      return { valid: false, error: `${key.language}: archived parse does not match the imported database digest.` };
    }
    const recoveredArticles = key.part === 'II' && key.language === 'en' && key.issueDate === '2026-06-03'
      ? archivedLanguage?.['recoveredArticles'] : undefined;
    return { valid: true, source: recoveredArticles ? { ...source, recoveredArticles } : source };
  } catch (error) {
    return { valid: false, error: `${key.language}: archived original no longer parses: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function readVerifiedGazetteSource(root: string, source: Record<string, unknown>, expectedUrl: string): Uint8Array | undefined {
  if (source.url !== expectedUrl || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(source.sha256) ||
      typeof source.file !== 'string') return undefined;
  const absoluteRoot = resolve(root);
  const file = resolve(root, source.file);
  if (!file.startsWith(`${absoluteRoot}${process.platform === 'win32' ? '\\' : '/'}`) || !existsSync(file)) return undefined;
  const bytes = readFileSync(file);
  if (createHash('sha256').update(bytes).digest('hex') !== source.sha256 ||
      (typeof source.bytes === 'number' && source.bytes !== bytes.length)) return undefined;
  return bytes;
}

function writeAtomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let published = false;
  try {
    const descriptor = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    renameSync(temporary, file);
    published = true;
  } finally { if (!published) try { unlinkSync(temporary); } catch { /* no temporary remains */ } }
}

export function parseGazetteReplayManifest(value: unknown) {
  const parsed = manifest.parse(value);
  const seen = new Set<string>();
  for (const issue of parsed.issues) {
    if (!isGazetteIssueSupported(issue)) throw new Error('Gazette replay manifest contains an issue outside the configured preview set.');
    const identity = gazetteIssueId(issue);
    if (seen.has(identity)) throw new Error('Gazette replay manifest contains a duplicate issue edition.');
    seen.add(identity);
  }
  return parsed;
}

function openStore(databaseFile: string) {
  const { Database: SQLite } = createRequire(import.meta.url)('bun:sqlite') as {
    Database: new (file: string, options: { readonly: boolean; create: boolean; strict: boolean }) => DatabaseSync;
  };
  const sqlite = new SQLite(databaseFile, { readonly: false, create: true, strict: true });
  sqlite.exec(readFileSync(new URL('../preview/gazette/migrations/0001_gazette.sql', import.meta.url), 'utf8'));
  return sqlite;
}

const commandHandlers: Record<string, (args: string[]) => Promise<void>> = {
  search: handleLookup,
  show: handleLookup,
  'verify-live': handleVerifyLive,
  sync: handleSync,
  'sync-current': handleSyncCurrent,
  'sync-year': (args) => handleYear(args, syncGazetteYearThrough),
  'sync-year-catchup': (args) => handleYear(args, syncGazetteYearCatchup),
  replay: (args) => handleImportOrReplay(args, 'replay'),
  import: (args) => handleImportOrReplay(args, 'import'),
};

async function main(args: string[]): Promise<void> {
  const command = args[0] ?? '';
  const handler = commandHandlers[command];
  if (!handler) throw new Error(USAGE);
  await handler(args);
}

async function handleLookup(args: string[]): Promise<void> {
  console.log(JSON.stringify(await recallGazette(args), null, 2));
}

async function handleVerifyLive(args: string[]): Promise<void> {
  if (args.length !== 1) throw new Error(USAGE);
  const issues = await fetchVerifiedGazettePreview();
  const result = issues.map(({ part, language, issueDate, volume, issueNumber, records }) => ({
    part, language, issueDate, volume, issueNumber, recordCount: records.length,
    kinds: [...new Set(records.map(({ kind }) => kind))].sort(),
  }));
  console.log(JSON.stringify({ source: 'live-read-only', persisted: false, issues: result }, null, 2));
}

async function handleSync(args: string[]): Promise<void> {
  const databaseFile = args[1];
  if (!databaseFile || args.length !== 2) throw new Error(USAGE);
  const issues = await fetchVerifiedGazettePreview();
  const sqlite = openStore(databaseFile);
  try {
    const editions = issues.map((edition) => importGazetteEdition(sqlite, edition));
    console.log(JSON.stringify({ complete: true, persisted: true, editions }, null, 2));
  } finally { sqlite.close(); }
}

async function handleSyncCurrent(args: string[]): Promise<void> {
  const databaseFile = args[1];
  if (!databaseFile || args.length < 2 || args.length > 3) throw new Error(USAGE);
  console.log(JSON.stringify(await syncCurrent(databaseFile, args[2]), null, 2));
}

async function handleYear(args: string[], run: typeof syncGazetteYearThrough | typeof syncGazetteYearCatchup): Promise<void> {
  const databaseFile = args[1];
  if (!databaseFile || args.length !== 4 || !/^\d{4}$/u.test(args[2] ?? '') || !args[3]) throw new Error(USAGE);
  const result = await run(databaseFile, Number(args[2]), args[3]);
  const imported = result.import as { imported: number; unchanged: number; recordCount: number };
  console.log(JSON.stringify({ complete: result.complete, receiptPath: result.receiptPath,
    latestReceiptPath: result.latestReceiptPath, counts: result.counts,
    import: { imported: imported.imported, unchanged: imported.unchanged, recordCount: imported.recordCount } }, null, 2));
  if (!result.complete) process.exitCode = 1;
}

async function handleImportOrReplay(args: string[], command: 'import' | 'replay'): Promise<void> {
  const databaseFile = args[1];
  const inputFile = args[2];
  if (!databaseFile || !inputFile || args.length !== 3) throw new Error(USAGE);
  const sqlite = openStore(databaseFile);
  try {
    if (command === 'import') {
      const result = importGazetteEdition(sqlite, JSON.parse(readFileSync(inputFile, 'utf8')));
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const parsed = parseGazetteReplayManifest(JSON.parse(readFileSync(inputFile, 'utf8')));
    const base = dirname(resolve(inputFile));
    const results = [];
    for (const entry of parsed.issues) {
      const html = readFileSync(resolve(base, entry.file), 'utf8');
      const { file: _file, ...expected } = entry;
      results.push(importGazetteEdition(sqlite, await parseGazetteIssue(html, expected)));
    }
    console.log(JSON.stringify({ complete: true, editions: results }, null, 2));
  } finally { sqlite.close(); }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
