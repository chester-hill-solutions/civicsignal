/** Canonical format-1 protected pages. No filesystem, SQLite, credentials or network. */
type Scalar = string | number | null;
const tables = {
  workspace: ['id','name','slug','created_at','updated_at'],
  civic_workspace_billing: ['workspace_id','plan','fuse_limit','fuse_soft_warn','stripe_customer_id','enabled'],
  workspace_api_key: ['id','workspace_id','name','key_hash','display_prefix','capabilities','status','created_by_user_id','last_used_at','created_at','updated_at'],
  corpus_runs: ['id','corpus_id','commit_sha','commit_date','ran_at','added','changed','removed','unchanged','embedded','duration_ms','ok','error','parser_version'],
  corpus_changes: ['id','corpus_id','change','row_id','instrument','citation','section','heading','status','summary','source_url','occurred_at','recorded_at'],
  corpus_mutations: ['id','corpus_id','payload','completed_at'],
  corpus_state: ['corpus_id','commit_sha','commit_date','as_of','row_count','last_run_at','parser_version'],
  sqlite_sequence: ['name','seq'],
} as const;
type Table = keyof typeof tables;
const order = Object.keys(tables) as Table[];
const authTables = order.slice(0, 3);
const history = ['corpus_runs','corpus_changes'] as const;
const corpus = 'statutes-canada';
const maxPageBytes = 64 * 1024;
const maxRows = 16;
const digestPattern = /^[a-f0-9]{64}$/;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const canonical = (row: readonly Scalar[]) => JSON.stringify(row) + '\n';
export class ProtectedStateError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ProtectedStateError'; }
}
function assert(value: unknown, code: string): asserts value { if (!value) throw new ProtectedStateError(code); }

function rowValues(table: Table, row: Record<string, unknown>): Scalar[] {
  const values = tables[table].map(name => row[name]);
  assert(values.every(value => value === null || typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value)), 'INVALID_PROTECTED_VALUE');
  if(table!=='corpus_runs'&&table!=='corpus_changes'&&table!=='sqlite_sequence')assert(typeof values[0]==='string'&&values[0].length>0,'INVALID_PROTECTED_ID');
  if ('corpus_id' in row) assert(row['corpus_id'] === corpus, 'UNSUPPORTED_CORPUS_IDENTITY');
  if (table === 'corpus_mutations') assert(row['payload'] === null && typeof row['completed_at'] === 'string', 'PENDING_OUTBOX');
  if (table === 'workspace_api_key') {
    assert(typeof row['key_hash'] === 'string' && digestPattern.test(row['key_hash']) && ['active','revoked'].includes(String(row['status'])), 'INVALID_AUTH_ROW');
    let caps: unknown; try { caps = JSON.parse(String(row['capabilities'])); } catch { throw new ProtectedStateError('INVALID_AUTH_ROW'); }
    assert(Array.isArray(caps) && caps.every(value => typeof value === 'string'), 'INVALID_AUTH_ROW');
  }
  if (table === 'corpus_runs' || table === 'corpus_changes') assert(typeof row['id'] === 'number' && row['id'] > 0, 'INVALID_HISTORY_ID');
  if (table === 'sqlite_sequence') assert(history.includes(row['name'] as typeof history[number]) && typeof row['seq'] === 'number' && row['seq'] >= 0, 'INVALID_SEQUENCE');
  return values as Scalar[];
}

/** Validate a fixed-column row before passing its values to a binding. */
export function checkedProtectedRow(table: Table, row: unknown): Scalar[] {
  assert(Array.isArray(row) && row.length === tables[table].length, 'INVALID_PROTECTED_VALUE');
  return rowValues(table, Object.fromEntries(tables[table].map((key, index) => [key,row[index]])));
}

export interface ProtectedPage { page: number; table: Table; rows: Scalar[][]; sha256: string }
interface TableDigest { rows: number; sha256: string }
export interface ProtectedManifest {
  format: 1; sourceKind:'sqlite'|'sql';sourceSha256: string;sourceSqliteSha256:string; legacyAuthSha256: string; targetSha256: string; cutoverManifestSha256: string;
  corpusDigest: string;corpusMetadataSha256:string; corpusRows: number; revision: string; initialPublication: Scalar[][];
  pages: number; pagesSha256: string; tables: Record<Table, TableDigest>;
}
function checkedManifest(value: unknown): ProtectedManifest {
  assert(value && typeof value === 'object', 'INVALID_MANIFEST'); const m = value as ProtectedManifest;
  assert(m.format === 1 && ['sqlite','sql'].includes(m.sourceKind) && [m.sourceSha256,m.sourceSqliteSha256,m.legacyAuthSha256,m.targetSha256,m.cutoverManifestSha256,m.pagesSha256,m.corpusMetadataSha256].every(x => typeof x === 'string' && digestPattern.test(x)) &&
    /^[a-f0-9]{32}$/.test(m.corpusDigest) && Number.isSafeInteger(m.corpusRows) && m.corpusRows > 0 &&
    /^[a-f0-9]{40}:[a-z0-9][a-z0-9-]{0,63}$/.test(m.revision) && Number.isSafeInteger(m.pages) && m.pages > 0 &&
    equal(Object.keys(m.tables), order) && order.every(t => Number.isSafeInteger(m.tables[t].rows) && m.tables[t].rows >= 0 && digestPattern.test(m.tables[t].sha256)) &&
    Array.isArray(m.initialPublication) && m.initialPublication.length === 1, 'INVALID_MANIFEST');
  return m;
}
async function checkedPage(value: unknown): Promise<ProtectedPage> {
  assert(value && typeof value === 'object', 'INVALID_PAGE'); const page = value as ProtectedPage;
  assert(Number.isSafeInteger(page.page) && page.page > 0 && order.includes(page.table) && Array.isArray(page.rows) && page.rows.length > 0 && page.rows.length <= maxRows &&
    new TextEncoder().encode(JSON.stringify(page)).byteLength <= maxPageBytes && page.rows.every(row => Array.isArray(row) && row.length === tables[page.table].length), 'INVALID_PAGE');
  for (const row of page.rows) checkedProtectedRow(page.table, row);
  assert(page.sha256 === await protectedPageDigest(page), 'PAGE_HASH_MISMATCH');
  return page;
}
/** Keep this exact property order: sealed format-1 pages hash these bytes. */
export function protectedPageCanonical(page: Pick<ProtectedPage,'page'|'table'|'rows'>): string {
  return JSON.stringify({page:page.page,table:page.table,rows:page.rows});
}
export async function protectedPageDigest(page: Pick<ProtectedPage,'page'|'table'|'rows'>): Promise<string> {
  const bytes=new TextEncoder().encode(protectedPageCanonical(page));
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export {
  tables as PROTECTED_TABLE_COLUMNS, order as PROTECTED_TABLE_ORDER,
  authTables as PROTECTED_AUTH_TABLES, history as PROTECTED_HISTORY_TABLES,
  corpus as PROTECTED_CORPUS_ID, maxPageBytes as MAX_PROTECTED_PAGE_BYTES,
  maxRows as MAX_PROTECTED_PAGE_ROWS, digestPattern as PROTECTED_DIGEST_PATTERN,
  rowValues as protectedRowValues, canonical as protectedRowCanonical,
  checkedManifest as checkedProtectedManifest, checkedPage as checkedProtectedPage,
};
export type {Scalar as ProtectedScalar, Table as ProtectedTable, TableDigest as ProtectedTableDigest};
