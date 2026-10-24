import { textSha256 } from '../../src/corpora/text-store';

export interface StagingRestoreTarget {
  format: 1; stageOnly: true; stageId: string; accountId: string; d1Id: string; r2Bucket: string; adminUrl: string;
}

export interface RestorePlan {
  format: 1; bundleManifestSha256: string; pagesSha256: string; pagesChainSha256: string; schemaSha256: string;
  revision: string; rowCount: number; objectCount: number; textBytes: number; objectBytes: number; pageCount: number;
  publication: { commit: string; parser: string | null; date: string; asOf: string; lastRunAt: string; rows: number };
  sourceReceiptSha256?: string;
}

export class RestoreInputError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 = 400) { super(message); }
}

export const digestPattern = /^[a-f0-9]{64}$/;
export function checkedTarget(value: unknown): StagingRestoreTarget {
  const t = value as StagingRestoreTarget;
  if (!t || t.format !== 1 || t.stageOnly !== true || !/^stage-[a-z0-9][a-z0-9-]{0,55}$/.test(t.stageId) ||
      !/^[a-f0-9]{32}$/.test(t.accountId) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(t.d1Id) ||
      t.d1Id === '8056b1a0-f858-4f89-a332-91f7f350eb7b' || t.r2Bucket === 'civicsignal-corpus' ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(t.r2Bucket) || !t.r2Bucket.includes('stage') || typeof t.adminUrl !== 'string') throw new RestoreInputError('Explicit isolated staging resource identities are required.');
  let url: URL;
  try { url = new URL(t.adminUrl); } catch { throw new RestoreInputError('Invalid staging admin URL.'); }
  const loopback = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if ((!loopback && (url.protocol !== 'https:' || !/^civicsignal-v1-stage-restore-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname))) ||
      loopback && !['http:','https:'].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new RestoreInputError('Use a staging HTTPS origin or explicit local test origin.');
  return { format: 1, stageOnly: true, stageId: t.stageId, accountId: t.accountId, d1Id: t.d1Id, r2Bucket: t.r2Bucket, adminUrl: url.origin };
}

function date(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
}

export function checkedRestorePlan(value: unknown): RestorePlan {
  const p = value as RestorePlan;
  const positive = (n: unknown, cap = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && Number(n) > 0 && Number(n) <= cap;
  if (!p || p.format !== 1 || ![p.bundleManifestSha256,p.pagesSha256,p.pagesChainSha256,p.schemaSha256].every((s) => typeof s === 'string' && digestPattern.test(s)) ||
      !/^[a-f0-9]{40}:[a-z0-9][a-z0-9-]{0,63}$/.test(p.revision) || !positive(p.rowCount,1_000_000) ||
      !positive(p.objectCount,p.rowCount) || !positive(p.textBytes) || !positive(p.objectBytes,p.textBytes) || !positive(p.pageCount,p.rowCount) ||
      !p.publication || !date(p.publication.date) || !date(p.publication.asOf) || !Number.isFinite(Date.parse(p.publication.lastRunAt)) ||
      p.publication.commit !== p.revision.split(':')[0] || p.publication.rows !== p.rowCount ||
      (p.publication.parser ?? 'legacy') !== p.revision.split(':')[1] ||
      p.revision.endsWith(':legacy') && (p.publication.parser !== null || !p.sourceReceiptSha256 || !digestPattern.test(p.sourceReceiptSha256)) ||
      p.sourceReceiptSha256 !== undefined && !digestPattern.test(p.sourceReceiptSha256)) throw new RestoreInputError('Invalid checked restore plan or source publication.');
  return { format: 1, bundleManifestSha256: p.bundleManifestSha256, pagesSha256: p.pagesSha256, pagesChainSha256: p.pagesChainSha256,
    schemaSha256: p.schemaSha256, revision: p.revision, rowCount: p.rowCount, objectCount: p.objectCount, textBytes: p.textBytes,
    objectBytes: p.objectBytes, pageCount: p.pageCount, publication: { commit: p.publication.commit, parser: p.publication.parser,
      date: p.publication.date, asOf: p.publication.asOf, lastRunAt: p.publication.lastRunAt, rows: p.publication.rows },
    ...(p.sourceReceiptSha256 ? { sourceReceiptSha256: p.sourceReceiptSha256 } : {}) };
}

export function hashJson(value: unknown) { return textSha256(new Uint8Array(new TextEncoder().encode(JSON.stringify(value)))); }
export function nextPageChain(chain: string, pageHash: string) { return textSha256(new Uint8Array(new TextEncoder().encode(chain + pageHash))); }

/** Source-derived baseline only: no fake auth, workspace, change events or runs. */
export const RESTORE_SUPPORT_SCHEMA = `
CREATE TABLE corpus_state(corpus_id TEXT PRIMARY KEY,commit_sha TEXT NOT NULL,commit_date TEXT NOT NULL,as_of TEXT NOT NULL,row_count INTEGER NOT NULL DEFAULT 0,last_run_at TEXT NOT NULL,parser_version TEXT);
CREATE TABLE corpus_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,corpus_id TEXT NOT NULL,commit_sha TEXT NOT NULL,commit_date TEXT NOT NULL,ran_at TEXT NOT NULL,added INTEGER NOT NULL DEFAULT 0,changed INTEGER NOT NULL DEFAULT 0,removed INTEGER NOT NULL DEFAULT 0,unchanged INTEGER NOT NULL DEFAULT 0,embedded INTEGER NOT NULL DEFAULT 0,duration_ms INTEGER NOT NULL DEFAULT 0,ok INTEGER NOT NULL DEFAULT 1,error TEXT,parser_version TEXT);
CREATE INDEX idx_corpus_runs_corpus ON corpus_runs(corpus_id);
CREATE TABLE corpus_changes(id INTEGER PRIMARY KEY AUTOINCREMENT,corpus_id TEXT NOT NULL,change TEXT NOT NULL CHECK(change IN ('added','changed','removed')),row_id TEXT NOT NULL,instrument TEXT NOT NULL,citation TEXT NOT NULL,section TEXT NOT NULL,heading TEXT,status TEXT,summary TEXT,source_url TEXT,occurred_at TEXT NOT NULL,recorded_at TEXT NOT NULL);
CREATE INDEX idx_corpus_changes_corpus ON corpus_changes(corpus_id);
CREATE INDEX idx_corpus_changes_row ON corpus_changes(row_id);
CREATE TABLE corpus_mutations(id TEXT PRIMARY KEY,corpus_id TEXT NOT NULL,payload TEXT,completed_at TEXT);
CREATE INDEX idx_corpus_mutations_pending ON corpus_mutations(corpus_id,id) WHERE payload IS NOT NULL;
CREATE TABLE stage_restore_session(id INTEGER PRIMARY KEY CHECK(id=1),plan_sha256 TEXT NOT NULL,plan_json TEXT NOT NULL,stage_id TEXT NOT NULL,account_id TEXT NOT NULL,d1_id TEXT NOT NULL,r2_name TEXT NOT NULL,phase TEXT NOT NULL,page_check_after INTEGER NOT NULL DEFAULT 0,page_check_chain TEXT NOT NULL,audit_checkpoint TEXT);
CREATE TABLE stage_restore_objects(ordinal INTEGER PRIMARY KEY,object_key TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes>0),cumulative_bytes INTEGER NOT NULL);
`;
