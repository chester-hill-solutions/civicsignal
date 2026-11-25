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
import { fetchGazetteExtraEdition, inspectGazetteExtraPdf, parseGazetteExtraEdition, type GazetteExtraPdfEvidence } from './lib/gazette-extra-source';
import { gazetteExtraEditionDigest, importGazetteExtraEditionBatch, storedGazetteExtraEditionDigest, type GazetteExtraEdition, type GazetteExtraIssueKey } from './lib/gazette-extra-store';

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

type SourceCaptureState = { bytes: number; sources: Map<string, Record<string, unknown>>; errors: Array<{ url: string; error: string }> };
type ArchivedPair = { completedAt: string; sources: Partial<Record<'en' | 'fr', Record<string, unknown>>> };
type ArchivedExtraPair = { completedAt: string; sources: Partial<Record<'en' | 'fr', Record<string, unknown>>> };
type CatchupContext = {
  root: string;
  sqlite: DatabaseSync;
  archiveIndex: Map<string, ArchivedPair>;
  archiveExtraIndex: Map<string, ArchivedExtraPair>;
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
  const isPdf = new URL(url).pathname.endsWith('.pdf') && contentType === 'application/pdf';
  if (!response.ok || (contentType !== 'text/html' && !isPdf) || !bytes.length) {
    if (response.ok) state.errors.push({ url, error: `Unexpected source media type or empty body (${contentType ?? 'missing content type'}).` });
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const stats = statfsSync(root);
  if (stats.bavail * stats.bsize - bytes.length < HISTORICAL_RESERVE_BYTES) return captureFailure(state, url, 'Insufficient free disk space to preserve the next Gazette source index.');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const file = `objects/${hash}.${isPdf ? 'pdf' : 'html'}`;
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
  const extraEditions: GazetteExtraEdition[] = [];
  const extraResults: Array<Record<string, unknown>> = [];
  for (const issue of discovery.issues) {
    const result = await fetchHistoricalIssuePair(issue, captureSend, capture.sources, absoluteRoot);
    issueResults.push(result.result);
    editions.push(...result.editions);
  }
  for (const extra of discovery.extraIssues) {
    const result = await fetchHistoricalExtraPair(extra, captureSend, capture.sources);
    extraResults.push(result.result);
    extraEditions.push(...result.editions);
  }
  const importResults: ReturnType<typeof importGazetteEditionBatch> = [];
  if (editions.length) {
    const absoluteDatabase = resolve(databaseFile);
    mkdirSync(dirname(absoluteDatabase), { recursive: true });
    const sqlite = openStore(absoluteDatabase);
    try { importResults.push(...importGazetteEditionBatch(sqlite, editions)); } finally { sqlite.close(); }
  }
  let extraImportResults: ReturnType<typeof importGazetteExtraEditionBatch> = [];
  if (extraEditions.length) {
    const absoluteDatabase = resolve(databaseFile);
    mkdirSync(dirname(absoluteDatabase), { recursive: true });
    const sqlite = openStore(absoluteDatabase);
    try { extraImportResults = importGazetteExtraEditionBatch(sqlite, extraEditions); } finally { sqlite.close(); }
  }
  const unsupported = discovery.annualListings.flatMap((listing) => (listing.unsupportedRows ?? []).map((row) => ({
    part: listing.part, language: listing.language, date: row.date, text: row.text, reason: 'unrecognized-regular-row',
  })));
  const annualFailures = discovery.annualListings.filter((listing) => listing.error);
  const unsupportedExtras = discovery.annualListings.flatMap((listing) => (listing.unsupportedExtraRows ?? []).map((row) => ({
    part: listing.part, language: listing.language, date: row.date, text: row.text, reason: 'unrecognized-extra-row',
  })));
  const unavailable = issueResults.filter((item) => item.status === 'unavailable').length +
    extraResults.filter((item) => item.status === 'unavailable').length + unsupported.length + unsupportedExtras.length + annualFailures.length;
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
    policy: { editions: 'officially listed regular and extra issues', languages: 'both English and French required before import',
      extras: 'separate identities and local preview tables', maxCapturedBytes: HISTORICAL_CAPTURE_LIMIT, maxBytesPerSource: HISTORICAL_FILE_LIMIT },
    annualListings: discovery.annualListings,
    extras: extraResults,
    unsupportedExtraRows: unsupportedExtras,
    unsupportedRegularRows: unsupported,
    issues: issueResults,
    sources: [...capture.sources.values()],
    captureErrors: capture.errors,
    import: { editions: importResults, imported: importResults.filter((item) => item.status === 'imported').length,
      unchanged: importResults.filter((item) => item.status === 'unchanged').length,
      recordCount: editions.reduce((sum, edition) => sum + edition.records.length, 0),
      extras: extraImportResults, importedExtras: extraImportResults.filter((item) => item.status === 'imported').length,
      unchangedExtras: extraImportResults.filter((item) => item.status === 'unchanged').length,
      extraRecordCount: extraEditions.reduce((sum, edition) => sum + edition.records.length, 0) },
    counts: { discoveredIssues: discovery.issues.length, verifiedIssues: issueResults.filter((item) => item.status === 'verified').length,
      unavailableIssues: issueResults.filter((item) => item.status === 'unavailable').length,
      discoveredExtras: discovery.extraIssues.length, verifiedExtras: extraResults.filter((item) => item.status === 'verified').length,
      unavailableExtras: extraResults.filter((item) => item.status === 'unavailable').length,
      unsupportedRegularRows: unsupported.length, unsupportedExtraRows: unsupportedExtras.length, archivedSourceBytes: capture.bytes },
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

async function fetchHistoricalExtraPair(extra: Awaited<ReturnType<typeof discoverGazetteYearThrough>>['extraIssues'][number],
  send: typeof fetch, sources: Map<string, Record<string, unknown>>): Promise<{ editions: GazetteExtraEdition[]; result: Record<string, unknown> }> {
  const base = { part: extra.part, issueDate: extra.issueDate, volume: extra.volume, extraNumber: extra.extraNumber };
  const { en, fr } = extra.languages;
  if (!en || !fr || extra.identityMismatch) return { editions: [], result: { ...base, status: 'unavailable',
    causes: [!en ? 'English annual listing has no matching extra.' : '', !fr ? 'French annual listing has no matching extra.' : '',
      extra.identityMismatch ? 'English and French annual listings disagree on volume.' : ''].filter(Boolean) } };
  const parsed: Partial<Record<'en' | 'fr', GazetteExtraEdition>> = {};
  const languages: Array<Record<string, unknown>> = [];
  for (const [language, link] of [['en', en], ['fr', fr]] as const) {
    const key: GazetteExtraIssueKey = { part: extra.part, issueDate: extra.issueDate, volume: extra.volume,
      extraNumber: extra.extraNumber, language };
    try {
      const fetched = await fetchGazetteExtraEdition(key, link.htmlUrl, send, link.pdfUrl);
      const edition = fetched.edition;
      const source = sources.get(link.htmlUrl);
      if (!source) throw new Error('Extra page parsed without retained source hash and original bytes.');
      parsed[language] = edition;
      const pdfSource = fetched.pdfEvidence ? sources.get(fetched.pdfEvidence.url) : undefined;
      if (fetched.pdfEvidence && !pdfSource) throw new Error('Extra page date was reconciled without retaining its official PDF bytes and hash.');
      languages.push({ language, url: link.htmlUrl, source, htmlIssuedAt: fetched.htmlIssuedAt,
        ...(fetched.pdfEvidence ? { pdfEvidence: fetched.pdfEvidence, pdfSource } : {}), recordCount: edition.records.length });
    } catch (error) {
      languages.push({ language, url: link.htmlUrl, source: sources.get(link.htmlUrl) ?? null,
        error: error instanceof Error ? error.message : String(error) });
    }
  }
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
  const extraEditions: GazetteExtraEdition[] = [];
  const extraResults: Array<Record<string, unknown>> = [];
  const archiveIndex = loadVerifiedGazetteArchiveIndex(absoluteRoot, year);
  const archiveExtraIndex = loadVerifiedGazetteExtraArchiveIndex(absoluteRoot, year);
  const corruptArchives: Array<Record<string, unknown>> = [];
  try {
    const processed = await processCatchupDiscovery(discovery, { root: absoluteRoot, sqlite, archiveIndex,
      archiveExtraIndex, send: captureSend, sources: capture.sources });
    editions.push(...processed.editions);
    issueResults.push(...processed.issues);
    extraEditions.push(...processed.extraEditions);
    extraResults.push(...processed.extras);
    corruptArchives.push(...processed.corruptArchives);
    let importResults: ReturnType<typeof importGazetteEditionBatch> = [];
    if (editions.length) importResults = importGazetteEditionBatch(sqlite, editions);
    let extraImportResults: ReturnType<typeof importGazetteExtraEditionBatch> = [];
    if (extraEditions.length) extraImportResults = importGazetteExtraEditionBatch(sqlite, extraEditions);
    const unsupported = discovery.annualListings.flatMap((listing) => (listing.unsupportedRows ?? []).map((row) => ({
      part: listing.part, language: listing.language, date: row.date, text: row.text,
    })));
    const failedListings = discovery.annualListings.filter((listing) => listing.error);
    const unavailableIssues = issueResults.filter((result) => result.status === 'unavailable').length;
    const archived = issueResults.filter((result) => result.status === 'archive-verified').length;
    const unsupportedExtras = discovery.annualListings.flatMap((listing) => (listing.unsupportedExtraRows ?? []).map((row) => ({
      part: listing.part, language: listing.language, date: row.date, text: row.text,
    })));
    const unavailableExtras = extraResults.filter((result) => result.status === 'unavailable').length;
    const archivedExtras = extraResults.filter((result) => result.status === 'archive-verified').length;
    const complete = failedListings.length === 0 && unsupported.length === 0 && unsupportedExtras.length === 0 &&
      unavailableIssues === 0 && unavailableExtras === 0 &&
      corruptArchives.length === 0 && capture.errors.length === 0 && discovery.annualListings.length === 4 &&
      discovery.annualListings.every((listing) => (listing.regularRows ?? 0) > 0 && listing.sha256);
    const receipt = { schemaVersion: 1, runId, source: 'https://gazette.gc.ca', year, cutoff,
      completedAt: new Date().toISOString(), databasePath: absoluteDatabase,
      policy: { existingEditions: 'reuse only after both originals match their recorded hashes and reparse to the imported database digests',
        missingEditions: 'both official language pages must parse and be archived before atomic import', extras: 'separate identities and local preview tables' },
      annualListings: discovery.annualListings,
      sources: [...capture.sources.values()], captureErrors: capture.errors, issues: issueResults, extras: extraResults,
      corruptArchives, unsupportedRegularRows: unsupported, unsupportedExtraRows: unsupportedExtras,
      import: { editions: importResults, imported: importResults.filter((item) => item.status === 'imported').length,
        unchanged: importResults.filter((item) => item.status === 'unchanged').length,
        recordCount: editions.reduce((sum, edition) => sum + edition.records.length, 0), extras: extraImportResults,
        importedExtras: extraImportResults.filter((item) => item.status === 'imported').length,
        unchangedExtras: extraImportResults.filter((item) => item.status === 'unchanged').length,
        extraRecordCount: extraEditions.reduce((sum, edition) => sum + edition.records.length, 0) },
      counts: { discoveredIssues: discovery.issues.length, newlyVerifiedIssues: issueResults.filter((item) => item.status === 'verified-new').length,
        archiveVerifiedPairs: archived,
        unavailableIssues, corruptArchivePairs: corruptArchives.length, unsupportedRegularRows: unsupported.length,
        discoveredExtras: discovery.extraIssues.length,
        newlyVerifiedExtras: extraResults.filter((result) => result.status === 'verified-new').length,
        archiveVerifiedExtras: archivedExtras, unavailableExtras, corruptArchiveExtras: corruptArchives.filter((item) => item['extraNumber'] !== undefined).length,
        unsupportedExtraRows: unsupportedExtras.length,
        archivedSourceBytes: capture.bytes }, complete };
    const receiptFile = resolve(receiptDirectory, `${runId}.json`);
    writeAtomicJson(receiptFile, receipt);
    const latestFile = resolve(receiptDirectory, 'latest.json');
    writeAtomicJson(latestFile, { receipt: receiptFile, runId, completedAt: receipt.completedAt, complete });
    return { ...receipt, receiptPath: receiptFile, latestReceiptPath: latestFile };
  } finally { sqlite.close(); }
}

async function processCatchupDiscovery(discovery: Awaited<ReturnType<typeof discoverGazetteYearThrough>>,
  context: CatchupContext): Promise<{ editions: GazetteEdition[]; issues: Record<string, unknown>[];
    extraEditions: GazetteExtraEdition[]; extras: Record<string, unknown>[]; corruptArchives: Record<string, unknown>[] }> {
  const output = { editions: [] as GazetteEdition[], issues: [] as Record<string, unknown>[],
    extraEditions: [] as GazetteExtraEdition[], extras: [] as Record<string, unknown>[], corruptArchives: [] as Record<string, unknown>[] };
  for (const issue of discovery.issues) {
    const result = await processCatchupIssue(issue, context);
    output.issues.push(result.result);
    output.editions.push(...result.editions);
    if (result.corrupt) output.corruptArchives.push(result.corrupt);
  }
  for (const extra of discovery.extraIssues) {
    const result = await processCatchupExtra(extra, context);
    output.extras.push(result.result);
    output.extraEditions.push(...result.editions);
    if (result.corrupt) output.corruptArchives.push(result.corrupt);
  }
  return output;
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

async function processCatchupExtra(extra: Awaited<ReturnType<typeof discoverGazetteYearThrough>>['extraIssues'][number],
  context: CatchupContext): Promise<{ editions: GazetteExtraEdition[]; result: Record<string, unknown>; corrupt?: Record<string, unknown> }> {
  const base = { part: extra.part, issueDate: extra.issueDate, volume: extra.volume, extraNumber: extra.extraNumber };
  const { en, fr } = extra.languages;
  if (!en || !fr || extra.identityMismatch) return { editions: [], result: { ...base, status: 'unavailable', reason: 'annual-listing-language-gap-or-identity-mismatch' } };
  const keys: [GazetteExtraIssueKey, GazetteExtraIssueKey] = [
    { part: extra.part, issueDate: extra.issueDate, volume: extra.volume, extraNumber: extra.extraNumber, language: 'en' },
    { part: extra.part, issueDate: extra.issueDate, volume: extra.volume, extraNumber: extra.extraNumber, language: 'fr' },
  ];
  const stored = keys.map((key) => storedGazetteExtraEditionDigest(context.sqlite, key));
  const archiveKey = `${extra.part}:${extra.issueDate}:v${extra.volume}:x${extra.extraNumber}`;
  const archived = context.archiveExtraIndex.get(archiveKey);
  if (archived && stored.every(Boolean)) {
    const expectedUrls = { en: en.htmlUrl, fr: fr.htmlUrl };
    const results = await Promise.all(keys.map((key, index) => verifyArchivedGazetteExtra(context.root, key,
      archived.sources[key.language], stored[index], expectedUrls[key.language])));
    if (results.every((result) => result.valid)) return { editions: [], result: { ...base, status: 'archive-verified', sources: results.map((result) => result.source) } };
    const failures = results.filter((result) => !result.valid).map((result) => result.error);
    return { editions: [], result: { ...base, status: 'corrupt-archive', failures }, corrupt: { ...base, failures } };
  }
  const fetched = await fetchHistoricalExtraPair(extra, context.send, context.sources);
  return { editions: fetched.editions,
    result: { ...base, status: fetched.result.status === 'verified' ? 'verified-new' : 'unavailable',
      languages: fetched.result.languages ?? [], causes: fetched.result.causes } };
}

async function verifyArchivedGazetteExtra(root: string, key: GazetteExtraIssueKey,
  archivedLanguage: Record<string, unknown> | undefined, storedDigest: string | undefined,
  expectedUrl: string): Promise<{ valid: boolean; source?: unknown; error?: string }> {
  const source = archivedLanguage?.source as Record<string, unknown> | undefined;
  if (!source || typeof source.url !== 'string' || typeof source.sha256 !== 'string' || typeof source.file !== 'string') {
    return { valid: false, error: `${key.language}: verified extra receipt lacks source identity or hash.` };
  }
  const bytes = readVerifiedGazetteSource(root, source, expectedUrl);
  if (!bytes || !storedDigest) return { valid: false, error: `${key.language}: archived extra original is missing or fails SHA-256 verification.` };
  try {
    let pdfEvidence: GazetteExtraPdfEvidence | undefined;
    const priorEvidence = archivedLanguage?.['pdfEvidence'] as GazetteExtraPdfEvidence | undefined;
    const pdfSource = archivedLanguage?.['pdfSource'] as Record<string, unknown> | undefined;
    if (priorEvidence) {
      if (!pdfSource || typeof priorEvidence.url !== 'string') throw new Error('Receipt lacks the archived official PDF source for its date reconciliation.');
      const pdfBytes = readVerifiedGazetteSource(root, pdfSource, priorEvidence.url);
      if (!pdfBytes) throw new Error('Official extra PDF is missing or fails SHA-256 verification.');
      pdfEvidence = inspectGazetteExtraPdf(pdfBytes, key, priorEvidence.url);
      if (JSON.stringify(pdfEvidence) !== JSON.stringify(priorEvidence)) throw new Error('Official extra PDF evidence differs from its successful receipt.');
    }
    const edition = parseGazetteExtraEdition(new TextDecoder('utf-8').decode(bytes), key, source.url, pdfEvidence);
    if (gazetteExtraEditionDigest(edition) !== storedDigest) return { valid: false, error: `${key.language}: archived extra parse differs from local materialization.` };
    return { valid: true, source };
  } catch (error) {
    return { valid: false, error: `${key.language}: archived extra no longer parses: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function verifyCatchupArchive(archived: ArchivedPair,
  base: Record<string, unknown>, context: CatchupContext,
  keys: readonly [GazetteIssueKey, GazetteIssueKey], digests: Array<string | undefined>): Promise<{
    editions: GazetteEdition[]; result: Record<string, unknown>; corrupt?: Record<string, unknown>;
  }> {
  const results = await Promise.all(keys.map((key, index) => verifyArchivedGazetteLanguage({ root: context.root, key,
    archivedLanguage: archived.sources[key.language], storedDigest: digests[index],
    partnerLanguage: archived.sources[key.language === 'en' ? 'fr' : 'en'] })));
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

function loadVerifiedGazetteExtraArchiveIndex(root: string, year: number): Map<string, ArchivedExtraPair> {
  const result = new Map<string, ArchivedExtraPair>();
  for (const category of ['receipts', 'catchups']) {
    for (const file of annualReceiptFiles(resolve(root, category), year)) {
      const receipt = JSON.parse(readFileSync(file, 'utf8')) as { completedAt: string; extras?: Array<Record<string, unknown>> };
      addVerifiedExtrasFromReceipt(receipt, result);
    }
  }
  return result;
}

function addVerifiedExtrasFromReceipt(receipt: { completedAt: string; extras?: Array<Record<string, unknown>> },
  output: Map<string, ArchivedExtraPair>): void {
  for (const extra of receipt.extras ?? []) addVerifiedExtra(extra, receipt.completedAt, output);
}

function addVerifiedExtra(extra: Record<string, unknown>, completedAt: string, output: Map<string, ArchivedExtraPair>): void {
  if (extra.status !== 'verified' && extra.status !== 'verified-new') return;
  if (typeof extra.part !== 'string' || typeof extra.issueDate !== 'string' || typeof extra.volume !== 'number' || typeof extra.extraNumber !== 'number') return;
  const key = `${extra.part}:${extra.issueDate}:v${extra.volume}:x${extra.extraNumber}`;
  if ((output.get(key)?.completedAt ?? '') > completedAt) return;
  const sources = extraLanguageSources(extra.languages as Array<Record<string, unknown>> | undefined);
  if (sources.en && sources.fr) output.set(key, { completedAt, sources });
}

function extraLanguageSources(languages: Array<Record<string, unknown>> | undefined): ArchivedExtraPair['sources'] {
  const sources: ArchivedExtraPair['sources'] = {};
  for (const language of languages ?? []) {
    const code = language.language;
    if ((code === 'en' || code === 'fr') && language.source && typeof language.source === 'object') sources[code] = language;
  }
  return sources;
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

type ArchivedLanguageContext = { root: string; key: GazetteIssueKey; archivedLanguage?: Record<string, unknown>;
  storedDigest?: string; partnerLanguage?: Record<string, unknown> };

async function verifyArchivedGazetteLanguage(context: ArchivedLanguageContext): Promise<{ valid: boolean; source?: unknown; error?: string }> {
  const { root, key, archivedLanguage, storedDigest } = context;
  const source = archivedLanguage?.source as Record<string, unknown> | undefined;
  const bytes = source ? readVerifiedGazetteSource(root, source, gazetteIssueUrl(key, true).href) : undefined;
  if (!source || !bytes) return { valid: false, error: `${key.language}: archived original is missing or fails its receipt identity/hash.` };
  try {
    const edition = isRecoveredEnglishIssue(key)
      ? await verifyRecoveredEnglishArchive(context, bytes)
      : validateGazetteEdition(await parseGazetteIssue(new TextDecoder('utf-8').decode(bytes), key, true));
    if (!storedDigest || gazetteEditionDigest(edition) !== storedDigest) {
      return { valid: false, error: `${key.language}: archived parse does not match the imported database digest.` };
    }
    const recoveredArticles = archivedLanguage?.['recoveredArticles'];
    return { valid: true, source: recoveredArticles ? { ...source, recoveredArticles } : source };
  } catch (error) {
    return { valid: false, error: `${key.language}: archived original no longer parses: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function isRecoveredEnglishIssue(key: GazetteIssueKey): boolean {
  return key.part === 'II' && key.language === 'en' && key.issueDate === '2026-06-03';
}

async function verifyRecoveredEnglishArchive(context: ArchivedLanguageContext, bytes: Uint8Array): Promise<GazetteEdition> {
  const { root, key, archivedLanguage, partnerLanguage } = context;
  const related = archivedLanguage?.['recoveredArticles'];
  if (!Array.isArray(related) || related.length !== 7 || !partnerLanguage || typeof partnerLanguage['source'] !== 'object') {
    throw new Error('Repaired issue receipt lacks seven article archives or the French partner index.');
  }
  const articles = verifiedRecoveredArticleSources(root, key, bytes, related);
  const partnerKey: GazetteIssueKey = { ...key, language: 'fr' };
  const partnerSource = partnerLanguage['source'] as Record<string, unknown>;
  const partnerBytes = readVerifiedGazetteSource(root, partnerSource, gazetteIssueUrl(partnerKey, true).href);
  if (!partnerBytes) throw new Error('French partner index is missing or fails its receipt hash.');
  const currentUrl = gazetteIssueUrl(key, true).href;
  const partnerUrl = gazetteIssueUrl(partnerKey, true).href;
  const mockSend: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const body = requestUrl === currentUrl ? bytes : articles.bytes.get(requestUrl) ?? (requestUrl === partnerUrl ? partnerBytes : undefined);
    return new Response(body, { status: body ? 200 : 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }, { preconnect: () => undefined });
  const edition = validateGazetteEdition(await fetchGazetteIssue(key, mockSend, true));
  assertRecoveredArticleMatches(edition, articles.references);
  return edition;
}

function verifiedRecoveredArticleSources(root: string, key: GazetteIssueKey, bytes: Uint8Array, related: unknown[]) {
  const originalIndex = new TextDecoder('utf-8').decode(bytes);
  const articleBytes = new Map<string, Uint8Array>();
  const references: Array<Record<string, unknown>> = [];
  for (const candidate of related) {
    const item = recoveredArticleReference(candidate, key.language);
    const number = /^SOR\/2026-(\d+)$/u.exec(String(item['registrationNumber'] ?? ''))?.[1];
    if (!number) throw new Error(`${key.language}: recovered article receipt has no exact SOR identity.`);
    const href = new RegExp(`\\bhref\\s*=\\s*(["'])([^"']*sor-dors${number}-fra\\.html)\\1`, 'iu').exec(originalIndex)?.[2];
    if (href !== item['observedHref']) throw new Error(`${key.language}: retained English index changed the recorded SOR mislink.`);
    const source = item['source'] as Record<string, unknown>;
    const original = readVerifiedGazetteSource(root, source, String(item['url']));
    if (!original) throw new Error(`${key.language}: recovered article is missing or fails its hash (${item['url']}).`);
    articleBytes.set(String(item['url']), original);
    references.push(item);
  }
  return { bytes: articleBytes, references };
}

function recoveredArticleReference(candidate: unknown, language: string): Record<string, unknown> {
  if (!candidate || typeof candidate !== 'object') throw new Error(`${language}: recovered article receipt is malformed.`);
  const item = candidate as Record<string, unknown>;
  if (typeof item['url'] !== 'string' || typeof item['observedHref'] !== 'string' || !item['source'] || typeof item['source'] !== 'object') {
    throw new Error(`${language}: recovered article receipt is missing URL, observed link or source archive.`);
  }
  return item;
}

function assertRecoveredArticleMatches(edition: GazetteEdition, refs: Array<Record<string, unknown>>): void {
  const recordById = new Map(edition.records.map((record) => [record.id, record]));
  if (refs.some((item) => !recordById.has(String(item['recordId'])) || recordById.get(String(item['recordId']))?.citationUrl !== item['url'])) {
    throw new Error('Archived recovered article identities do not match the repaired index.');
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
  sqlite.exec(readFileSync(new URL('../preview/gazette/migrations/0002_gazette_extras.sql', import.meta.url), 'utf8'));
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
